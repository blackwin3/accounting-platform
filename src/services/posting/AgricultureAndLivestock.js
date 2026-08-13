/**
 * AgricultureAndLivestock.js — merged from livestock.js and
 * rentalInvestments.js. The architectural connection your framing made
 * explicit: livestock tracks animals and crops like tenants — one
 * individually-monitored holding that generates periodic income, checked
 * in on routinely without every check-in being a cash event, and
 * disposed of (sold, lost, or harvested) as a single real event with its
 * own accounting. A rental property is the same shape applied to a
 * building: one holding, one tenant, periodic rent, eventual disposal
 * through the existing postAssetDisposal path.
 *
 * Both livestock and rental properties are therefore "managed income-
 * generating holdings with individual tracking" — the right grouping,
 * rather than the accidental one (rentalInvestments.js being near
 * investments.js because "rental" sounded like "investing").
 *
 * Catalogue migration status:
 *
 *   registerAnimal         — no Journal posting. Nothing to migrate.
 *   recordMonthlyReview    — no Journal posting. Nothing to migrate.
 *   recordAnimalLoss       — migrated onto runCatalogueEvent: the loss
 *                            type (DEATH_OR_SPOILAGE vs THEFT) selects
 *                            the eventName before calling the interpreter,
 *                            then each is a genuine SIMPLE fixed-pair
 *                            posting. Same pattern as postAssetRevaluation
 *                            choosing REVALUE_ASSET_UP vs DOWN.
 *   recordBirth            — migrated onto runCatalogueEvent: fixed
 *                            Catalogue codes (1450/4550), one Journal
 *                            pair. SIMPLE.
 *   recordHarvest          — migrated onto runCatalogueEvent: fixed
 *                            Catalogue codes (1100/1450), one Journal
 *                            pair, plus Resources and Product side-effects.
 *   postRentalPropertyPurchase — wraps postAssetPurchase then updates the
 *                            Assets row with rental-specific facts. Already
 *                            Catalogue-based via wrapper. Nothing changes.
 *   assignTenant           — pure Assets row update. No Journal posting.
 *                            Nothing to migrate.
 */

const { prisma, PostingError, mustFindOrCreateAccount, mustFindOrCreateCatalogue, buildCycleReference, round2, openTransactionCycle, postJournalPair, findOrCreateExpensePlaceholder } = require("./core");
const { runCatalogueEvent } = require("./interpreter");
const { postAssetPurchase } = require("./assets");

// ─── SECTION 1: BIOLOGICAL ASSETS — LIVESTOCK AND CROPS (IAS 41) ─────────────

/**
 * registerAnimal — adds one animal or crop planting to the individually-
 * tracked register. No Journal posting — acquisition is its own separate
 * event through the normal posting flows; this only creates the Resources
 * row. A birth is different: see recordBirth, which creates the row AND
 * posts the gain together.
 */
async function registerAnimal(input) {
  const { productId, tag, category = "LIVESTOCK", sex, birthDate, fairValue, condition = "GOOD", growthStage = null, parentResourcesId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!productId) throw new PostingError("productId is required");
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
    data: { Product_id: Number(productId), Resource_type: "BIOLOGICAL_ASSET", Resource_Class: "BIOLOGICAL_ASSET", Resource_Category: category, Resource_Mode: category === "LIVESTOCK" ? "BIOLOGICAL" : "LOT", Resources_Quantity: 1, Animal_Tag: tag.trim(), Animal_Sex: category === "LIVESTOCK" ? sex || null : null, Growth_Stage: growthStage, Parent_Resources_id: parentResourcesId ? Number(parentResourcesId) : null, Resources_Manufacture_Date: birthDate ? new Date(birthDate) : null, Fair_Value: fairValue != null ? round2(Number(fairValue)) : null, Fair_Value_Date: fairValue != null ? new Date() : null, Fair_Value_Basis: fairValue != null ? "MARKET_PRICE" : null, Resources_Quality: condition, Resources_Status: "AVAILABLE", Resources_Source: "PRODUCTION", Last_updated: new Date() },
  });
}

/**
 * bulkPlanting — registers multiple plantings at once for a field crop
 * (maize, beans, tomatoes) where individual registration would be
 * impractical. Creates one Resources row per plot/row/section with auto-
 * generated sequential tags. No Journal posting — same as registerAnimal,
 * the planting itself is a register event, not an accounting event.
 *
 * This closes the Tier 3 gap: "no bulk planting batch — each planting
 * must be registered individually."
 */
async function bulkPlanting(input) {
  const { productId, fieldId, plotCount, plantingDate = null, fairValuePerPlot = 0, growthStage = "PLANTED", condition = "GOOD", note = "", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!productId) throw new PostingError("productId is required — which crop is being planted.");
  if (!fieldId || !fieldId.trim()) throw new PostingError("fieldId is required — a label for the field (e.g. 'FIELD-A', 'LOWER-TERRACE').");
  if (!plotCount || plotCount <= 0) throw new PostingError("plotCount must be positive — how many plots/rows/sections.");

  const product = await prisma.Product.findUnique({ where: { Product_id: Number(productId) } });
  if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError("Crop product not found for this business.");

  const rows = [];
  for (let i = 1; i <= plotCount; i++) {
    const tag = `${fieldId.trim()}-${String(i).padStart(3, "0")}`;
    const existing = await prisma.Resources.findFirst({ where: { Animal_Tag: tag, Product_id: Number(productId) } });
    if (existing) continue; // skip if already registered (idempotent re-run)

    const row = await prisma.Resources.create({
      data: {
        Product_id: Number(productId),
        Resource_type: "BIOLOGICAL_ASSET",
        Resource_Class: "BIOLOGICAL_ASSET",
        Resource_Mode: "LOT",
        Resource_Category: "CROP",
        Resources_Quantity: 1,
        Animal_Tag: tag,
        Growth_Stage: growthStage,
        Resources_Manufacture_Date: plantingDate ? new Date(plantingDate) : new Date(),
        Fair_Value: round2(Number(fairValuePerPlot)),
        Fair_Value_Date: new Date(),
        Fair_Value_Basis: fairValuePerPlot > 0 ? "MARKET_PRICE" : null,
        Resources_Quality: condition,
        Resources_Status: "AVAILABLE",
        Resources_Source: "PRODUCTION",
        Last_updated: new Date(),
      },
    });
    rows.push(row);
  }

  if (note && note.trim()) {
    await prisma.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `Bulk planting: ${plotCount} plots of ${product.Product_Name} in field ${fieldId.trim()}.${note ? " " + note.trim() : ""}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });
  }

  return { plotsRegistered: rows.length, fieldId: fieldId.trim(), totalFairValue: round2(rows.length * Number(fairValuePerPlot)) };
}

/**
 * postSeasonalLabour — records a payment to temporary/seasonal workers.
 * Unlike a salaried employee (who would need a payroll register with
 * PAYE/NHIF/NSSF), seasonal labour on a Kenyan smallholding is paid
 * cash-in-hand per day or per task — no statutory deductions, no payslip.
 * This is the honest accounting: DR Casual Labour Expense (5250)
 * CR Cash/Mobile/Bank.
 *
 * Tracks the worker's Stakeholder_id so the system knows WHO was paid,
 * how many days/tasks, and at what rate — enough for the auditor to
 * verify, and for the succession report to show the incoming owner what
 * labour arrangements the farm depends on.
 *
 * This closes the relevant part of the Tier 3 payroll gap for the
 * Chebet case: seasonal labour during planting and harvest, and extra
 * security during harvest to mitigate theft.
 */
async function postSeasonalLabour(input) {
  const { stakeholderId = null, description, days, dailyRate, paymentMethod = "CASH", labourType = "FARM_LABOUR", businessUnit = "FARM", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!description || !description.trim()) throw new PostingError("A description is required (what work was done).");
  if (!days || days <= 0) throw new PostingError("Days must be positive.");
  if (!dailyRate || dailyRate <= 0) throw new PostingError("Daily rate must be positive.");
  if (!["FARM_LABOUR", "SECURITY", "HARVEST", "OTHER"].includes(labourType)) {
    throw new PostingError('labourType must be one of: FARM_LABOUR, SECURITY, HARVEST, OTHER');
  }

  const amount = round2(days * dailyRate);

  return prisma.$transaction(async (tx) => {
    if (stakeholderId) {
      const worker = await tx.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
      if (!worker || worker.Entreprise_id !== entrepriseId) throw new PostingError("Worker (Stakeholder) not found for this business.");
    }

    await mustFindOrCreateCatalogue(tx, {
      eventName: "PAY_SEASONAL_LABOUR",
      description: "Payment to temporary/seasonal workers — cash-in-hand per day or per task. DR Casual Labour Expense (5250) CR Cash/Mobile/Bank. No statutory deductions — genuine casual labour, not formal employment.",
      debitCode: "5250",
      creditCode: "1000",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "PAYROLL",
      alertRequired: 0,
      narrativeTemplate: "{Description}: {Days} days at KES {Rate}/day = KES {Amount}.",
      reportSections: "INCOME_STATEMENT:CasualLabour",
      businessUnit,
      entrepriseId,
    });

    await mustFindOrCreateAccount(tx, "5250", "Casual Labour Expense", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);

    const product = await findOrCreateExpensePlaceholder(tx, labourType === "SECURITY" ? "Security Labour" : "Farm Labour", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "PAY_SEASONAL_LABOUR",
      amount,
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: { Description: description.trim(), Days: days, Rate: dailyRate },
      entrepriseId,
    });

    await tx.Narrative.create({
      data: {
        Transaction_id: result.transaction.Transactions_id,
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `${labourType}: ${description.trim()} — ${days} days at KES ${dailyRate}/day = KES ${amount}.${stakeholderId ? " Worker: Stakeholder #" + stakeholderId : ""}`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { transaction: result.transaction, journal: result.journal, amount, labourType };
  });
}

/**
 * recordMonthlyReview — routine condition/value check-in. No Journal
 * posting — a review with no loss is a Narrative entry only. Checking in
 * on an animal or a planting without any loss is the same non-event as
 * checking in on a tenant without collecting rent that visit.
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
  if (fairValue != null) { updateData.Fair_Value = round2(Number(fairValue)); updateData.Fair_Value_Date = new Date(); }

  const updated = await prisma.Resources.update({ where: { Resources_id: record.Resources_id }, data: updateData });

  if (note && note.trim()) {
    await prisma.Narrative.create({ data: { Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `Monthly review — ${record.Animal_Tag}: ${note.trim()}`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId } });
  }
  return updated;
}

/**
 * recordAnimalLoss — an animal died, spoiled, or was stolen. Removes
 * real economic value from the business and posts a loss. Two distinct
 * Catalogue events (LIVESTOCK_LOSS vs LIVESTOCK_THEFT) because the
 * narrative and risk profile are genuinely different — the same
 * branching pattern as postAssetRevaluation choosing UP vs DOWN.
 * DR Loss account CR Biological Assets.
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
    if (["SOLD", "LOST", "STOLEN"].includes(record.Resources_Status)) throw new PostingError(`This record is already marked ${record.Resources_Status} — cannot record a loss twice.`);

    const lossValue = round2(Number(record.Fair_Value || 0));
    let journal = [];

    if (lossValue > 0) {
      const isTheft = lossType === "THEFT";
      const eventName = isTheft ? "LIVESTOCK_THEFT" : "LIVESTOCK_LOSS";
      const lossCode = isTheft ? "5951" : "5950";
      const lossName = isTheft ? "Loss from Theft" : "Loss on Biological Assets";

      await mustFindOrCreateCatalogue(tx, {
        eventName,
        description: isTheft
          ? "An animal or planting is stolen — genuinely distinct from death/spoilage for pattern-of-loss review. DR Loss from Theft (5951) CR Biological Assets (1450). IAS 41."
          : "An animal or planting dies, spoils, or is otherwise lost — not stolen. DR Loss on Biological Assets (5950) CR Biological Assets (1450). IAS 41.",
        debitCode: lossCode,
        creditCode: "1450",
        cashFlowCategory: "NONE",
        riskLevel: isTheft ? "HIGH" : "MEDIUM",
        cycleType: "EXPENDITURE",
        alertRequired: isTheft ? 1 : 0,
        narrativeTemplate: "{Animal_Tag} lost — {Reason}.",
        reportSections: "INCOME_STATEMENT:Loss on Biological Assets",
        businessUnit,
        entrepriseId,
      });

      await mustFindOrCreateAccount(tx, lossCode, lossName, "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
      await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);

      const result = await runCatalogueEvent(tx, {
        eventName,
        amount: lossValue,
        productId: record.Product_id,
        businessUnit,
        administrationId,
        narrativeValues: { Animal_Tag: record.Animal_Tag, Reason: reason.trim() },
        entrepriseId,
      });
      journal = result.journal;
    }

    await tx.Resources.update({ where: { Resources_id: record.Resources_id }, data: { Resources_Status: lossType === "THEFT" ? "STOLEN" : "LOST", Last_updated: new Date() } });

    await tx.Narrative.create({ data: { Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `${lossType === "THEFT" ? "Stolen" : "Lost"} — ${record.Animal_Tag}: ${reason.trim()}${lossValue > 0 ? ` (recorded loss of KES ${lossValue})` : ""}`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId } });

    return { journal, lossValue };
  });
}

/**
 * recordBirth — a new animal born to a mother already on the register.
 * Creates the register row AND posts the IAS 41 fair value gain together,
 * since the birth is itself the acquisition event. DR Biological Assets
 * (1450) CR Gain on Biological Assets (4550).
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

    const newborn = await tx.Resources.create({ data: { Product_id: mother.Product_id, Resource_type: "BIOLOGICAL_ASSET", Resource_Class: "BIOLOGICAL_ASSET", Resource_Category: "LIVESTOCK", Resources_Quantity: 1, Animal_Tag: tag.trim(), Animal_Sex: sex || null, Growth_Stage: growthStage, Parent_Resources_id: mother.Resources_id, Resources_Manufacture_Date: new Date(), Fair_Value: round2(Number(fairValue)), Fair_Value_Date: new Date(), Fair_Value_Basis: "MARKET_PRICE", Resources_Quality: condition, Resources_Status: "AVAILABLE", Resources_Source: "PRODUCTION", Last_updated: new Date() } });

    const gainValue = round2(Number(fairValue));
    let journal = [];

    if (gainValue > 0) {
      await mustFindOrCreateCatalogue(tx, {
        eventName: "LIVESTOCK_BIRTH",
        description: "A new animal is born — new stock appears with no cash paid, a real IAS 41 fair value gain. DR Biological Assets (1450) CR Gain on Biological Assets (4550).",
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
      await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
      await mustFindOrCreateAccount(tx, "4550", "Gain on Biological Assets", "INCOME", "CREDIT", "OTHER_INCOME", entrepriseId);

      const result = await runCatalogueEvent(tx, {
        eventName: "LIVESTOCK_BIRTH",
        amount: gainValue,
        productId: newborn.Product_id,
        businessUnit,
        administrationId,
        narrativeValues: { Animal_Tag: newborn.Animal_Tag, Parent_Tag: mother.Animal_Tag },
        entrepriseId,
      });
      journal = result.journal;
    }

    await tx.Narrative.create({ data: { Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `Birth — ${newborn.Animal_Tag} born to ${mother.Animal_Tag}${gainValue > 0 ? ` (recorded gain of KES ${gainValue})` : ""}`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId } });

    return { animal: newborn, journal, gainValue };
  });
}

/**
 * recordHarvest — a crop planting matures into a sellable Goods product.
 * Mirror of recordBirth for plants: the planting leaves the individually-
 * tracked register and becomes real inventory. DR Inventory (1100)
 * CR Biological Assets (1450). Updates Resources quantity and derives
 * the output product's unit cost from the harvest value.
 */
async function recordHarvest(input) {
  const { plantingResourcesId, outputProductId, outputQuantity, harvestValue, businessUnit = "FARM", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!plantingResourcesId) throw new PostingError("plantingResourcesId is required");
  if (!outputProductId) throw new PostingError("outputProductId is required");
  if (!outputQuantity || outputQuantity <= 0) throw new PostingError("outputQuantity must be positive");

  return prisma.$transaction(async (tx) => {
    const planting = await tx.Resources.findUnique({ where: { Resources_id: Number(plantingResourcesId) } });
    if (!planting) throw new PostingError("Planting record not found");
    if (planting.Resource_Class !== "BIOLOGICAL_ASSET" || planting.Resource_Category !== "CROP") throw new PostingError("This Resources row isn't a crop register record");
    if (planting.Resources_Status !== "AVAILABLE") throw new PostingError(`This planting is already marked ${planting.Resources_Status} — cannot harvest it twice.`);

    const outputProduct = await tx.Product.findUnique({ where: { Product_id: Number(outputProductId) } });
    if (!outputProduct || outputProduct.Entreprise_id !== entrepriseId) throw new PostingError("Output product not found");

    const priorValue = round2(Number(planting.Fair_Value || 0));
    const finalValue = harvestValue != null ? round2(Number(harvestValue)) : priorValue;
    if (finalValue < 0) throw new PostingError("Harvest value cannot be negative");

    let journal = [];

    if (finalValue > 0) {
      await mustFindOrCreateCatalogue(tx, {
        eventName: "HARVEST",
        description: "A crop planting matures into a sellable Goods product — the planting leaves the individually-tracked register and becomes real inventory. DR Inventory (1100) CR Biological Assets (1450). IAS 41.",
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
      await mustFindOrCreateAccount(tx, "1100", "Inventory", "ASSET", "DEBIT", "CURRENT_ASSET", entrepriseId);
      await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);

      const result = await runCatalogueEvent(tx, {
        eventName: "HARVEST",
        amount: finalValue,
        productId: outputProduct.Product_id,
        businessUnit,
        administrationId,
        narrativeValues: { Animal_Tag: planting.Animal_Tag, Quantity: outputQuantity, Product_Name: outputProduct.Product_Name },
        entrepriseId,
      });
      journal = result.journal;
    }

    await tx.Resources.update({ where: { Resources_id: planting.Resources_id }, data: { Resources_Status: "HARVESTED", Growth_Stage: "HARVESTED", Last_updated: new Date() } });

    const outputResource = await tx.Resources.findFirst({ where: { Product_id: outputProduct.Product_id, Resource_Category: { not: "CROP" } } });
    if (outputResource) {
      await tx.Resources.update({ where: { Resources_id: outputResource.Resources_id }, data: { Resources_Quantity: round2(Number(outputResource.Resources_Quantity) + outputQuantity), Last_updated: new Date() } });
    } else {
      await tx.Resources.create({ data: { Product_id: outputProduct.Product_id, Resource_type: "INVENTORY", Resource_Class: "INVENTORY", Resources_Quantity: outputQuantity, Resources_Status: "AVAILABLE", Resources_Source: "PRODUCTION", Last_updated: new Date() } });
    }

    if (outputQuantity > 0) {
      await tx.Product.update({ where: { Product_id: outputProduct.Product_id }, data: { Product_Cost: round2(finalValue / outputQuantity) } });
    }

    await tx.Narrative.create({ data: { Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `Harvest — ${planting.Animal_Tag} produced ${outputQuantity} ${outputProduct.Product_Name}${finalValue > 0 ? ` (KES ${finalValue})` : ""}`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId } });

    return { journal, finalValue, outputQuantity };
  });
}

// ─── SECTION 2: RENTAL PROPERTY (IAS 40) ─────────────────────────────────────

/**
 * postRentalPropertyPurchase — acquires a rental property as a genuine
 * fixed Asset (reusing postAssetPurchase exactly), then attaches the
 * Tenant and agreed monthly rent. The tenant/rent attachment is a record
 * of the agreement, not a posting — collecting rent is a separate event
 * each time via postUnitIncome, the same discipline as every other
 * recurring arrangement in this system.
 */
async function postRentalPropertyPurchase(input) {
  const { name, cost, usefulLifeYears, residualValue = 0, depreciationMethod = "STRAIGHT_LINE", paymentMethod = "CASH", tenantStakeholderId = null, monthlyRent = null, administrationId = null, businessUnit = "RENTAL", entrepriseId } = input;

  if (tenantStakeholderId) {
    const tenant = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(tenantStakeholderId) } });
    if (!tenant || tenant.Entreprise_id !== entrepriseId) throw new PostingError("Tenant not found for this business");
    if (tenant.Stakeholder_Role !== "Tenant") throw new PostingError('The selected Stakeholder must have Stakeholder_Role = "Tenant"');
  }
  if (monthlyRent != null && Number(monthlyRent) < 0) throw new PostingError("Monthly rent cannot be negative");

  const result = await postAssetPurchase({ name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, administrationId, businessUnit, entrepriseId });

  await prisma.Assets.update({
    where: { Assets_id: result.asset.Assets_id },
    data: { Is_Rental_Property: 1, Tenant_Stakeholder_id: tenantStakeholderId ? Number(tenantStakeholderId) : null, Monthly_Rent: monthlyRent != null ? round2(Number(monthlyRent)) : null },
  });

  return result;
}

/**
 * assignTenant — links (or re-links) an existing rental property to a
 * Tenant and its agreed rent. Genuinely no posting — a change to the
 * agreement on record, not a financial event.
 */
async function assignTenant(input) {
  const { assetsId, tenantStakeholderId, monthlyRent, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!assetsId) throw new PostingError("assetsId is required");

  const assetRow = await prisma.Assets.findUnique({ where: { Assets_id: Number(assetsId) } });
  if (!assetRow) throw new PostingError("Asset not found");
  if (!assetRow.Is_Rental_Property) throw new PostingError("This asset isn't marked as a rental property");

  if (tenantStakeholderId) {
    const tenant = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(tenantStakeholderId) } });
    if (!tenant || tenant.Entreprise_id !== entrepriseId) throw new PostingError("Tenant not found for this business");
    if (tenant.Stakeholder_Role !== "Tenant") throw new PostingError('The selected Stakeholder must have Stakeholder_Role = "Tenant"');
  }
  if (monthlyRent != null && Number(monthlyRent) < 0) throw new PostingError("Monthly rent cannot be negative");

  return prisma.Assets.update({
    where: { Assets_id: assetRow.Assets_id },
    data: { Tenant_Stakeholder_id: tenantStakeholderId ? Number(tenantStakeholderId) : null, Monthly_Rent: monthlyRent != null ? round2(Number(monthlyRent)) : assetRow.Monthly_Rent },
  });
}

/**
 * postBiologicalAssetRevaluation — IAS 41 fair value revaluation. When
 * an animal or crop's market value changes materially (growth, market
 * shift, disease), this posts the gain or loss to the P&L rather than
 * just updating the Resources row silently.
 *
 * recordMonthlyReview updates the Resources.Fair_Value without posting.
 * This function is for when the change is material enough to recognise
 * as income or expense — a calf that was KES 20,000 last month is now
 * KES 35,000 as a yearling, a gain of KES 15,000 that should appear
 * on the income statement.
 *
 * The branch selects REVALUE_BIOLOGICAL_ASSET_UP (gain) or DOWN (loss),
 * the same pattern as postAssetRevaluation.
 */
async function postBiologicalAssetRevaluation(input) {
  const { resourcesId, newFairValue, reason = "", businessUnit = "FARM", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!resourcesId) throw new PostingError("resourcesId is required.");
  if (newFairValue == null || Number(newFairValue) < 0) throw new PostingError("New fair value must be zero or positive.");

  return prisma.$transaction(async (tx) => {
    const record = await tx.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
    if (!record) throw new PostingError("Record not found.");
    if (record.Resource_Class !== "BIOLOGICAL_ASSET") throw new PostingError("This isn't a biological asset.");

    const oldValue = round2(Number(record.Fair_Value || 0));
    const newValue = round2(Number(newFairValue));
    const change = round2(newValue - oldValue);

    if (change === 0) throw new PostingError("No change in fair value — nothing to post.");

    const isGain = change > 0;
    const eventName = isGain ? "REVALUE_BIOLOGICAL_ASSET_UP" : "REVALUE_BIOLOGICAL_ASSET_DOWN";

    if (isGain) {
      await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
      await mustFindOrCreateAccount(tx, "4550", "Gain on Biological Assets", "INCOME", "CREDIT", "OTHER_INCOME", entrepriseId);
    } else {
      await mustFindOrCreateAccount(tx, "5950", "Loss on Biological Assets", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
      await mustFindOrCreateAccount(tx, "1450", "Biological Assets", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
    }

    await mustFindOrCreateCatalogue(tx, {
      eventName,
      description: isGain
        ? "Fair value increase on a biological asset. DR Biological Assets (1450) CR Gain on Biological Assets (4550). IAS 41."
        : "Fair value decrease on a biological asset. DR Loss on Biological Assets (5950) CR Biological Assets (1450). IAS 41.",
      debitCode: isGain ? "1450" : "5950",
      creditCode: isGain ? "4550" : "1450",
      cashFlowCategory: "NONE",
      riskLevel: "MEDIUM",
      cycleType: "FARMING",
      alertRequired: 0,
      narrativeTemplate: isGain
        ? "{Animal_Tag} revalued upward by KES {Amount} to KES {NewValue}."
        : "{Animal_Tag} revalued downward by KES {Amount} to KES {NewValue}.",
      reportSections: isGain
        ? "INCOME_STATEMENT:GainOnBiologicalAssets|BALANCE_SHEET:BiologicalAssets"
        : "INCOME_STATEMENT:LossOnBiologicalAssets|BALANCE_SHEET:BiologicalAssets",
      businessUnit,
      entrepriseId,
    });

    const product = record.Product_id
      ? await tx.Product.findUnique({ where: { Product_id: record.Product_id } })
      : await findOrCreateExpensePlaceholder(tx, "Biological Asset Revaluation", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(Math.abs(change)),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      narrativeValues: { Animal_Tag: record.Animal_Tag, NewValue: newValue },
      entrepriseId,
    });

    await tx.Resources.update({
      where: { Resources_id: record.Resources_id },
      data: { Fair_Value: newValue, Fair_Value_Date: new Date(), Last_updated: new Date() },
    });

    return { transaction: result.transaction, journal: result.journal, oldValue, newValue, change };
  });
}

module.exports = { registerAnimal, bulkPlanting, recordMonthlyReview, recordAnimalLoss, recordBirth, recordHarvest, postSeasonalLabour, postBiologicalAssetRevaluation, postRentalPropertyPurchase, assignTenant };
