/**
 * processing.js — the Processing / Repackaging domain: converting one or
 * more input inventory items into a different output product, with
 * spoilage tracked as a real loss. Matches the Organisation > Processing
 * page.
 *
 * Two real examples this was built around:
 *   - Eggs repackaged into trays (a pure repackaging: total value in
 *     equals total value out, no spoilage, no cash movement — just a
 *     different unit of sale).
 *   - Bulk milk (4 x 20-litre jerry cans = 80 litres) repackaged into
 *     1-litre bottles, consuming bottles as a second input (2 bails of
 *     50 = 100 bottles, 79 used), with 1 litre lost to spoilage during
 *     the repack.
 *
 * The output product's cost per unit is DERIVED from what was actually
 * consumed, not entered by hand — (total input value consumed minus
 * spoilage value) divided by output quantity produced. This is what
 * keeps inventory value internally consistent: repackaging eggs into
 * trays with no spoilage changes the eggs' presentation, not their total
 * value; losing a litre of milk to spoilage genuinely reduces the
 * business's asset value by that litre's worth, and that reduction has
 * to leave the books as an expense, not just vanish.
 */

const {
  prisma,
  PostingError,
  openTransactionCycle,
  postJournalPair,
  writeNarrative,
  buildCycleReference,
  round2,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
} = require("./core");

/**
 * postRepackaging — consumes one or more input products (each with its
 * own quantity) to produce a quantity of a single output product, with
 * an optional spoilage amount valued against the primary input's unit
 * cost.
 *
 * @param {Object} input
 * @param {Array<{productId:number, quantity:number}>} input.inputs
 *   - one or more input lines consumed. Each product's current
 *     Product_Cost is used as that line's unit cost.
 * @param {number} input.outputProductId - the product being produced
 * @param {number} input.outputQuantity  - how much of the output was produced
 * @param {number} [input.spoilageQuantity] - quantity of the PRIMARY
 *   input (inputs[0]) lost during processing, valued at that input's
 *   unit cost. Defaults to 0 — most repackaging has none.
 * @param {string} [input.notes]
 * @param {number} [input.administrationId]
 */
async function postRepackaging(input) {
  const { inputs, outputProductId, outputQuantity, spoilageQuantity = 0, notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!Array.isArray(inputs) || inputs.length === 0) throw new PostingError("At least one input product is required");
  for (const line of inputs) {
    if (!line.productId) throw new PostingError("Each input requires productId");
    if (!line.quantity || line.quantity <= 0) throw new PostingError("Each input requires a positive quantity");
  }
  if (!outputProductId) throw new PostingError("outputProductId is required");
  if (!outputQuantity || outputQuantity <= 0) throw new PostingError("outputQuantity must be positive");
  if (spoilageQuantity < 0) throw new PostingError("spoilageQuantity cannot be negative");
  if (spoilageQuantity > inputs[0].quantity) {
    throw new PostingError("Spoilage cannot exceed the primary input's quantity consumed.");
  }

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    // Resolve every input product, its Resources row (for both cost and
    // stock-sufficiency — Goods only), and the output product. Services
    // (e.g. Labour) and Assets have no physical Resources_Quantity to
    // check or decrement — a service is consumed the moment it's
    // incurred, not held as stock — but their cost still genuinely
    // contributes to the output's derived unit cost, which is the actual
    // point of allowing them as inputs (labour as a factored cost when
    // building a new inventory item or asset, e.g. wood + labour into a
    // finished construction product).
    const inputDetails = [];
    for (const line of inputs) {
      const product = await tx.Product.findUnique({ where: { Product_id: Number(line.productId) } });
      if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError(`Input product ${line.productId} not found`);

      const isStockedGood = !product.Is_Service && !product.Is_Utility && !product.Is_Asset;
      let resource = null;
      if (isStockedGood) {
        resource = await tx.Resources.findFirst({ where: { Product_id: product.Product_id } });
        const available = resource ? Number(resource.Resources_Quantity || 0) : 0;
        if (line.quantity > available) {
          throw new PostingError(`Not enough ${product.Product_Name} in stock to process: ${line.quantity} requested, ${available} available.`);
        }
      }
      const unitCost = Number(product.Product_Cost || 0);
      inputDetails.push({ product, resource, quantity: line.quantity, unitCost, lineValue: round2(line.quantity * unitCost), isStockedGood });
    }

    const outputProduct = await tx.Product.findUnique({ where: { Product_id: Number(outputProductId) } });
    if (!outputProduct || outputProduct.Entreprise_id !== entrepriseId) throw new PostingError("Output product not found");

    const totalInputValue = round2(inputDetails.reduce((sum, d) => sum + d.lineValue, 0));
    const spoilageValue = round2(spoilageQuantity * inputDetails[0].unitCost);
    const outputValue = round2(totalInputValue - spoilageValue);
    if (outputValue < 0) throw new PostingError("Spoilage value cannot exceed the total value of inputs consumed.");
    const outputUnitCost = round2(outputValue / outputQuantity);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "REPACKAGE_INVENTORY",
      description: "Convert one or more input products into a different output product. DR Output Inventory (and Spoilage Expense, if any) CR each input's Inventory account, at that input's own cost. No cash movement — a pure reclassification of inventory value, with any spoilage leaving the books as a real expense.",
      debitCode: "1100",
      creditCode: "1100",
      cashFlowCategory: "NONE",
      riskLevel: "LOW",
      cycleType: "INVENTORY",
      alertRequired: 0,
      narrativeTemplate: "Repackaged {InputSummary} into {Quantity} {Product_Name}. {SpoilageNote}",
      reportSections: "BALANCE_SHEET:Inventory",
      businessUnit,
      entrepriseId,
    });

    const inventoryAccount = await mustFindOrCreateAccount(tx, "1100", "Inventory", "ASSET", "DEBIT", "CURRENT_ASSET", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: totalInputValue,
        Entreprise_id: entrepriseId,
      },
    });

    const cycleReference = buildCycleReference("repackage");

    const transaction = await openTransactionCycle(tx, {
      accountId: inventoryAccount.Account_id,
      productId: outputProduct.Product_id,
      quantity: outputQuantity,
      amount: outputValue,
      businessEvent: "ADJUSTMENT",
      cycleType: "INVENTORY",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference,
      entrepriseId,
    });

    const journal = [];

    // DR Output Inventory for the value actually carried forward (total
    // input value minus spoilage) — Inventory is both the debit and
    // credit account here (a genuine self-transfer), so this posts as
    // one leg per input plus one leg for the output, all against the
    // same underlying account, individually itemised in the description
    // rather than netted into a single meaningless "Inventory to
    // Inventory" line.
    if (outputValue > 0) {
      journal.push(
        ...(await postJournalPair(tx, {
          debitAccount: inventoryAccount,
          creditAccount: null,
          amount: outputValue,
          catalogueId: catalogue.Catalogue_id,
          transactionId: transaction.Transactions_id,
          productId: outputProduct.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `REPACKAGE_INVENTORY: produced ${outputQuantity} ${outputProduct.Product_Name} (unit cost ${outputUnitCost})`,
          entrepriseId,
        }))
      );
    }

    // CR each input's Inventory value, at that input's own cost
    for (const detail of inputDetails) {
      if (detail.lineValue <= 0) continue;
      journal.push(
        ...(await postJournalPair(tx, {
          debitAccount: null,
          creditAccount: inventoryAccount,
          amount: detail.lineValue,
          catalogueId: catalogue.Catalogue_id,
          transactionId: transaction.Transactions_id,
          productId: detail.product.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `REPACKAGE_INVENTORY: consumed ${detail.quantity} ${detail.product.Product_Name} (unit cost ${detail.unitCost})`,
          entrepriseId,
        }))
      );
    }

    // DR Spoilage/Wastage Expense for anything genuinely lost — this is
    // the leg that keeps the double-entry balanced: total input value
    // consumed (CR legs above) must equal output value (DR) plus
    // spoilage (DR), with nothing silently disappearing.
    if (spoilageValue > 0) {
      const spoilageAccount = await mustFindOrCreateAccount(tx, "5940", "Spoilage and Wastage Expense", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
      journal.push(
        ...(await postJournalPair(tx, {
          debitAccount: spoilageAccount,
          creditAccount: null,
          amount: spoilageValue,
          catalogueId: catalogue.Catalogue_id,
          transactionId: transaction.Transactions_id,
          productId: inputDetails[0].product.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `REPACKAGE_INVENTORY: ${spoilageQuantity} ${inputDetails[0].product.Product_Name} spoiled during processing`,
          entrepriseId,
        }))
      );
    }

    // Confirm the whole batch is genuinely balanced before touching any
    // stock quantities — a defensive check, since a bug in the legs
    // above should never silently corrupt inventory levels.
    const totalDebit = round2(journal.reduce((s, j) => s + Number(j.Debit || 0), 0));
    const totalCredit = round2(journal.reduce((s, j) => s + Number(j.Credit || 0), 0));
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new PostingError(`Repackaging entry did not balance internally (debit ${totalDebit}, credit ${totalCredit}) — posting refused.`);
    }

    // Now adjust physical stock: decrement every input, increment the output.
    for (const detail of inputDetails) {
      if (detail.resource) {
        await tx.Resources.update({
          where: { Resources_id: detail.resource.Resources_id },
          data: { Resources_Quantity: round2(Number(detail.resource.Resources_Quantity) - detail.quantity), Last_updated: new Date() },
        });
      }
    }

    const outputResource = await tx.Resources.findFirst({ where: { Product_id: outputProduct.Product_id } });
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

    // The output's cost basis is derived from what was actually
    // consumed, not entered by hand — this is what keeps inventory value
    // internally consistent across a repackaging run.
    await tx.Product.update({
      where: { Product_id: outputProduct.Product_id },
      data: { Product_Cost: outputUnitCost },
    });

    const inputSummary = inputDetails.map((d) => `${d.quantity} ${d.product.Product_Name}`).join(" + ");
    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      InputSummary: inputSummary,
      Quantity: outputQuantity,
      Product_Name: outputProduct.Product_Name,
      SpoilageNote: spoilageQuantity > 0 ? `${spoilageQuantity} ${inputDetails[0].product.Product_Name} lost to spoilage.` : notes,
    }, entrepriseId);

    return {
      transaction,
      journal,
      recordsId: recordsRow.Records_id,
      outputUnitCost,
      totalInputValue,
      spoilageValue,
      outputValue,
      narrative,
    };
  });
}

module.exports = { postRepackaging };
