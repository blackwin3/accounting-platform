/**
 * lessor.js — the business as LESSOR: renting things out, the opposite
 * direction from postLeaseCommencement (leasesAndProvisions.js), which
 * is exclusively the business as LESSEE (renting shop premises IN, for
 * example). Genuinely different accounting: a lessor recognises
 * Operating Lease Income as rent is earned, never a Right-of-Use asset.
 *
 * Two distinct paths, matching how a business actually holds the item
 * being rented out — deliberately not unified, since the underlying
 * facts are genuinely different:
 *
 *   A. leaseOutInventory / returnLeasedInventory — a car dealership's
 *      car: a specific Goods unit (Resources row), temporarily checked
 *      out instead of sold. The unit stays owned throughout — it's
 *      unavailable, not gone — and returns to AVAILABLE stock when the
 *      lease ends. If the dealership decides to sell it instead, that's
 *      the existing, unrelated Till sale flow — this file only covers
 *      the temporary-hire case.
 *
 *   B. hireOutEquipment / endEquipmentHire — a hardware shop's heavy
 *      machinery: one owned Asset (with real depreciation, exactly like
 *      any other Asset), cycling through many different short-term
 *      renters over its working life. Genuinely distinct from
 *      rentalInvestments.js's Is_Rental_Property, which is one property
 *      with one long-term tenant — equipment hire is the opposite
 *      shape: one asset, many renters, each for a short period.
 */

const { prisma, PostingError, mustFindOrCreateAccount, mustFindOrCreateCatalogue, resolvePaymentAccount, openTransactionCycle, postJournalPair, buildCycleReference, round2 } = require("./core");

/**
 * leaseOutInventory — Path A. Checks out a specific inventory unit to a
 * customer for a period, recognising the agreed rental income as it's
 * collected (not accrued in advance — the same discipline this system
 * uses everywhere: an agreement is not the same fact as a receipt).
 * Marks the Resources row LEASED_OUT rather than decrementing stock the
 * way a genuine sale would.
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

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    const product = await tx.Product.findUnique({ where: { Product_id: resource.Product_id } });
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);
    const rentalIncomeAccount = await mustFindOrCreateAccount(tx, "4700", "Rental Income — Equipment/Inventory Hire", "INCOME", "CREDIT", "OPERATING_REVENUE", entrepriseId);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "LEASE_OUT_INVENTORY",
      description: "A specific inventory unit is leased out to a customer instead of sold — the unit stays owned, unavailable until returned. DR Cash/Mobile/Bank CR Rental Income.",
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

    const cycleReference = buildCycleReference("lease-out-inventory");
    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: resource.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PAYMENT",
      cycleType: "RENT",
      businessUnit,
      recordsId: null,
      cycleReference,
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: paymentAccount,
      creditAccount: rentalIncomeAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: resource.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `LEASE OUT: ${product ? product.Product_Name : "unit"} to ${stakeholder.First_name || ""} ${stakeholder.Last_name || ""} — KES ${round2(amount)} (${paymentMethod})`,
      entrepriseId,
    });

    await tx.Resources.update({
      where: { Resources_id: resource.Resources_id },
      data: { Resources_Status: "LEASED_OUT", Last_updated: new Date() },
    });

    await tx.Narrative.create({
      data: {
        Transaction_id: transaction.Transactions_id,
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

    return { journal, resourcesId: resource.Resources_id };
  });
}

/**
 * returnLeasedInventory — the leased unit comes back. Genuinely no
 * posting — the unit was never removed from the books (unlike a sale),
 * so nothing financial reverses; this only makes the unit available
 * again for the next sale or lease.
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
 * piece of equipment marked Equipment_For_Hire, and records the hire
 * income exactly like leaseOutInventory does for a Goods unit —
 * collected, not accrued. Genuinely no change to the Asset's own
 * depreciation schedule — the equipment keeps depreciating on its
 * normal schedule regardless of who's currently hiring it, the same as
 * any other owned Asset.
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

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);
    const hireIncomeAccount = await mustFindOrCreateAccount(tx, "4700", "Rental Income — Equipment/Inventory Hire", "INCOME", "CREDIT", "OPERATING_REVENUE", entrepriseId);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "EQUIPMENT_HIRE",
      description: "Owned equipment is hired out to a customer for a period — the equipment stays owned and keeps depreciating on its normal schedule. DR Cash/Mobile/Bank CR Rental Income.",
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

    const cycleReference = buildCycleReference("equipment-hire");
    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: null,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PAYMENT",
      cycleType: "RENT",
      businessUnit,
      recordsId: null,
      cycleReference,
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: paymentAccount,
      creditAccount: hireIncomeAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: null,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `EQUIPMENT HIRE: ${asset.Assets_Type} to ${stakeholder.First_name || ""} ${stakeholder.Last_name || ""} — KES ${round2(amount)} (${paymentMethod})`,
      entrepriseId,
    });

    await tx.Assets.update({
      where: { Assets_id: asset.Assets_id },
      data: { Current_Renter_Stakeholder_id: stakeholder.Stakeholder_id },
    });

    return { journal, assetsId: asset.Assets_id };
  });
}

/**
 * endEquipmentHire — the equipment comes back from its current renter.
 * No posting — the hire income was already recognised when collected;
 * this only frees the equipment for its next renter.
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

module.exports = { leaseOutInventory, returnLeasedInventory, hireOutEquipment, endEquipmentHire };
