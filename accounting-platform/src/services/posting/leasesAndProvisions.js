/**
 * leasesAndProvisions.js — the Leases (IFRS 16) and Provisions (IAS 37)
 * domain. Matches the Claims > Leases & Provisions page.
 */

const {
  prisma,
  PostingError,
  resolvePaymentAccount,
  openTransactionCycle,
  postJournalPair,
  writeNarrative,
  buildCycleReference,
  round2,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
  findOrCreateExpensePlaceholder,
} = require("./core");

/**
 * postLeaseCommencement — IFRS 16: recognises a Right-of-Use asset and a
 * matching Lease Liability at the start of a lease. Simplified from full
 * IFRS 16, which discounts future payments to present value using the
 * lessee's incremental borrowing rate — this system has no rate input yet,
 * so commencement uses the total undiscounted contracted payments instead.
 * That simplification is documented on the Rules page, not hidden.
 *
 * @param {Object} input
 * @param {string} input.description        - e.g. "Shop premises, Naivasha — 5 year lease"
 * @param {number} input.totalLeasePayments - sum of all payments over the lease term
 * @param {number} input.leaseTermYears
 * @param {number} [input.administrationId]
 * @param {string} [input.businessUnit]
 */
async function postLeaseCommencement(input) {
  const { description, totalLeasePayments, leaseTermYears, administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!description || !description.trim()) throw new PostingError("Lease description is required");
  if (!totalLeasePayments || totalLeasePayments <= 0) throw new PostingError("Total lease payments must be positive");
  if (!leaseTermYears || leaseTermYears <= 0) throw new PostingError("Lease term (years) must be positive");

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "LEASE_COMMENCEMENT",
      description: "Recognise a Right-of-Use asset and Lease Liability at lease start. DR Right-of-Use Asset (1600) CR Lease Liability (2200). IFRS 16.",
      debitCode: "1600",
      creditCode: "2200",
      cashFlowCategory: "NONE", // non-cash at commencement — the liability is recognised, no cash moves yet
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

    // A Product row anchors the ROU asset the same way a purchased asset does
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

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(totalLeasePayments),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: leaseLiabilityAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(totalLeasePayments),
      businessEvent: "RECEIPT",
      cycleType: "ASSET",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("lease"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: rouAccount,
      creditAccount: leaseLiabilityAccount,
      amount: round2(totalLeasePayments),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `LEASE_COMMENCEMENT: ${description.trim()}`,
      entrepriseId,
    });

    // The Right-of-Use asset lives in the Assets register so it can be
    // amortised through the same depreciation mechanism as owned assets.
    const rouAsset = await tx.Assets.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: rouAccount.Account_id,
        Records_id: recordsRow.Records_id,
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

    // The Lease Liability sits alongside loans in the Liability register
    const liability = await tx.Liability.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: leaseLiabilityAccount.Account_id,
        Records_id: recordsRow.Records_id,
        Liability_Type: "Lease",
        Liability_Classification: "NON_CURRENT",
        Net_Amount: round2(totalLeasePayments),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Product_Name: description.trim(),
      Amount: totalLeasePayments.toFixed(2),
      Years: leaseTermYears,
    }, entrepriseId);

    return { transaction, journal, rouAsset, liability, narrative };
  });
}

/**
 * postLeasePayment — IFRS 16: a lease payment reduces the Lease Liability
 * (the financing portion) via a real Journal posting. The Right-of-Use
 * asset's own amortisation is handled separately by postDepreciationRun,
 * the same mechanism already used for owned assets — a lease payment does
 * not itself reduce the ROU asset's carrying amount.
 *
 * @param {Object} input
 * @param {number} input.liabilityId  - Liability.Liability_id from the register
 * @param {number} input.amount
 * @param {"CASH"|"MOBILE"|"BANK"} [input.paymentMethod] - defaults to CASH
 */
async function postLeasePayment(input) {
  const { liabilityId, amount, paymentMethod = "CASH", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!liabilityId) throw new PostingError("liabilityId is required");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK"');

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const liability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!liability || liability.Liability_Type !== "Lease" || liability.Entreprise_id !== entrepriseId) throw new PostingError("Lease liability not found");

    const outstanding = Number(liability.Net_Amount || 0);
    if (amount > outstanding) throw new PostingError(`Payment (${amount}) exceeds the remaining lease liability (${outstanding}).`);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "LEASE_PAYMENT",
      description: "A lease payment. DR Lease Liability (2200) CR Cash/Mobile/Bank. Reduces the financing obligation, not an expense in itself.",
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

    const leaseLiabilityAccount = await mustFindOrCreateAccount(tx, "2200", "Lease Liability", "LIABILITY", "CREDIT", "NON_CURRENT_LIABILITY", entrepriseId);
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "pay", entrepriseId);
    const product = await findOrCreateExpensePlaceholder(tx, "Lease Payment", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: "SHOP",
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PAYMENT",
      cycleType: "ASSET",
      businessUnit: "SHOP",
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("lease-payment"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: leaseLiabilityAccount,
      creditAccount: paymentAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `LEASE_PAYMENT: KES ${amount} (${paymentMethod})`,
      entrepriseId,
    });

    const newOutstanding = round2(outstanding - amount);
    await tx.Liability.update({
      where: { Liability_id: liability.Liability_id },
      data: { Net_Amount: newOutstanding },
    });

    return { transaction, journal, newOutstanding };
  });
}

/**
 * postProvision — IAS 37: recognises an estimated obligation (typically a
 * product warranty) at the point the obligation arises, not when a claim
 * is later made. DR Warranty Expense (5930) CR Provision for Warranties
 * (2300).
 *
 * @param {Object} input
 * @param {number} input.amount
 * @param {string} [input.description]
 */
async function postProvision(input) {
  const { amount, description = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "RECORD_PROVISION",
      description: "Recognise an estimated obligation (e.g. product warranty) at the point it arises. DR Warranty Expense (5930) CR Provision for Warranties (2300). IAS 37.",
      debitCode: "5930",
      creditCode: "2300",
      cashFlowCategory: "NONE",
      riskLevel: "MEDIUM",
      cycleType: "EXPENDITURE",
      alertRequired: 0,
      narrativeTemplate: "Provision of KES {Amount} recognised. {Notes}",
      reportSections: "INCOME_STATEMENT:WarrantyExpense|BALANCE_SHEET:Provisions",
      businessUnit,
      entrepriseId,
    });

    const expenseAccount = await mustFindOrCreateAccount(tx, "5930", "Warranty Expense", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
    const provisionAccount = await mustFindOrCreateAccount(tx, "2300", "Provision for Warranties", "LIABILITY", "CREDIT", "CURRENT_LIABILITY", entrepriseId);
    const product = await findOrCreateExpensePlaceholder(tx, "Warranty Provision", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: provisionAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "ADJUSTMENT",
      cycleType: "EXPENDITURE",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("provision"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: expenseAccount,
      creditAccount: provisionAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `RECORD_PROVISION: ${description || "estimated obligation"}`,
      entrepriseId,
    });

    const liability = await tx.Liability.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: provisionAccount.Account_id,
        Records_id: recordsRow.Records_id,
        Liability_Type: "Warranty Provision",
        Liability_Classification: "CURRENT",
        Net_Amount: round2(amount),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      Notes: description,
    }, entrepriseId);

    return { transaction, journal, liability, narrative };
  });
}

/**
 * postProvisionUtilisation — IAS 37: when a warranty claim is actually
 * honoured, the existing provision is drawn down rather than a fresh
 * expense being recognised — the expense was already booked when the
 * provision was first estimated.
 *
 * @param {Object} input
 * @param {number} input.liabilityId  - the Liability row from postProvision
 * @param {number} input.amount
 * @param {"CASH"|"MOBILE"|"BANK"} [input.paymentMethod] - defaults to CASH
 */
async function postProvisionUtilisation(input) {
  const { liabilityId, amount, paymentMethod = "CASH", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!liabilityId) throw new PostingError("liabilityId is required");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const liability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!liability || liability.Liability_Type !== "Warranty Provision" || liability.Entreprise_id !== entrepriseId) throw new PostingError("Warranty provision not found");

    const outstanding = Number(liability.Net_Amount || 0);
    if (amount > outstanding) throw new PostingError(`Claim (${amount}) exceeds the remaining provision (${outstanding}).`);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "UTILISE_PROVISION",
      description: "A warranty claim is honoured, drawing down the existing provision. DR Provision for Warranties (2300) CR Cash/Mobile/Bank. No new expense — already recognised at RECORD_PROVISION. IAS 37.",
      debitCode: "2300",
      creditCode: "1000",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "EXPENDITURE",
      alertRequired: 0,
      narrativeTemplate: "Warranty claim of KES {Amount} honoured, drawing down the existing provision.",
      reportSections: "BALANCE_SHEET:Provisions|CASH_FLOW:Operating",
      businessUnit: "SHOP",
      entrepriseId,
    });

    const provisionAccount = await mustFindOrCreateAccount(tx, "2300", "Provision for Warranties", "LIABILITY", "CREDIT", "CURRENT_LIABILITY", entrepriseId);
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "pay", entrepriseId);
    const product = await findOrCreateExpensePlaceholder(tx, "Warranty Claim", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: "SHOP",
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PAYMENT",
      cycleType: "EXPENDITURE",
      businessUnit: "SHOP",
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("provision-claim"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: provisionAccount,
      creditAccount: paymentAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `UTILISE_PROVISION: KES ${amount} (${paymentMethod})`,
      entrepriseId,
    });

    const newOutstanding = round2(outstanding - amount);
    await tx.Liability.update({
      where: { Liability_id: liability.Liability_id },
      data: { Net_Amount: newOutstanding },
    });

    return { transaction, journal, newOutstanding };
  });
}

module.exports = { postLeaseCommencement, postLeasePayment, postProvision, postProvisionUtilisation };
