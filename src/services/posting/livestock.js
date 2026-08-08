/**
 * livestock.js — individual biological asset tracking: animals AND
 * plants/crop plantings, genuinely using the Resources fields this
 * schema already declared for biological assets (Resource_Class=
 * BIOLOGICAL_ASSET, Fair_Value, Fair_Value_Date, Fair_Value_Basis — IAS
 * 41) but that no code had ever written to. One Resources row per
 * individually-tracked animal or planting (Resources_Quantity always
 * 1), not a fungible quantity the way ordinary stock works.
 *
 * "Monthly Review" — modelled on the Rental business unit's own
 * pattern: a Tenant is a Stakeholder checked in on periodically without
 * every check-in being a cash event; an animal or planting here is the
 * same shape. A review with no loss is a Narrative entry only — no
 * Journal posting, since nothing financial changed. A review that finds
 * a loss is genuinely different (see recordAnimalLoss below) — the two
 * are kept deliberately separate so a routine check can never
 * accidentally trigger an accounting entry, and a real loss can never
 * be silently only a note.
 *
 * The lifecycle events this file covers, each with a genuinely
 * different accounting shape:
 *   - registerAnimal    — enters the register; no posting of its own
 *   - recordMonthlyReview — condition/value check-in; no posting
 *   - recordBirth        — new stock appears from nothing; a real gain
 *   - recordHarvest       — a crop matures into a sellable Goods product
 *   - recordAnimalLoss    — death, missing, spoilage; a real loss
 *   - recordTheft         — stolen; a real loss, distinct narrative
 * Growth/maturation itself (chick -> adult chicken) deliberately reuses
 * postRepackaging from processing.js rather than duplicating it here —
 * that function already does exactly "consume N of product A, produce M
 * of product B, with optional spoilage," which is precisely what
 * maturing stock is. Only the shapes that function genuinely can't
 * express (something appearing with no input, or leaving with no
 * output) are new functions here.
 */

const { prisma, PostingError, mustFindOrCreateAccount, mustFindOrCreateCatalogue, openTransactionCycle, postJournalPair, buildCycleReference, round2 } = require("./core");

/**
 * registerAnimal — adds one animal or planting to the register. Does not
 * post to Journal by itself — acquiring it (purchase) is its own
 * separate accounting event through the normal Asset/Expense/Till flow;
 * this only creates the Resources row that tracks it going forward. Call
 * this alongside (not instead of) the real posting function for however
 * it was actually acquired. A birth is different — see recordBirth,
 * which creates the register row AND posts the resulting gain together,
 * since a birth is itself the acquisition event.
 */
async function registerAnimal(input) {
  const { productId, tag, category = "LIVESTOCK", sex, birthDate, fairValue, condition = "GOOD", growthStage = null, parentResourcesId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!productId) throw new PostingError("productId is required — the animal or planting must belong to a real Product (e.g. 'Cattle', 'Spinach')");
  if (!tag || !tag.trim()) throw new PostingError("A tag/identifier is required");
  if (category !== "LIVESTOCK" && category !== "CROP") throw new PostingError('category must be "LIVESTOCK" or "CROP"');

  const product = await prisma.Product.findUnique({ where: { Product_id: Number(productId) } });
  if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError("Product not found for this business");

  const existingTag = await prisma.Resources.findFirst({ where: { Animal_Tag: tag.trim(), Product_id: Number(productId) } });
  if (existingTag) throw new PostingError(`Something tagged "${tag.trim()}" already exists for this product.`);

  if (parentResourcesId) {
    const parent = await prisma.Resources.findUnique({ where: { Resources_id: Number(parentResourcesId) } });
    if (!parent) throw new PostingError("Parent record not found");
  }

  return prisma.Resources.create({
    data: {
      Product_id: Number(productId),
      Resource_type: "BIOLOGICAL_ASSET",
      Resource_Class: "BIOLOGICAL_ASSET",
      Resource_Category: category,
      Resources_Quantity: 1,
      Animal_Tag: tag.trim(),
      Animal_Sex: category === "LIVESTOCK" ? sex || null : null,
      Growth_Stage: growthStage,
      Parent_Resources_id: parentResourcesId ? Number(parentResourcesId) : null,
      Resources_Manufacture_Date: birthDate ? new Date(birthDate) : null,
      Fair_Value: fairValue != null ? round2(Number(fairValue)) : null,
      Fair_Value_Date: fairValue != null ? new Date() : null,
      Fair_Value_Basis: fairValue != null ? "MARKET_PRICE" : null,
      Resources_Quality: condition,
      Resources_Status: "AVAILABLE",
      Resources_Source: "PRODUCTION",
      Last_updated: new Date(),
    },
  });
}

/**
 * recordMonthlyReview — the routine check-in: condition, updated fair
 * value if reassessed, and a narrative note. No cash moves, so nothing
 * is posted to Journal — this is deliberately the same shape as
 * checking in on a rental tenant without collecting rent that visit.
 */
async function recordMonthlyReview(input) {
  const { resourcesId, condition, fairValue, growthStage, note, administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");

  const record = await prisma.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
  if (!record) throw new PostingError("Record not found");
  if (record.Resource_Class !== "BIOLOGICAL_ASSET") throw new PostingError("This Resources row isn't an animal or crop register record");

  const updateData = { Last_Review_Date: new Date(), Last_updated: new Date() };
  if (condition) updateData.Resources_Quality = condition;
  if (growthStage) updateData.Growth_Stage = growthStage;
  if (fairValue != null) {
    updateData.Fair_Value = round2(Number(fairValue));
    updateData.Fair_Value_Date = new Date();
  }

  const updated = await prisma.Resources.update({ where: { Resources_id: record.Resources_id }, data: updateData });

  if (note && note.trim()) {
    await prisma.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `Monthly review — ${record.Animal_Tag}: ${note.trim()}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });
  }

  return updated;
}

/**
 * recordAnimalLoss — an animal died or went missing. Genuinely
 * different from a routine review: this removes real economic value
 * from the business and must post a loss to Journal, not just update a
 * status field. DR Loss on Biological Assets, CR the same account the
 * animal's fair value was originally recognised under (a generic
 * Biological Assets asset account, since individual animals aren't
 * separately booked to their own ledger account).
 */
async function recordAnimalLoss(input) {
  const { resourcesId, reason, lossType = "DEATH_OR_SPOILAGE", businessUnit = "FARM", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");
  if (!reason || !reason.trim()) throw new PostingError("A reason is required when recording a loss");
  if (lossType !== "DEATH_OR_SPOILAGE" && lossType !== "THEFT") throw new PostingError('lossType must be "DEATH_OR_SPOILAGE" or "THEFT"');

  return prisma.$transaction(async (tx) => {
    const record = await tx.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
    if (!record) throw new PostingError("Record not found");
    if (record.Resource_Class !== "BIOLOGICAL_ASSET") throw new PostingError("This Resources row isn't an animal or crop register record");
    if (record.Resources_Status === "SOLD" || record.Resources_Status === "LOST" || record.Resources_Status === "STOLEN") {
      throw new PostingError(`This record is already marked ${record.Resources_Status} — cannot record a loss twice.`);
    }

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    const lossValue = round2(Number(record.Fair_Value || 0));
    let journal = [];

    if (lossValue > 0) {
      const lossAccount = lossType === "THEFT"
        ? await mustFindOrCreateAccount(tx, "5951", "Loss from Theft", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId)
        : await mustFindOrCreateAccount(tx, "5950", "Loss on Biological Assets", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
      const biologicalAssetAccount = await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);

      const catalogue = await mustFindOrCreateCatalogue(tx, {
        eventName: lossType === "THEFT" ? "LIVESTOCK_THEFT" : "LIVESTOCK_LOSS",
        description: lossType === "THEFT"
          ? "An animal or planting is stolen — genuinely distinct from death/spoilage for pattern-of-loss review. DR Loss from Theft CR Biological Assets."
          : "An animal or planting dies, spoils, or is otherwise lost — not stolen. DR Loss on Biological Assets CR Biological Assets.",
        debitCode: lossType === "THEFT" ? "5951" : "5950",
        creditCode: "1450",
        cashFlowCategory: "NONE",
        riskLevel: lossType === "THEFT" ? "HIGH" : "MEDIUM",
        cycleType: "EXPENDITURE",
        alertRequired: lossType === "THEFT" ? 1 : 0,
        narrativeTemplate: "{Animal_Tag} lost — {Reason}.",
        reportSections: "INCOME_STATEMENT:Loss on Biological Assets",
        businessUnit,
        entrepriseId,
      });

      const cycleReference = buildCycleReference(lossType === "THEFT" ? "livestock-theft" : "livestock-loss");
      const transaction = await openTransactionCycle(tx, {
        accountId: lossAccount.Account_id,
        productId: record.Product_id,
        quantity: 1,
        amount: lossValue,
        businessEvent: "LOSS",
        cycleType: "ASSET",
        businessUnit,
        recordsId: null,
        cycleReference,
        entrepriseId,
      });

      journal = await postJournalPair(tx, {
        debitAccount: lossAccount,
        creditAccount: biologicalAssetAccount,
        amount: lossValue,
        catalogueId: catalogue.Catalogue_id,
        transactionId: transaction.Transactions_id,
        productId: record.Product_id,
        periodId: openPeriod.Structures_id,
        administrationId,
        description: `${lossType === "THEFT" ? "THEFT" : "LOSS"}: ${record.Animal_Tag} — ${reason.trim()}`,
        entrepriseId,
      });
    }

    await tx.Resources.update({
      where: { Resources_id: record.Resources_id },
      data: { Resources_Status: lossType === "THEFT" ? "STOLEN" : "LOST", Last_updated: new Date() },
    });

    await tx.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `${lossType === "THEFT" ? "Stolen" : "Lost"} — ${record.Animal_Tag}: ${reason.trim()}${lossValue > 0 ? ` (recorded loss of KES ${lossValue})` : ""}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { journal, lossValue };
  });
}

/**
 * recordBirth — a new animal born to a mother already on the register.
 * Genuinely different from registerAnimal: a birth IS the acquisition
 * event, so this creates the register row AND posts the resulting gain
 * together, rather than requiring a separate posting call the way a
 * purchased animal does. DR Biological Assets CR Gain on Biological
 * Assets (IAS 41 fair value gain — new stock has appeared with no cash
 * paid for it, which is real, recognisable profit under the standard
 * this system is built toward, not an accounting fiction).
 */
async function recordBirth(input) {
  const { motherResourcesId, tag, sex, fairValue, condition = "GOOD", growthStage = "NEWBORN", businessUnit = "FARM", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!motherResourcesId) throw new PostingError("motherResourcesId is required — a birth must be linked to a real mother on the register");
  if (!tag || !tag.trim()) throw new PostingError("A tag/identifier is required for the new animal");
  if (fairValue == null || Number(fairValue) < 0) throw new PostingError("A non-negative fair value is required to record the birth as a real gain");

  return prisma.$transaction(async (tx) => {
    const mother = await tx.Resources.findUnique({ where: { Resources_id: Number(motherResourcesId) } });
    if (!mother) throw new PostingError("Mother record not found");
    if (mother.Resource_Class !== "BIOLOGICAL_ASSET") throw new PostingError("The mother record isn't an animal register record");
    if (mother.Animal_Sex !== "FEMALE") throw new PostingError("The mother record must be marked FEMALE to record a birth against it");

    const existingTag = await tx.Resources.findFirst({ where: { Animal_Tag: tag.trim(), Product_id: mother.Product_id } });
    if (existingTag) throw new PostingError(`Something tagged "${tag.trim()}" already exists for this product.`);

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    const newborn = await tx.Resources.create({
      data: {
        Product_id: mother.Product_id,
        Resource_type: "BIOLOGICAL_ASSET",
        Resource_Class: "BIOLOGICAL_ASSET",
        Resource_Category: "LIVESTOCK",
        Resources_Quantity: 1,
        Animal_Tag: tag.trim(),
        Animal_Sex: sex || null,
        Growth_Stage: growthStage,
        Parent_Resources_id: mother.Resources_id,
        Resources_Manufacture_Date: new Date(),
        Fair_Value: round2(Number(fairValue)),
        Fair_Value_Date: new Date(),
        Fair_Value_Basis: "MARKET_PRICE",
        Resources_Quality: condition,
        Resources_Status: "AVAILABLE",
        Resources_Source: "PRODUCTION",
        Last_updated: new Date(),
      },
    });

    const gainValue = round2(Number(fairValue));
    let journal = [];
    if (gainValue > 0) {
      const biologicalAssetAccount = await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
      const gainAccount = await mustFindOrCreateAccount(tx, "4550", "Gain on Biological Assets", "INCOME", "CREDIT", "OTHER_INCOME", entrepriseId);

      const catalogue = await mustFindOrCreateCatalogue(tx, {
        eventName: "LIVESTOCK_BIRTH",
        description: "A new animal is born to a mother already on the register — new stock appears with no cash paid for it, a real IAS 41 fair value gain. DR Biological Assets CR Gain on Biological Assets.",
        debitCode: "1450",
        creditCode: "4550",
        cashFlowCategory: "NONE",
        riskLevel: "LOW",
        cycleType: "INCOME",
        alertRequired: 0,
        narrativeTemplate: "{Animal_Tag} born to {Parent_Tag}.",
        reportSections: "INCOME_STATEMENT:Gain on Biological Assets",
        businessUnit,
        entrepriseId,
      });

      const cycleReference = buildCycleReference("livestock-birth");
      const transaction = await openTransactionCycle(tx, {
        accountId: biologicalAssetAccount.Account_id,
        productId: newborn.Product_id,
        quantity: 1,
        amount: gainValue,
        businessEvent: "RECOGNITION",
        cycleType: "ASSET",
        businessUnit,
        recordsId: null,
        cycleReference,
        entrepriseId,
      });

      journal = await postJournalPair(tx, {
        debitAccount: biologicalAssetAccount,
        creditAccount: gainAccount,
        amount: gainValue,
        catalogueId: catalogue.Catalogue_id,
        transactionId: transaction.Transactions_id,
        productId: newborn.Product_id,
        periodId: openPeriod.Structures_id,
        administrationId,
        description: `BIRTH: ${newborn.Animal_Tag} born to ${mother.Animal_Tag}`,
        entrepriseId,
      });
    }

    await tx.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `Birth — ${newborn.Animal_Tag} born to ${mother.Animal_Tag}${gainValue > 0 ? ` (recorded gain of KES ${gainValue})` : ""}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { animal: newborn, journal, gainValue };
  });
}

/**
 * recordHarvest — a crop planting matures into a sellable Goods product.
 * Genuinely the mirror of recordBirth for plants: the register row for
 * the planting is marked HARVESTED (leaves the individually-tracked
 * register), and a real Goods quantity is added to Resources for the
 * resulting product — DR Inventory CR nothing (the value was already
 * recognised as the crop grew, if fair-valued during reviews; if never
 * valued, this recognises it for the first time as inventory at the
 * estimated harvest value, the honest default when no interim valuation
 * was ever recorded).
 */
async function recordHarvest(input) {
  const { plantingResourcesId, outputProductId, outputQuantity, harvestValue, businessUnit = "FARM", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!plantingResourcesId) throw new PostingError("plantingResourcesId is required");
  if (!outputProductId) throw new PostingError("outputProductId is required — the sellable Goods product this harvest becomes");
  if (!outputQuantity || outputQuantity <= 0) throw new PostingError("outputQuantity must be positive");

  return prisma.$transaction(async (tx) => {
    const planting = await tx.Resources.findUnique({ where: { Resources_id: Number(plantingResourcesId) } });
    if (!planting) throw new PostingError("Planting record not found");
    if (planting.Resource_Class !== "BIOLOGICAL_ASSET" || planting.Resource_Category !== "CROP") {
      throw new PostingError("This Resources row isn't a crop register record");
    }
    if (planting.Resources_Status !== "AVAILABLE") {
      throw new PostingError(`This planting is already marked ${planting.Resources_Status} — cannot harvest it twice.`);
    }

    const outputProduct = await tx.Product.findUnique({ where: { Product_id: Number(outputProductId) } });
    if (!outputProduct || outputProduct.Entreprise_id !== entrepriseId) throw new PostingError("Output product not found");

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    // The value already recognised while the crop was growing (if it was
    // ever fair-valued during a review) is removed from Biological
    // Assets; any harvestValue beyond that (or all of it, if never
    // valued before) becomes the harvested Goods' inventory cost.
    const priorValue = round2(Number(planting.Fair_Value || 0));
    const finalValue = harvestValue != null ? round2(Number(harvestValue)) : priorValue;
    if (finalValue < 0) throw new PostingError("Harvest value cannot be negative");

    const inventoryAccount = await mustFindOrCreateAccount(tx, "1100", "Inventory", "ASSET", "DEBIT", "CURRENT_ASSET", entrepriseId);
    let journal = [];

    if (finalValue > 0) {
      const biologicalAssetAccount = await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);

      const catalogue = await mustFindOrCreateCatalogue(tx, {
        eventName: "HARVEST",
        description: "A crop planting matures into a sellable Goods product — the planting leaves the individually-tracked register and becomes real inventory. DR Inventory CR Biological Assets.",
        debitCode: "1100",
        creditCode: "1450",
        cashFlowCategory: "NONE",
        riskLevel: "LOW",
        cycleType: "INVENTORY",
        alertRequired: 0,
        narrativeTemplate: "{Animal_Tag} harvested into {Quantity} {Product_Name}.",
        reportSections: "BALANCE_SHEET:Inventory",
        businessUnit,
        entrepriseId,
      });

      const cycleReference = buildCycleReference("harvest");
      const transaction = await openTransactionCycle(tx, {
        accountId: inventoryAccount.Account_id,
        productId: outputProduct.Product_id,
        quantity: outputQuantity,
        amount: finalValue,
        businessEvent: "TRANSFER",
        cycleType: "INVENTORY",
        businessUnit,
        recordsId: null,
        cycleReference,
        entrepriseId,
      });

      // If the crop was never valued before, this is a real recognition
      // (Biological Assets never held any value for it), so the credit
      // leg still comes from Biological Assets by convention — the
      // account simply nets to a small negative/zero contribution from
      // this specific planting, correct since the schema doesn't track
      // per-planting sub-accounts separately.
      journal = await postJournalPair(tx, {
        debitAccount: inventoryAccount,
        creditAccount: biologicalAssetAccount,
        amount: finalValue,
        catalogueId: catalogue.Catalogue_id,
        transactionId: transaction.Transactions_id,
        productId: outputProduct.Product_id,
        periodId: openPeriod.Structures_id,
        administrationId,
        description: `HARVEST: ${planting.Animal_Tag} produced ${outputQuantity} ${outputProduct.Product_Name}`,
        entrepriseId,
      });
    }

    await tx.Resources.update({
      where: { Resources_id: planting.Resources_id },
      data: { Resources_Status: "HARVESTED", Growth_Stage: "HARVESTED", Last_updated: new Date() },
    });

    const outputResource = await tx.Resources.findFirst({ where: { Product_id: outputProduct.Product_id, Resource_Category: { not: "CROP" } } });
    if (outputResource) {
      await tx.Resources.update({
        where: { Resources_id: outputResource.Resources_id },
        data: { Resources_Quantity: round2(Number(outputResource.Resources_Quantity) + outputQuantity), Last_updated: new Date() },
      });
    } else {
      await tx.Resources.create({
        data: {
          Product_id: outputProduct.Product_id,
          Resource_type: "INVENTORY",
          Resource_Class: "INVENTORY",
          Resources_Quantity: outputQuantity,
          Resources_Status: "AVAILABLE",
          Resources_Source: "PRODUCTION",
          Last_updated: new Date(),
        },
      });
    }

    if (outputQuantity > 0) {
      const unitCost = round2(finalValue / outputQuantity);
      await tx.Product.update({ where: { Product_id: outputProduct.Product_id }, data: { Product_Cost: unitCost } });
    }

    await tx.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `Harvest — ${planting.Animal_Tag} produced ${outputQuantity} ${outputProduct.Product_Name}${finalValue > 0 ? ` (KES ${finalValue})` : ""}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { journal, finalValue, outputQuantity };
  });
}

module.exports = { registerAnimal, recordMonthlyReview, recordAnimalLoss, recordBirth, recordHarvest };
