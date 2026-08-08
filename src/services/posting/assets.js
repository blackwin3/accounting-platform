/**
 * assets.js — the fixed-asset lifecycle domain: purchase, disposal,
 * depreciation, and impairment. Matches the Assets page in the app.
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
  findOrCreateExpensePlaceholder,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
} = require("./core");
const { runCatalogueEvent, runDisposalEvent } = require("./interpreter");

/**
 * postAssetPurchase — records a fixed asset purchase (vehicle, equipment).
 * DR Property Plant and Equipment (1400), CR the payment method's account
 * (Cash/Mobile/Bank), or CR Trade Payables if bought on credit. Creates a
 * Product row (Is_Asset=1) so Transactions can reference it, an Assets row
 * for depreciation tracking, and the Journal/Records/Narrative trail.
 *
 * @param {Object} input
 * @param {string} input.name              - asset name, e.g. "Toyota Vitz"
 * @param {number} input.cost              - purchase cost
 * @param {number} input.usefulLifeYears
 * @param {number} [input.residualValue]   - defaults to 0
 * @param {string} [input.depreciationMethod] - defaults to STRAIGHT_LINE
 * @param {"CASH"|"MOBILE"|"BANK"|"CREDIT"} [input.paymentMethod] - defaults to CASH
 * @param {number} [input.administrationId]
 */
async function postAssetPurchase(input) {
  const {
    name,
    cost,
    usefulLifeYears,
    residualValue = 0,
    depreciationMethod = "STRAIGHT_LINE",
    paymentMethod = "CASH",
    ownershipType = "BUSINESS",
    administrationId = null,
    businessUnit = "SHOP",
    entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!name || !name.trim()) throw new PostingError("Asset name is required");
  if (!cost || cost <= 0) throw new PostingError("Cost must be positive");
  if (!usefulLifeYears || usefulLifeYears <= 0) throw new PostingError("Useful life (years) must be positive");
  if (residualValue < 0) throw new PostingError("Residual value cannot be negative");
  if (residualValue >= cost) throw new PostingError("Residual value must be less than cost");
  if (!["BUSINESS", "PERSONAL", "JOINT", "FAMILY"].includes(ownershipType)) {
    throw new PostingError('ownershipType must be "BUSINESS", "PERSONAL", "JOINT", or "FAMILY"');
  }

  return prisma.$transaction(async (tx) => {
    await mustFindOrCreateCatalogue(tx, {
      eventName: "PURCHASE_FIXED_ASSET",
      description: "Purchase of a fixed asset (vehicle, equipment). DR Property Plant and Equipment (1400) CR Cash (1000). Creates an Assets row for depreciation tracking. IAS 16.",
      debitCode: "1400",
      creditCode: "1000",
      cashFlowCategory: "INVESTING",
      riskLevel: "HIGH",
      cycleType: "ASSET",
      alertRequired: 1,
      narrativeTemplate: "Purchased {Product_Name} for KES {Amount}. Useful life {UsefulLife} years, residual value KES {Residual}.",
      reportSections: "BALANCE_SHEET:PPE|ASSET_REGISTER:Addition",
      businessUnit,
      entrepriseId,
    });

    let ppeCodeRow = await tx.Account_codes.findFirst({ where: { Code: "1400", Entreprise_id: entrepriseId } });
    if (!ppeCodeRow) {
      ppeCodeRow = await tx.Account_codes.create({
        data: { Code: "1400", Code_name: "Property Plant and Equipment", Code_categories: "ASSET", Statement_Section: "NON_CURRENT_ASSET", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let ppeAccount = await tx.Account.findFirst({ where: { Account_Code_id: ppeCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!ppeAccount) {
      ppeAccount = await tx.Account.create({
        data: { Account_Name: "Property Plant and Equipment", Account_Type: "ASSET", Account_Code_id: ppeCodeRow.Account_codes_id, Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }

    const product = await tx.Product.create({
      data: {
        Product_Name: name.trim(),
        Product_type: "Asset",
        Product_Price: 0,
        Product_Cost: cost,
        Is_Asset: 1,
        Entreprise_id: entrepriseId,
      },
    });

    const result = await runCatalogueEvent(tx, {
      eventName: "PURCHASE_FIXED_ASSET",
      amount: round2(cost),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: { Product_Name: name.trim(), UsefulLife: usefulLifeYears, Residual: residualValue.toFixed(2) },
      entrepriseId,
    });

    const assetRow = await tx.Assets.create({
      data: {
        Catalogue_id: (await tx.Catalogue.findFirst({ where: { Event_Name: "PURCHASE_FIXED_ASSET", Entreprise_id: entrepriseId } })).Catalogue_id,
        Account_id: ppeAccount.Account_id,
        Records_id: result.recordsId,
        Assets_Type: name.trim(),
        Asset_Classification: "NON_CURRENT",
        Ownership_Type: ownershipType,
        Cost_Amount: round2(cost),
        Residual_Value: round2(residualValue),
        Useful_Life_Years: usefulLifeYears,
        Depreciation_Method: depreciationMethod,
        Accumulated_Depreciation: 0,
        Accumulated_Impairment: 0,
        Carrying_Amount: round2(cost),
        Acquisition_Date: new Date(),
        Placed_In_Service_Date: new Date(),
        Net_Amount: round2(cost),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { transaction: result.transaction, journal: result.journal, asset: assetRow, product, narrative: result.narrative };
  });
}

/**
 * postAssetDisposal — sells or writes off a fixed asset already in the
 * register. Removes the asset at cost, clears its accumulated
 * depreciation, receives proceeds via the chosen payment method (or
 * CREDIT if the buyer hasn't paid yet), and recognises a gain or loss on
 * disposal (proceeds minus carrying amount) — matching IAS 16's disposal
 * treatment.
 */
async function postAssetDisposal(input) {
  const { assetId, proceeds, paymentMethod = "CASH", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!assetId) throw new PostingError("assetId is required");
  if (proceeds == null || proceeds < 0) throw new PostingError("Proceeds must be zero or positive (0 for a write-off)");

  return prisma.$transaction(async (tx) => {
    const asset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetId) } });
    if (!asset || asset.Entreprise_id !== entrepriseId) throw new PostingError("Asset not found");

    const cost = Number(asset.Cost_Amount || 0);
    const accumulatedDepreciation = Number(asset.Accumulated_Depreciation || 0);

    const eventName = "DISPOSE_FIXED_ASSET";
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: "Disposal of a fixed asset. Removes cost and accumulated depreciation from the register, recognises proceeds and any gain or loss on disposal. IAS 16.",
          Debit_Account_code: "1000",
          Credit_Account_code: "1400",
          Cash_Flow_Category: "INVESTING",
          Operational_Impact: "NONE",
          Risk_Level: "MEDIUM",
          Documentation_type: "RECEIPT",
          Report_trigger: "ASSET_REGISTER",
          Escalation_Role: "OWNER",
          Cycle_type: "ASSET",
          Alert_Required: 1,
          Narrative_template: "Disposed of {Product_Name} for KES {Amount}. {GainLossLabel}: KES {GainLossAmount}.",
          Evidence_template: "RECEIPT",
          Report_sections: "BALANCE_SHEET:PPE|ASSET_REGISTER:Disposal|INCOME_STATEMENT:GainLossOnDisposal",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    await mustFindOrCreateAccount(tx, "1400", "Property Plant and Equipment", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);

    let accumDeprCodeRow = await tx.Account_codes.findFirst({ where: { Code: "1410", Entreprise_id: entrepriseId } });
    if (!accumDeprCodeRow) {
      accumDeprCodeRow = await tx.Account_codes.create({
        data: { Code: "1410", Code_name: "Accumulated Depreciation", Code_categories: "ASSET", Statement_Section: "NON_CURRENT_ASSET", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let accumDeprAccount = await tx.Account.findFirst({ where: { Account_Code_id: accumDeprCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!accumDeprAccount) {
      await tx.Account.create({
        data: { Account_Name: "Accumulated Depreciation", Account_Type: "ASSET", Account_Code_id: accumDeprCodeRow.Account_codes_id, Normal_Balance: "CREDIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }

    let gainLossCodeRow = await tx.Account_codes.findFirst({ where: { Code: "4500", Entreprise_id: entrepriseId } });
    const carryingAmount = Number(asset.Carrying_Amount != null ? asset.Carrying_Amount : cost - accumulatedDepreciation);
    const expectedGainLoss = round2(proceeds - carryingAmount);
    if (!gainLossCodeRow) {
      gainLossCodeRow = await tx.Account_codes.create({
        data: {
          Code: "4500",
          Code_name: "Gain/Loss on Disposal of Assets",
          Code_categories: expectedGainLoss >= 0 ? "INCOME" : "EXPENDITURE",
          Statement_Section: "OTHER_INCOME",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }
    let gainLossAccount = await tx.Account.findFirst({ where: { Account_Code_id: gainLossCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!gainLossAccount) {
      await tx.Account.create({
        data: { Account_Name: "Gain/Loss on Disposal of Assets", Account_Type: "INCOME", Account_Code_id: gainLossCodeRow.Account_codes_id, Normal_Balance: "CREDIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }

    const originalRecords = await tx.Records.findUnique({ where: { Records_id: asset.Records_id } });
    const businessUnit = originalRecords ? originalRecords.Business_Unit : "SHOP";

    const productId = (await tx.Product.findFirst({ where: { Product_Name: asset.Assets_Type, Entreprise_id: entrepriseId } }))?.Product_id
      || (await findOrCreateExpensePlaceholder(tx, asset.Assets_Type || "Disposed Asset", entrepriseId)).Product_id;

    const result = await runDisposalEvent(tx, {
      eventName,
      carryingAccountCode: "1400",
      contraAccountCode: accumulatedDepreciation > 0 ? "1410" : null,
      contraAmount: accumulatedDepreciation,
      costAmount: round2(cost),
      proceeds: round2(proceeds),
      paymentMethod,
      gainLossAccountCode: "4500",
      productId,
      businessUnit,
      administrationId,
      narrativeValues: { Product_Name: asset.Assets_Type },
      entrepriseId,
    });

    await tx.Assets.update({
      where: { Assets_id: asset.Assets_id },
      data: {
        Carrying_Amount: 0,
        Accumulated_Depreciation: cost,
        Period_end: new Date(),
      },
    });

    return { transaction: result.transaction, journal: result.journal, gainLoss: result.gainLoss, narrative: result.narrative };
  });
}

/**
 * postDepreciationRun — posts one period's depreciation for a single asset:
 * DR Depreciation Expense (5700), CR Accumulated Depreciation (1410). Not
 * cash — a non-cash allocation of the asset's cost to expense over its
 * useful life (IAS 16). Updates Assets.Accumulated_Depreciation and
 * Carrying_Amount so the register reflects the new balance immediately.
 */
async function postDepreciationRun(input) {
  const { assetId, amount: overrideAmount, administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!assetId) throw new PostingError("assetId is required");

  return prisma.$transaction(async (tx) => {
    const asset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetId) } });
    if (!asset || asset.Entreprise_id !== entrepriseId) throw new PostingError("Asset not found");
    if (asset.Period_end) throw new PostingError("This asset has already been disposed — no further depreciation to post.");
    if (["APPRECIATING", "MARKET_VALUE"].includes(asset.Depreciation_Method)) {
      throw new PostingError('This asset is valued as "' + asset.Depreciation_Method + '" and does not depreciate on a schedule. Use Revalue instead.');
    }

    const cost = Number(asset.Cost_Amount || 0);
    const residual = Number(asset.Residual_Value || 0);
    const usefulLifeYears = Number(asset.Useful_Life_Years || 0);
    const accumulatedSoFar = Number(asset.Accumulated_Depreciation || 0);
    const existingImpairment = Number(asset.Accumulated_Impairment || 0);
    const depreciableBase = cost - residual;

    let amount;
    if (overrideAmount != null) {
      amount = round2(overrideAmount);
    } else if (usefulLifeYears > 0) {
      amount = round2(depreciableBase / usefulLifeYears / 12);
    } else {
      throw new PostingError("Asset has no useful life set — supply an amount explicitly.");
    }
    if (amount <= 0) throw new PostingError("Depreciation amount must be positive");

    const remainingDepreciable = depreciableBase - accumulatedSoFar - existingImpairment;
    if (remainingDepreciable <= 0) {
      throw new PostingError("This asset is already fully depreciated (or impaired) down to its residual value.");
    }
    if (amount > remainingDepreciable) amount = round2(remainingDepreciable);

    const eventName = "RECORD_DEPRECIATION";
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: "Periodic depreciation. DR Depreciation Expense (5700) CR Accumulated Depreciation (1410). Non-cash. IAS 16.",
          Debit_Account_code: "5700",
          Credit_Account_code: "1410",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE",
          Operational_Impact: "NONE",
          Risk_Level: "LOW",
          Documentation_type: "NONE",
          Report_trigger: "ASSET_REGISTER",
          Escalation_Role: "NONE",
          Cycle_type: "ASSET",
          Alert_Required: 0,
          Narrative_template: "Depreciation posted for {Product_Name}: KES {Amount}.",
          Evidence_template: "NONE",
          Report_sections: "INCOME_STATEMENT:DepreciationExpense|BALANCE_SHEET:AccumDepreciation",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    let depCodeRow = await tx.Account_codes.findFirst({ where: { Code: "5700", Entreprise_id: entrepriseId } });
    if (!depCodeRow) {
      depCodeRow = await tx.Account_codes.create({
        data: { Code: "5700", Code_name: "Depreciation Expense", Code_categories: "EXPENDITURE", Statement_Section: "OPERATING_EXPENSE", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let depExpenseAccount = await tx.Account.findFirst({ where: { Account_Code_id: depCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!depExpenseAccount) {
      await tx.Account.create({
        data: { Account_Name: "Depreciation Expense", Account_Type: "EXPENDITURE", Account_Code_id: depCodeRow.Account_codes_id, Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }

    let accumDeprCodeRow = await tx.Account_codes.findFirst({ where: { Code: "1410", Entreprise_id: entrepriseId } });
    if (!accumDeprCodeRow) {
      accumDeprCodeRow = await tx.Account_codes.create({
        data: { Code: "1410", Code_name: "Accumulated Depreciation", Code_categories: "ASSET", Statement_Section: "NON_CURRENT_ASSET", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let accumDeprAccount = await tx.Account.findFirst({ where: { Account_Code_id: accumDeprCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!accumDeprAccount) {
      await tx.Account.create({
        data: { Account_Name: "Accumulated Depreciation", Account_Type: "ASSET", Account_Code_id: accumDeprCodeRow.Account_codes_id, Normal_Balance: "CREDIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }

    const originalRecords = await tx.Records.findUnique({ where: { Records_id: asset.Records_id } });
    const businessUnit = originalRecords ? originalRecords.Business_Unit : "SHOP";

    const product = await tx.Product.findFirst({ where: { Product_Name: asset.Assets_Type, Entreprise_id: entrepriseId } });
    const productId = product ? product.Product_id : (await findOrCreateExpensePlaceholder(tx, asset.Assets_Type || "Depreciation", entrepriseId)).Product_id;

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount,
      productId,
      businessUnit,
      administrationId,
      narrativeValues: { Product_Name: asset.Assets_Type },
      entrepriseId,
    });

    const newAccumulated = round2(accumulatedSoFar + amount);
    const newCarrying = round2(cost - newAccumulated - existingImpairment);
    await tx.Assets.update({
      where: { Assets_id: asset.Assets_id },
      data: { Accumulated_Depreciation: newAccumulated, Carrying_Amount: newCarrying },
    });

    return { transaction: result.transaction, journal: result.journal, amount, newAccumulated, newCarrying, narrative: result.narrative };
  });
}

/**
 * postAssetImpairment — writes down an asset's carrying value due to damage,
 * obsolescence, or a market-value drop, without disposing of it (the asset
 * stays in the register) and without it being a scheduled depreciation
 * charge (IAS 36 impairment, not IAS 16 depreciation). DR Impairment Loss
 * (5921), CR the PPE account directly.
 */
async function postAssetImpairment(input) {
  const { assetId, writeDownAmount, reason = "", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!assetId) throw new PostingError("assetId is required");
  if (!writeDownAmount || writeDownAmount <= 0) throw new PostingError("Write-down amount must be positive");

  return prisma.$transaction(async (tx) => {
    const asset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetId) } });
    if (!asset || asset.Entreprise_id !== entrepriseId) throw new PostingError("Asset not found");
    if (asset.Period_end) throw new PostingError("This asset has already been disposed.");

    const currentCarrying = Number(asset.Carrying_Amount != null ? asset.Carrying_Amount : Number(asset.Cost_Amount || 0) - Number(asset.Accumulated_Depreciation || 0));
    if (writeDownAmount > currentCarrying) {
      throw new PostingError(`Write-down cannot exceed the current carrying amount (KES ${currentCarrying.toFixed(2)}).`);
    }

    const eventName = "RECORD_IMPAIRMENT";
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: "Impairment write-down of a fixed asset's carrying value due to damage, obsolescence, or a drop in recoverable value. DR Impairment Loss (5921) CR PPE (1400). Non-cash. IAS 36.",
          Debit_Account_code: "5921",
          Credit_Account_code: "1400",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE",
          Operational_Impact: "NONE",
          Risk_Level: "MEDIUM",
          Documentation_type: "NONE",
          Report_trigger: "ASSET_REGISTER",
          Escalation_Role: "OWNER",
          Cycle_type: "ASSET",
          Alert_Required: 1,
          Narrative_template: "Impairment recorded for {Product_Name}: KES {Amount} write-down. {Reason}",
          Evidence_template: "NONE",
          Report_sections: "INCOME_STATEMENT:ImpairmentLoss|BALANCE_SHEET:PPE",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    let impairCodeRow = await tx.Account_codes.findFirst({ where: { Code: "5921", Entreprise_id: entrepriseId } });
    if (!impairCodeRow) {
      impairCodeRow = await tx.Account_codes.create({
        data: { Code: "5921", Code_name: "Impairment Loss", Code_categories: "EXPENDITURE", Statement_Section: "OPERATING_EXPENSE", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let impairAccount = await tx.Account.findFirst({ where: { Account_Code_id: impairCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!impairAccount) {
      impairAccount = await tx.Account.create({
        data: { Account_Name: "Impairment Loss", Account_Type: "EXPENDITURE", Account_Code_id: impairCodeRow.Account_codes_id, Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }

    await mustFindOrCreateAccount(tx, "1400", "Property Plant and Equipment", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);

    const originalRecords = await tx.Records.findUnique({ where: { Records_id: asset.Records_id } });
    const businessUnit = originalRecords ? originalRecords.Business_Unit : "SHOP";

    const product = await tx.Product.findFirst({ where: { Product_Name: asset.Assets_Type, Entreprise_id: entrepriseId } });
    const productId = product ? product.Product_id : (await findOrCreateExpensePlaceholder(tx, asset.Assets_Type || "Impairment", entrepriseId)).Product_id;

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(writeDownAmount),
      productId,
      businessUnit,
      administrationId,
      narrativeValues: { Product_Name: asset.Assets_Type, Reason: reason },
      entrepriseId,
    });

    const newAccumulatedImpairment = round2(Number(asset.Accumulated_Impairment || 0) + writeDownAmount);
    const newCarrying = round2(currentCarrying - writeDownAmount);
    await tx.Assets.update({
      where: { Assets_id: asset.Assets_id },
      data: { Accumulated_Impairment: newAccumulatedImpairment, Carrying_Amount: newCarrying },
    });

    return { transaction: result.transaction, journal: result.journal, newCarrying, narrative: result.narrative };
  });
}

/**
 * postAssetRevaluation — adjusts an asset's carrying amount to a new
 * assessed value, for assets that don't follow a depreciation schedule at
 * all: Land (which typically appreciates rather than wears out), and
 * assets like gold, vehicles, or jewellery whose value genuinely tracks a
 * market price rather than a formula (IAS 16's revaluation model, applied
 * pragmatically here as a periodic manual reassessment rather than a
 * formal independent valuation).
 *
 * Distinct from depreciation (a scheduled, predictable allocation of cost)
 * and from impairment (a one-directional write-down for damage or
 * obsolescence) — a revaluation can move the carrying amount up or down,
 * as often as the owner reassesses it, and applies specifically to assets
 * whose Depreciation_Method is "APPRECIATING" or "MARKET_VALUE".
 *
 * An increase posts DR the asset CR Revaluation Surplus (equity, IAS 16's
 * standard treatment for a genuine upward revaluation). A decrease posts
 * DR Revaluation Loss (expense) CR the asset — kept simple rather than
 * netting against a prior surplus balance, which would need per-asset
 * surplus tracking this system does not yet have.
 *
 * @param {Object} input
 * @param {number} input.assetId
 * @param {number} input.newValue   - the newly assessed carrying amount
 * @param {string} [input.reason]   - e.g. "Independent valuation, June 2026" or "Gold spot price update"
 */
async function postAssetRevaluation(input) {
  const { assetId, newValue, reason = "", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!assetId) throw new PostingError("assetId is required");
  if (newValue == null || newValue < 0) throw new PostingError("New value must be zero or positive");

  return prisma.$transaction(async (tx) => {
    const asset = await tx.Assets.findUnique({ where: { Assets_id: Number(assetId) } });
    if (!asset || asset.Entreprise_id !== entrepriseId) throw new PostingError("Asset not found");
    if (asset.Period_end) throw new PostingError("This asset has already been disposed.");
    if (!["APPRECIATING", "MARKET_VALUE"].includes(asset.Depreciation_Method)) {
      throw new PostingError('Revaluation only applies to assets valued as "APPRECIATING" or "MARKET_VALUE" — this asset depreciates on a schedule instead. Use Post Depreciation for it.');
    }

    const currentCarrying = Number(asset.Carrying_Amount != null ? asset.Carrying_Amount : asset.Cost_Amount || 0);
    const change = round2(newValue - currentCarrying);
    if (change === 0) throw new PostingError("New value matches the current carrying amount — nothing to revalue.");

    const isIncrease = change > 0;
    const eventName = isIncrease ? "REVALUE_ASSET_UP" : "REVALUE_ASSET_DOWN";

    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: isIncrease
            ? "Upward revaluation of an appreciating or market-dependent asset (Land, gold, vehicles, jewellery). DR the asset CR Revaluation Surplus (3200, equity). IAS 16 revaluation model."
            : "Downward revaluation of a market-dependent asset. DR Revaluation Loss (5922) CR the asset. IAS 16 revaluation model.",
          Debit_Account_code: isIncrease ? "1400" : "5922",
          Credit_Account_code: isIncrease ? "3200" : "1400",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE",
          Operational_Impact: "NONE",
          Risk_Level: "MEDIUM",
          Documentation_type: "NONE",
          Report_trigger: "ASSET_REGISTER",
          Escalation_Role: "OWNER",
          Cycle_type: "ASSET",
          Alert_Required: 1,
          Narrative_template: isIncrease
            ? "{Product_Name} revalued upward by KES {Amount} to KES {NewValue}. {Reason}"
            : "{Product_Name} revalued downward by KES {Amount} to KES {NewValue}. {Reason}",
          Evidence_template: "NONE",
          Report_sections: isIncrease ? "BALANCE_SHEET:PPE|BALANCE_SHEET:RevaluationSurplus" : "BALANCE_SHEET:PPE|INCOME_STATEMENT:RevaluationLoss",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    let ppeCodeRow = await tx.Account_codes.findFirst({ where: { Code: "1400", Entreprise_id: entrepriseId } });
    if (!ppeCodeRow) throw new PostingError("PPE account (1400) is not seeded.");

    if (isIncrease) {
      let surplusCodeRow = await tx.Account_codes.findFirst({ where: { Code: "3200", Entreprise_id: entrepriseId } });
      if (!surplusCodeRow) {
        surplusCodeRow = await tx.Account_codes.create({
          data: { Code: "3200", Code_name: "Revaluation Surplus", Code_categories: "EQUITY", Statement_Section: "EQUITY", Is_Active: 1, Entreprise_id: entrepriseId },
        });
      }
      let surplusAccount = await tx.Account.findFirst({ where: { Account_Code_id: surplusCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
      if (!surplusAccount) {
        await tx.Account.create({
          data: { Account_Name: "Revaluation Surplus", Account_Type: "EQUITY", Account_Code_id: surplusCodeRow.Account_codes_id, Normal_Balance: "CREDIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
        });
      }
    } else {
      let lossCodeRow = await tx.Account_codes.findFirst({ where: { Code: "5922", Entreprise_id: entrepriseId } });
      if (!lossCodeRow) {
        lossCodeRow = await tx.Account_codes.create({
          data: { Code: "5922", Code_name: "Revaluation Loss", Code_categories: "EXPENDITURE", Statement_Section: "OPERATING_EXPENSE", Is_Active: 1, Entreprise_id: entrepriseId },
        });
      }
      let lossAccount = await tx.Account.findFirst({ where: { Account_Code_id: lossCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
      if (!lossAccount) {
        await tx.Account.create({
          data: { Account_Name: "Revaluation Loss", Account_Type: "EXPENDITURE", Account_Code_id: lossCodeRow.Account_codes_id, Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
        });
      }
    }

    const originalRecords = await tx.Records.findUnique({ where: { Records_id: asset.Records_id } });
    const businessUnit = originalRecords ? originalRecords.Business_Unit : "SHOP";

    const product = await tx.Product.findFirst({ where: { Product_Name: asset.Assets_Type, Entreprise_id: entrepriseId } });
    const productId = product ? product.Product_id : (await findOrCreateExpensePlaceholder(tx, asset.Assets_Type || "Revaluation", entrepriseId)).Product_id;

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: Math.abs(change),
      productId,
      businessUnit,
      administrationId,
      narrativeValues: { Product_Name: asset.Assets_Type, NewValue: newValue.toFixed(2), Reason: reason },
      entrepriseId,
    });

    await tx.Assets.update({
      where: { Assets_id: asset.Assets_id },
      data: { Carrying_Amount: round2(newValue) },
    });

    return { transaction: result.transaction, journal: result.journal, newCarrying: round2(newValue), change, narrative: result.narrative };
  });
}

module.exports = { postAssetPurchase, postAssetDisposal, postDepreciationRun, postAssetImpairment, postAssetRevaluation };
