/**
 * LeasesAndLessors.js — merged from the Leases half of
 * leasesAndProvisions.js and the entirety of lessor.js. Covers both
 * sides of a leasing relationship:
 *
 *   AS LESSEE (IFRS 16) — the business takes a lease IN (shop premises,
 *     vehicles). Recognises a Right-of-Use asset and a Lease Liability
 *     at commencement; reduces the liability with each payment; amortises
 *     the ROU asset via the existing postDepreciationRun mechanism.
 *
 *   AS LESSOR — the business rents things OUT to customers. Two distinct
 *     paths, genuinely different in how the item is held:
 *       A. leaseOutInventory / returnLeasedInventory — a specific Goods
 *          unit temporarily checked out (status LEASED_OUT, never sold).
 *       B. hireOutEquipment / endEquipmentHire — an owned Asset cycling
 *          through multiple short-term renters over its working life.
 *
 * Catalogue migration status per function:
 *
 *   postLeaseCommencement    — migrated onto runCatalogueEvent: fixed
 *                              Catalogue codes (1600/2200), one Journal
 *                              pair, two side-effects (Assets row, Liability
 *                              row) — same shape as postAssetPurchase.
 *   postLeasePayment         — migrated onto runCatalogueEvent: variable
 *                              payment credit side, fixed debit (2200),
 *                              FIFO Liability reduction — same proven
 *                              pattern as postLoanRepayment.
 *   leaseOutInventory        — migrated onto runCatalogueEvent: variable
 *                              payment debit side, fixed credit (4700),
 *                              plus Resources status update side-effect.
 *   returnLeasedInventory    — no Journal posting at all (the income was
 *                              already recognised on checkout) — only
 *                              a Resources status update. Nothing to
 *                              migrate.
 *   hireOutEquipment         — migrated onto runCatalogueEvent: same
 *                              shape as leaseOutInventory, for Assets
 *                              rather than Resources.
 *   endEquipmentHire         — no Journal posting at all — only clears
 *                              the Current_Renter_Stakeholder_id on the
 *                              Asset row. Nothing to migrate.
 */

const {
  prisma,
  PostingError,
  resolvePaymentAccount,
  buildCycleReference,
  openTransactionCycle,
  postJournalPair,
  round2,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
  findOrCreateExpensePlaceholder,
  writeNarrative,
} = require("./core");
const { runCatalogueEvent } = require("./interpreter");

// ─── SECTION 1: AS LESSEE (IFRS 16) ─────────────────────────────────────────

/**
 * postLeaseCommencement — IFRS 16: recognises a Right-of-Use asset and
 * a matching Lease Liability at the start of a lease. Uses total
 * undiscounted contracted payments (a documented simplification — the
 * full IFRS 16 model discounts to present value using the lessee's
 * incremental borrowing rate, which this system does not yet hold as a
 * parameter). DR Right-of-Use Asset (1600) CR Lease Liability (2200).
 */
async function postLeaseCommencement(input) {
  const { description, totalLeasePayments, leaseTermYears, administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!description || !description.trim()) throw new PostingError("Lease description is required");
  if (!totalLeasePayments || totalLeasePayments <= 0) throw new PostingError("Total lease payments must be positive");
  if (!leaseTermYears || leaseTermYears <= 0) throw new PostingError("Lease term (years) must be positive");

  return prisma.$transaction(async (tx) => {
    await mustFindOrCreateCatalogue(tx, {
      eventName: "LEASE_COMMENCEMENT",
      description: "Recognise a Right-of-Use asset and Lease Liability at lease start. DR Right-of-Use Asset (1600) CR Lease Liability (2200). Non-cash at commencement. IFRS 16.",
      debitCode: "1600",
      creditCode: "2200",
      cashFlowCategory: "NONE",
      riskLevel: "MEDIUM",
      cycleType: "ASSET",
      alertRequired: 1,
      narrativeTemplate: "Lease commenced: {Product_Name}. Right-of-Use asset and Lease Liability of KES {Amount} recognised over {Years} years.",
      reportSections: "BALANCE_SHEET:RightOfUseAsset|BALANCE_SHEET:LeaseLiability",
      businessUnit,
      entrepriseId,
    });

    const rouAccount = await mustFindOrCreateAccount(tx, "1600", "Right-of-Use Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
    const leaseLiabilityAccount = await mustFindOrCreateAccount(tx, "2200", "Lease Liability", "LIABILITY", "CREDIT", "NON_CURRENT_LIABILITY", entrepriseId);

    // A Product row anchors the ROU asset the same way a purchased asset
    // does — so postDepreciationRun can find it by Product_Name
    const product = await tx.Product.create({
      data: {
        Product_Name: `ROU: ${description.trim()}`,
        Product_type: "Asset",
        Product_Price: 0,
        Product_Cost: totalLeasePayments,
        Is_Asset: 1,
        Entreprise_id: entrepriseId,
      },
    });

    const result = await runCatalogueEvent(tx, {
      eventName: "LEASE_COMMENCEMENT",
      amount: round2(totalLeasePayments),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      narrativeValues: { Product_Name: description.trim(), Years: leaseTermYears },
      entrepriseId,
    });

    // The ROU asset lives in the Assets register so postDepreciationRun
    // can amortise it exactly like an owned asset
    const rouAsset = await tx.Assets.create({
      data: {
        Catalogue_id: (await tx.Catalogue.findFirst({ where: { Event_Name: "LEASE_COMMENCEMENT", Entreprise_id: entrepriseId } })).Catalogue_id,
        Account_id: rouAccount.Account_id,
        Records_id: result.recordsId,
        Assets_Type: `ROU: ${description.trim()}`,
        Asset_Classification: "NON_CURRENT",
        Cost_Amount: round2(totalLeasePayments),
        Residual_Value: 0,
        Useful_Life_Years: leaseTermYears,
        Depreciation_Method: "STRAIGHT_LINE",
        Accumulated_Depreciation: 0,
        Accumulated_Impairment: 0,
        Carrying_Amount: round2(totalLeasePayments),
        Acquisition_Date: new Date(),
        Placed_In_Service_Date: new Date(),
        Net_Amount: round2(totalLeasePayments),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    const liability = await tx.Liability.create({
      data: {
        Catalogue_id: (await tx.Catalogue.findFirst({ where: { Event_Name: "LEASE_COMMENCEMENT", Entreprise_id: entrepriseId } })).Catalogue_id,
        Account_id: leaseLiabilityAccount.Account_id,
        Records_id: result.recordsId,
        Liability_Type: "Lease",
        Liability_Classification: "NON_CURRENT",
        Net_Amount: round2(totalLeasePayments),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { transaction: result.transaction, journal: result.journal, rouAsset, liability, narrative: result.narrative };
  });
}

/**
 * postLeasePayment — IFRS 16: a lease payment reduces the Lease
 * Liability (the financing obligation). DR Lease Liability (2200)
 * CR Cash/Mobile/Bank. The ROU asset amortises separately via
 * postDepreciationRun — a lease payment does not itself reduce it.
 */
async function postLeasePayment(input) {
  const { liabilityId, amount, paymentMethod = "CASH", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!liabilityId) throw new PostingError("liabilityId is required");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK"');

  return prisma.$transaction(async (tx) => {
    const liability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!liability || liability.Liability_Type !== "Lease" || liability.Entreprise_id !== entrepriseId) {
      throw new PostingError("Lease liability not found");
    }
    const outstanding = Number(liability.Net_Amount || 0);
    if (amount > outstanding) throw new PostingError(`Payment (${amount}) exceeds the remaining lease liability (${outstanding}).`);

    await mustFindOrCreateCatalogue(tx, {
      eventName: "LEASE_PAYMENT",
      description: "A lease payment. DR Lease Liability (2200) CR Cash/Mobile/Bank. Reduces the financing obligation, not an expense in itself. IFRS 16.",
      debitCode: "2200",
      creditCode: "1000",
      cashFlowCategory: "FINANCING",
      riskLevel: "LOW",
      cycleType: "ASSET",
      alertRequired: 0,
      narrativeTemplate: "Lease payment of KES {Amount} made, reducing the lease liability.",
      reportSections: "CASH_FLOW:Financing|BALANCE_SHEET:LeaseLiability",
      businessUnit: "SHOP",
      entrepriseId,
    });

    const product = await findOrCreateExpensePlaceholder(tx, "Lease Payment", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "LEASE_PAYMENT",
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit: "SHOP",
      administrationId,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: {},
      entrepriseId,
    });

    await tx.Liability.update({
      where: { Liability_id: liability.Liability_id },
      data: { Net_Amount: round2(outstanding - amount) },
    });

    return { transaction: result.transaction, journal: result.journal, newOutstanding: round2(outstanding - amount) };
  });
}

// ─── SECTION 2: AS LESSOR ────────────────────────────────────────────────────

/**
 * leaseOutInventory — Path A. Checks out a specific inventory unit to
 * a customer for a period, recognising rental income as collected. The
 * unit stays owned — status changes to LEASED_OUT, not SOLD — and
 * returns to AVAILABLE on return. DR Cash/Mobile/Bank CR Rental Income.
 */
async function leaseOutInventory(input) {
  const { resourcesId, stakeholderId, amount, paymentMethod = "CASH", notes = "", businessUnit = "SHOP", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!resourcesId) throw new PostingError("resourcesId is required");
  if (!stakeholderId) throw new PostingError("stakeholderId is required — who this unit is leased to");
  if (!amount || amount <= 0) throw new PostingError("A positive rental amount is required");

  return prisma.$transaction(async (tx) => {
    const resource = await tx.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
    if (!resource) throw new PostingError("Inventory unit not found");
    if (resource.Resources_Status !== "AVAILABLE") {
      throw new PostingError(`This unit is currently ${resource.Resources_Status} — only available stock can be leased out.`);
    }

    const stakeholder = await tx.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
    if (!stakeholder || stakeholder.Entreprise_id !== entrepriseId) throw new PostingError("Stakeholder not found for this business");

    const product = await tx.Product.findUnique({ where: { Product_id: resource.Product_id } });

    await mustFindOrCreateCatalogue(tx, {
      eventName: "LEASE_OUT_INVENTORY",
      description: "A specific inventory unit is leased out instead of sold — unit stays owned, unavailable until returned. DR Cash/Mobile/Bank CR Rental Income (4700).",
      debitCode: "1000",
      creditCode: "4700",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "RENT",
      alertRequired: 0,
      narrativeTemplate: "{Product_Name} leased out for KES {Amount}.",
      reportSections: "INCOME_STATEMENT:Rental Income",
      businessUnit,
      entrepriseId,
    });

    await mustFindOrCreateAccount(tx, "4700", "Rental Income — Equipment/Inventory Hire", "INCOME", "CREDIT", "OPERATING_REVENUE", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "LEASE_OUT_INVENTORY",
      amount: round2(amount),
      productId: resource.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "receive",
      paymentSide: "debit",
      narrativeValues: { Product_Name: product ? product.Product_Name : "unit" },
      entrepriseId,
    });

    await tx.Resources.update({
      where: { Resources_id: resource.Resources_id },
      data: { Resources_Status: "LEASED_OUT", Last_updated: new Date() },
    });

    await tx.Narrative.create({
      data: {
        Transaction_id: result.transaction.Transactions_id,
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `${product ? product.Product_Name : "Unit"} leased out to ${stakeholder.First_name || ""} ${stakeholder.Last_name || ""}${notes ? " — " + notes : ""}. Stays owned, unavailable until returned.`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { journal: result.journal, resourcesId: resource.Resources_id };
  });
}

/**
 * returnLeasedInventory — the leased unit comes back. No Journal posting
 * — the rental income was already recognised on checkout. Only restores
 * the unit to AVAILABLE stock, recording the return condition.
 */
async function returnLeasedInventory(input) {
  const { resourcesId, condition = "GOOD", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");

  const resource = await prisma.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
  if (!resource) throw new PostingError("Inventory unit not found");
  if (resource.Resources_Status !== "LEASED_OUT") throw new PostingError("This unit isn't currently leased out.");

  const updated = await prisma.Resources.update({
    where: { Resources_id: resource.Resources_id },
    data: { Resources_Status: "AVAILABLE", Resources_Quality: condition, Last_updated: new Date() },
  });

  await prisma.Narrative.create({
    data: {
      Narrative_type: "NOTE",
      Narrative_source: "HUMAN",
      Narrative_audience: "OWNER",
      Is_Generated: 0,
      Description: `Leased unit returned, condition: ${condition}.`,
      Language: "en",
      Author: administrationId,
      Narrative_date: new Date(),
      Entreprise_id: entrepriseId,
    },
  });

  return updated;
}

/**
 * hireOutEquipment — Path B. Attaches a current renter to an owned
 * Asset marked Equipment_For_Hire, recognising hire income as
 * collected. The asset keeps depreciating on its normal schedule
 * regardless of who's currently hiring it. DR Cash/Mobile/Bank
 * CR Rental Income (4700).
 */
async function hireOutEquipment(input) {
  const { assetsId, stakeholderId, amount, paymentMethod = "CASH", businessUnit = "SHOP", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!assetsId) throw new PostingError("assetsId is required");
  if (!stakeholderId) throw new PostingError("stakeholderId is required — who this equipment is hired to");
  if (!amount || amount <= 0) throw new PostingError("A positive hire amount is required");

  return prisma.$transaction(async (tx) => {
    const asset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetsId) } });
    if (!asset) throw new PostingError("Equipment not found");
    if (!asset.Equipment_For_Hire) throw new PostingError("This asset isn't marked as available for hire");
    if (asset.Current_Renter_Stakeholder_id) throw new PostingError("This equipment is already out on hire — end the current hire first.");

    const stakeholder = await tx.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
    if (!stakeholder || stakeholder.Entreprise_id !== entrepriseId) throw new PostingError("Stakeholder not found for this business");

    await mustFindOrCreateCatalogue(tx, {
      eventName: "EQUIPMENT_HIRE",
      description: "Owned equipment is hired out to a customer for a period — the equipment stays owned and keeps depreciating on its normal schedule. DR Cash/Mobile/Bank CR Rental Income (4700).",
      debitCode: "1000",
      creditCode: "4700",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "RENT",
      alertRequired: 0,
      narrativeTemplate: "{Assets_Type} hired out for KES {Amount}.",
      reportSections: "INCOME_STATEMENT:Rental Income",
      businessUnit,
      entrepriseId,
    });

    await mustFindOrCreateAccount(tx, "4700", "Rental Income — Equipment/Inventory Hire", "INCOME", "CREDIT", "OPERATING_REVENUE", entrepriseId);

    const placeholder = await findOrCreateExpensePlaceholder(tx, asset.Assets_Type || "Equipment Hire", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "EQUIPMENT_HIRE",
      amount: round2(amount),
      productId: placeholder.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "receive",
      paymentSide: "debit",
      narrativeValues: { Assets_Type: asset.Assets_Type },
      entrepriseId,
    });

    await tx.Assets.update({
      where: { Assets_id: asset.Assets_id },
      data: { Current_Renter_Stakeholder_id: stakeholder.Stakeholder_id },
    });

    return { journal: result.journal, assetsId: asset.Assets_id };
  });
}

/**
 * endEquipmentHire — the equipment returns from its current renter.
 * No Journal posting — the hire income was recognised on checkout.
 * Only clears the renter so the equipment is available for the next hire.
 */
async function endEquipmentHire(input) {
  const { assetsId, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!assetsId) throw new PostingError("assetsId is required");

  const asset = await prisma.Assets.findUnique({ where: { Assets_id: Number(assetsId) } });
  if (!asset) throw new PostingError("Equipment not found");
  if (!asset.Current_Renter_Stakeholder_id) throw new PostingError("This equipment isn't currently out on hire.");

  return prisma.Assets.update({
    where: { Assets_id: asset.Assets_id },
    data: { Current_Renter_Stakeholder_id: null },
  });
}

/**
 * postLeaseTermination — terminates a lease by simultaneously
 * derecognising both the Right-of-Use asset and the Lease Liability.
 * This is the IFRS 16 derecognition event that was missing from the
 * lease cycle — a lease could start and be paid down but could never
 * formally end with correct accounting.
 *
 * The genuine IFRS 16 complexity addressed here: the ROU asset and
 * the Lease Liability do not necessarily zero out at the same time.
 * Under straight-line depreciation the ROU asset reduces evenly over
 * the lease term, but the Lease Liability was reduced by actual
 * payments made — if payments were irregular or if the lease is
 * terminated early, the two balances will differ. The difference is
 * recognised as a gain or loss on termination.
 *
 * Gain (liability remaining > ROU carrying amount):
 *   The business owes less than the asset is still "worth" on its books
 *   — the liability was paid down faster than the asset depreciated.
 *   DR Lease Liability (2200) for full remaining balance
 *   DR Accumulated Depreciation (1410) for accumulated depreciation
 *   CR Right-of-Use Assets (1600) for original cost
 *   CR Gain on Lease Termination (4520) for the difference
 *
 * Loss (ROU carrying amount > liability remaining):
 *   The asset is still on the books for more than is owed on the lease
 *   — it depreciated more slowly than the liability was paid down.
 *   DR Lease Liability (2200) for full remaining balance
 *   DR Accumulated Depreciation (1410) for accumulated depreciation
 *   DR Loss on Lease Termination (5920) for the difference
 *   CR Right-of-Use Assets (1600) for original cost
 *
 * earlyExit = true: the lease is being terminated before its natural
 * end — a break clause is exercised or a lease is surrendered. Any
 * penalty payment is recorded separately via postExpense.
 */
async function postLeaseTermination(input) {
  const { assetsId, liabilityId, earlyExit = false, notes = "", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!assetsId) throw new PostingError("assetsId is required — the ROU asset being derecognised.");
  if (!liabilityId) throw new PostingError("liabilityId is required — the Lease Liability being settled.");

  return prisma.$transaction(async (tx) => {
    const rouAsset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetsId) } });
    if (!rouAsset || rouAsset.Entreprise_id !== entrepriseId) throw new PostingError("ROU asset not found for this business.");
    if (!rouAsset.Assets_Type?.startsWith("ROU:")) throw new PostingError("This asset isn't a Right-of-Use asset — its name must start with 'ROU:'.");
    if (rouAsset.Period_end) throw new PostingError("This ROU asset has already been derecognised.");

    const leaseLiability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!leaseLiability || leaseLiability.Liability_Type !== "Lease" || leaseLiability.Entreprise_id !== entrepriseId) {
      throw new PostingError("Lease Liability not found for this business.");
    }

    const costAmount = round2(Number(rouAsset.Cost_Amount || 0));
    const accumulatedDepreciation = round2(Number(rouAsset.Accumulated_Depreciation || 0));
    const rouCarryingAmount = round2(Number(rouAsset.Carrying_Amount != null ? rouAsset.Carrying_Amount : costAmount - accumulatedDepreciation));
    const liabilityRemaining = round2(Number(leaseLiability.Net_Amount || 0));

    // Gain: liability was paid down below the ROU carrying amount
    // Loss: ROU carrying amount exceeds what remains on the liability
    const gainLoss = round2(liabilityRemaining - rouCarryingAmount);
    const isGain = gainLoss > 0;
    const isLoss = gainLoss < 0;

    const eventName = earlyExit ? "LEASE_EARLY_TERMINATION" : "LEASE_TERMINATION";

    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: earlyExit
            ? "Early termination of a lease — break clause exercised or lease surrendered before natural end. Derecognises ROU asset and Lease Liability simultaneously. Any termination penalty posted separately via postExpense. IFRS 16."
            : "Natural end of a lease term. Derecognises the Right-of-Use asset and the Lease Liability simultaneously. Any difference between the two balances is a gain or loss on termination. IFRS 16.",
          Debit_Account_code: "2200",
          Credit_Account_code: "1600",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE",
          Operational_Impact: "NONE",
          Risk_Level: earlyExit ? "MEDIUM" : "LOW",
          Documentation_type: "NONE",
          Report_trigger: "ASSET_REGISTER",
          Escalation_Role: earlyExit ? "ACCOUNTANT" : "NONE",
          Cycle_type: "ASSET",
          Alert_Required: earlyExit ? 1 : 0,
          Narrative_template: earlyExit
            ? "{Asset_Name} lease terminated early. {GainLossLabel}: KES {GainLossAmount}. {Notes}"
            : "{Asset_Name} lease ended at natural term. {GainLossLabel}: KES {GainLossAmount}.",
          Evidence_template: "NONE",
          Report_sections: "BALANCE_SHEET:RightOfUseAsset|BALANCE_SHEET:LeaseLiability|INCOME_STATEMENT:GainLossOnLeaseTermination",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    const rouAccount = await mustFindOrCreateAccount(tx, "1600", "Right-of-Use Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
    const accumDeprAccount = await mustFindOrCreateAccount(tx, "1410", "Accumulated Depreciation", "ASSET", "CREDIT", "NON_CURRENT_ASSET", entrepriseId);
    const leaseLiabilityAccount = await mustFindOrCreateAccount(tx, "2200", "Lease Liability", "LIABILITY", "CREDIT", "NON_CURRENT_LIABILITY", entrepriseId);

    let gainLossAccount = null;
    if (gainLoss !== 0) {
      if (isGain) {
        gainLossAccount = await mustFindOrCreateAccount(tx, "4520", "Gain on Lease Termination", "INCOME", "CREDIT", "OTHER_INCOME", entrepriseId);
      } else {
        gainLossAccount = await mustFindOrCreateAccount(tx, "5920", "Loss on Lease Termination", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
      }
    }

    const product = await tx.Product.findFirst({ where: { Product_Name: rouAsset.Assets_Type, Entreprise_id: entrepriseId } })
      || await findOrCreateExpensePlaceholder(tx, rouAsset.Assets_Type || "Lease Termination", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: "SHOP",
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(costAmount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: rouAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(costAmount),
      businessEvent: "ADJUSTMENT",
      cycleType: "ASSET",
      businessUnit: "SHOP",
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("lease-termination"),
      entrepriseId,
    });

    const journal = [];
    const commonLeg = { catalogueId: catalogue.Catalogue_id, transactionId: transaction.Transactions_id, productId: product.Product_id, periodId: openPeriod.Structures_id, administrationId, entrepriseId };

    // Leg 1: DR Lease Liability — clear what remains of the financial obligation
    if (liabilityRemaining > 0) {
      journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: leaseLiabilityAccount, creditAccount: null, amount: liabilityRemaining, description: `${eventName}: clear remaining lease liability` })));
    }

    // Leg 2: DR Accumulated Depreciation — remove the contra-asset balance
    if (accumulatedDepreciation > 0) {
      journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: accumDeprAccount, creditAccount: null, amount: accumulatedDepreciation, description: `${eventName}: clear accumulated depreciation on ROU asset` })));
    }

    // Leg 3: CR ROU asset at original cost — remove the asset entirely
    journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: null, creditAccount: rouAccount, amount: costAmount, description: `${eventName}: derecognise ROU asset at cost` })));

    // Leg 4: gain or loss — the difference between what was owed and what
    // was still on the books — the real accounting substance of this function
    if (gainLoss !== 0 && gainLossAccount) {
      journal.push(...(await postJournalPair(tx, {
        ...commonLeg,
        debitAccount: isLoss ? gainLossAccount : null,
        creditAccount: isGain ? gainLossAccount : null,
        amount: Math.abs(gainLoss),
        description: `${eventName}: ${isGain ? "gain" : "loss"} on termination`,
      })));
    }

    const totalDebit = round2(journal.reduce((s, j) => s + Number(j.Debit || 0), 0));
    const totalCredit = round2(journal.reduce((s, j) => s + Number(j.Credit || 0), 0));
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new PostingError(`Lease termination entry did not balance (DR ${totalDebit} CR ${totalCredit}) — not posted.`);
    }

    await tx.Assets.update({ where: { Assets_id: rouAsset.Assets_id }, data: { Carrying_Amount: 0, Period_end: new Date() } });
    await tx.Liability.update({ where: { Liability_id: leaseLiability.Liability_id }, data: { Net_Amount: 0, Closure_Status: "CLOSED", Closure_Date: new Date() } });

    await tx.Narrative.create({
      data: {
        Transaction_id: transaction.Transactions_id,
        Narrative_type: earlyExit ? "CORRECTION" : "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "ACCOUNTANT",
        Is_Generated: 0,
        Description: `${earlyExit ? "Early lease termination" : "Lease ended"} — ${rouAsset.Assets_Type}. ROU asset (KES ${costAmount.toFixed(2)} cost, KES ${rouCarryingAmount.toFixed(2)} carrying) and Lease Liability (KES ${liabilityRemaining.toFixed(2)} remaining) derecognised. ${gainLoss > 0 ? `Gain: KES ${gainLoss.toFixed(2)}` : gainLoss < 0 ? `Loss: KES ${Math.abs(gainLoss).toFixed(2)}` : "No gain or loss"}. ${notes}`.trim(),
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { transaction, journal, gainLoss, rouCarryingAmount, liabilityRemaining, earlyExit };
  });
}

/**
 * postLeaseTermination — ends a lease and derecognises both the
 * Right-of-Use asset and the Lease Liability in a single, balanced
 * transaction. This closes the Tier 2 gap: previously a lease could
 * start (postLeaseCommencement), be paid down (postLeasePayment), and
 * have its ROU asset depreciated (postDepreciationRun), but there was
 * no route to formally end it.
 *
 * The real accounting logic (IFRS 16.46) at termination:
 *
 *   DR Accumulated Depreciation (1410)      the full amount accumulated
 *   DR Lease Liability (2200)               the remaining balance
 *   CR Right-of-Use Assets (1600)           the full original cost
 *   DR or CR Early Exit Gain/Loss (4501/5960) the residual, if any
 *
 * The early-exit variance arises because straight-line depreciation on
 * the ROU asset and the actual payment schedule on the Lease Liability
 * are independent — a lease paid off faster than the asset is depreciated
 * leaves a liability balance lower than the carrying amount, producing a
 * loss; one paid slower leaves a liability higher than the carrying
 * amount, producing a gain. At natural expiry of a correctly structured
 * lease both should reach zero simultaneously — but early terminations
 * and simplified discount assumptions (this system uses undiscounted
 * contracted payments) make a residual variance likely.
 */
async function postLeaseTermination(input) {
  const { assetId, liabilityId, earlyExit = false, notes = "", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!assetId) throw new PostingError("assetId is required — the ROU Assets row being terminated.");
  if (!liabilityId) throw new PostingError("liabilityId is required — the Lease Liability row being terminated.");

  return prisma.$transaction(async (tx) => {
    const rouAsset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetId) } });
    if (!rouAsset || rouAsset.Entreprise_id !== entrepriseId) throw new PostingError("ROU Asset not found for this business.");
    if (rouAsset.Period_end) throw new PostingError("This ROU asset is already disposed — cannot terminate a lease twice.");
    if (!rouAsset.Assets_Type || !rouAsset.Assets_Type.startsWith("ROU:")) {
      throw new PostingError("This asset isn't marked as a Right-of-Use asset — use the Asset Disposal route for owned assets.");
    }

    const leaseLiability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!leaseLiability || leaseLiability.Liability_Type !== "Lease" || leaseLiability.Entreprise_id !== entrepriseId) {
      throw new PostingError("Lease Liability not found for this business.");
    }
    if (leaseLiability.Closure_Status === "CLOSED") throw new PostingError("This lease liability is already closed.");

    const costAmount = round2(Number(rouAsset.Cost_Amount || 0));
    const accumulatedDepreciation = round2(Number(rouAsset.Accumulated_Depreciation || 0));
    const carryingAmount = round2(costAmount - accumulatedDepreciation - Number(rouAsset.Accumulated_Impairment || 0));
    const liabilityRemaining = round2(Number(leaseLiability.Net_Amount || 0));

    // The variance between the remaining liability and the ROU carrying
    // amount is the early-exit gain or loss. At natural expiry both
    // should be zero. A positive variance (liability > carrying) is a
    // gain — the business is relieved of more obligation than the asset
    // was worth. A negative variance (liability < carrying) is a loss —
    // the asset had more value left than the remaining obligation.
    const variance = round2(liabilityRemaining - carryingAmount);
    const isGain = variance > 0;
    const isLoss = variance < 0;

    // Seed the termination Catalogue event
    const eventName = "LEASE_TERMINATION";
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: "Terminate a lease — derecognise the ROU asset and Lease Liability simultaneously. DR Accumulated Depreciation, DR Lease Liability CR ROU Asset at cost. Any variance is a gain (DR Liability > carrying) or loss (CR Liability < carrying). IFRS 16.",
          Debit_Account_code: "2200",
          Credit_Account_code: "1600",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE",
          Operational_Impact: "NONE",
          Risk_Level: "MEDIUM",
          Documentation_type: "NONE",
          Report_trigger: "ASSET_REGISTER",
          Escalation_Role: "OWNER",
          Cycle_type: "ASSET",
          Alert_Required: 1,
          Narrative_template: "Lease terminated: {Product_Name}. {EarlyExit}",
          Evidence_template: "NONE",
          Report_sections: "BALANCE_SHEET:RightOfUseAsset|BALANCE_SHEET:LeaseLiability",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const rouAccount = await mustFindOrCreateAccount(tx, "1600", "Right-of-Use Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
    const accumDeprAccount = await mustFindOrCreateAccount(tx, "1410", "Accumulated Depreciation", "ASSET", "CREDIT", "NON_CURRENT_ASSET", entrepriseId);
    const leaseLiabilityAccount = await mustFindOrCreateAccount(tx, "2200", "Lease Liability", "LIABILITY", "CREDIT", "NON_CURRENT_LIABILITY", entrepriseId);

    const product = await tx.Product.findFirst({ where: { Product_Name: rouAsset.Assets_Type, Entreprise_id: entrepriseId } });
    const placeholderProduct = product || await findOrCreateExpensePlaceholder(tx, rouAsset.Assets_Type || "Lease Termination", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: "SHOP",
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(costAmount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: rouAccount.Account_id,
      productId: placeholderProduct.Product_id,
      quantity: 1,
      amount: round2(costAmount),
      businessEvent: "ADJUSTMENT",
      cycleType: "ASSET",
      businessUnit: "SHOP",
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("lease-termination"),
      entrepriseId,
    });

    const journal = [];
    const commonLeg = { catalogueId: catalogue.Catalogue_id, transactionId: transaction.Transactions_id, productId: placeholderProduct.Product_id, periodId: openPeriod.Structures_id, administrationId, entrepriseId };

    // Leg 1: Clear accumulated depreciation on the ROU asset
    if (accumulatedDepreciation > 0) {
      journal.push(...(await postJournalPair(tx, {
        ...commonLeg,
        debitAccount: accumDeprAccount,
        creditAccount: null,
        amount: accumulatedDepreciation,
        description: `LEASE_TERMINATION: clear accumulated depreciation on ${rouAsset.Assets_Type}`,
      })));
    }

    // Leg 2: Clear the remaining Lease Liability
    if (liabilityRemaining > 0) {
      journal.push(...(await postJournalPair(tx, {
        ...commonLeg,
        debitAccount: leaseLiabilityAccount,
        creditAccount: null,
        amount: liabilityRemaining,
        description: `LEASE_TERMINATION: clear remaining lease liability`,
      })));
    }

    // Leg 3: Remove the ROU asset at cost
    journal.push(...(await postJournalPair(tx, {
      ...commonLeg,
      debitAccount: null,
      creditAccount: rouAccount,
      amount: costAmount,
      description: `LEASE_TERMINATION: remove ${rouAsset.Assets_Type} at cost`,
    })));

    // Leg 4: Early-exit gain or loss if the two sides don't net to zero
    if (variance !== 0) {
      if (isGain) {
        const gainAccount = await mustFindOrCreateAccount(tx, "4501", "Early Lease Exit Gain", "INCOME", "CREDIT", "OTHER_INCOME", entrepriseId);
        journal.push(...(await postJournalPair(tx, {
          ...commonLeg,
          debitAccount: null,
          creditAccount: gainAccount,
          amount: Math.abs(variance),
          description: `LEASE_TERMINATION: gain on early exit — liability exceeded carrying amount`,
        })));
      } else {
        const lossAccount = await mustFindOrCreateAccount(tx, "5960", "Early Lease Exit Loss", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
        journal.push(...(await postJournalPair(tx, {
          ...commonLeg,
          debitAccount: lossAccount,
          creditAccount: null,
          amount: Math.abs(variance),
          description: `LEASE_TERMINATION: loss on early exit — carrying amount exceeded liability`,
        })));
      }
    }

    // Verify the journal balances — a lease termination that doesn't
    // balance means the accounting logic is wrong, not the input.
    const totalDebit = round2(journal.reduce((s, j) => s + Number(j.Debit || 0), 0));
    const totalCredit = round2(journal.reduce((s, j) => s + Number(j.Credit || 0), 0));
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new PostingError(`Lease termination journal did not balance (DR ${totalDebit}, CR ${totalCredit}) — this is an internal error, please report it.`);
    }

    // Mark both the ROU asset as disposed and the Liability as closed
    await tx.Assets.update({
      where: { Assets_id: rouAsset.Assets_id },
      data: { Period_end: new Date(), Carrying_Amount: 0, Disposal_Date: new Date() },
    });
    await tx.Liability.update({
      where: { Liability_id: leaseLiability.Liability_id },
      data: { Net_Amount: 0, Closure_Status: "CLOSED", Closure_Date: new Date() },
    });

    await tx.Narrative.create({
      data: {
        Transaction_id: transaction.Transactions_id,
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "ACCOUNTANT",
        Is_Generated: 0,
        Description: `Lease terminated: ${rouAsset.Assets_Type}. ${earlyExit ? "EARLY EXIT — " : ""}Carrying amount: KES ${carryingAmount}, Liability remaining: KES ${liabilityRemaining}, Variance: KES ${variance} (${isGain ? "gain" : isLoss ? "loss" : "zero"}).${notes ? " " + notes : ""}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { transaction, journal, carryingAmount, liabilityRemaining, variance, isEarlyExit: earlyExit };
  });
}

module.exports = { postLeaseCommencement, postLeasePayment, postLeaseTermination, leaseOutInventory, returnLeasedInventory, hireOutEquipment, endEquipmentHire };
