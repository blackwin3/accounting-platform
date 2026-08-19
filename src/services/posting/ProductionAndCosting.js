/**
 * ProductionAndCosting.js — merged from processing.js and serviceWip.js.
 * Covers the two ways a business transforms inputs into outputs with a
 * derived cost:
 *
 *   GOODS PROCESSING (postRepackaging) — one or more physical input
 *     products are consumed to produce a different output product, with
 *     an optional spoilage amount. The output's unit cost is derived from
 *     what was actually consumed, not entered by hand. Two real examples:
 *     eggs repackaged into trays (pure reclassification, no cash);
 *     bulk milk into bottles (two inputs, one litre lost to spoilage).
 *
 *   SERVICE WIP (startServiceEngagement / logServiceHours /
 *     billServiceEngagement) — effort-based Services whose value
 *     accumulates over time (carpentry, consulting, repair work). One
 *     Resources row per engagement, logging hours has no cash implication
 *     until the work is actually billed, and billing posts the one real
 *     Journal entry. serviceWip.js's own header notes it "mirrors
 *     livestock.js's shape deliberately" — the production/costing concern
 *     is more specific and the right grouping, since both postRepackaging
 *     and billServiceEngagement are genuinely about moving value from
 *     an input state to an output state with a derived cost.
 *
 * Catalogue migration status:
 *
 *   postRepackaging        — deliberately hand-written: posts 1 output
 *                            debit + N input credits + 1 optional spoilage
 *                            debit across multiple Journal pairs, an
 *                            orchestrator exactly like postBasket. The
 *                            Catalogue row is seeded (REPACKAGE_INVENTORY),
 *                            but forcing this into a SIMPLE or COMPOSITE
 *                            interpreter call would hide the real N-leg
 *                            structure rather than express it honestly.
 *   startServiceEngagement — no Journal posting. Nothing to migrate.
 *   logServiceHours        — no Journal posting. Nothing to migrate.
 *   billServiceEngagement  — migrated onto runCatalogueEvent: a genuine
 *                            SIMPLE single-pair posting with a variable
 *                            payment debit side (Cash/Mobile/Bank/Credit),
 *                            exactly the pattern already proven for
 *                            postFunding, postUnitIncome, and others.
 */

const {
  prisma,
  PostingError,
  mustFindOrCreateAccount,
  mustFindOrCreateCatalogue,
  resolvePaymentAccount,
  openTransactionCycle,
  postJournalPair,
  writeNarrative,
  buildCycleReference,
  round2,
} = require("./core");
const { runCatalogueEvent } = require("./interpreter");

// ─── SECTION 1: GOODS PROCESSING ─────────────────────────────────────────────

/**
 * postRepackaging — consumes one or more input products to produce a
 * quantity of a single output product, with an optional spoilage amount
 * valued against the primary input's unit cost. The output's unit cost
 * is derived from total input value consumed minus spoilage, divided by
 * output quantity — never entered by hand.
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
  if (spoilageQuantity > inputs[0].quantity) throw new PostingError("Spoilage cannot exceed the primary input's quantity consumed.");

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const inputDetails = [];
    for (const line of inputs) {
      const product = await tx.Product.findUnique({ where: { Product_id: Number(line.productId) } });
      if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError(`Input product ${line.productId} not found`);
      const isStockedGood = !product.Is_Service && !product.Is_Utility && !product.Is_Asset;
      let resource = null;
      if (isStockedGood) {
        resource = await tx.Resources.findFirst({ where: { Product_id: product.Product_id } });
        const available = resource ? Number(resource.Resources_Quantity || 0) : 0;
        if (line.quantity > available) throw new PostingError(`Not enough ${product.Product_Name} in stock: ${line.quantity} requested, ${available} available.`);
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
      data: { Catalogue_id: catalogue.Catalogue_id, Records_type: "TRANSACTION_BATCH", Records_date: new Date(), Period_id: openPeriod.Structures_id, Business_Unit: businessUnit, Administration_id: administrationId, Batch_Status: "OPEN", Records_Totals: totalInputValue, Entreprise_id: entrepriseId },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: inventoryAccount.Account_id, productId: outputProduct.Product_id, quantity: outputQuantity, amount: outputValue, businessEvent: "ADJUSTMENT", cycleType: "INVENTORY", businessUnit, recordsId: recordsRow.Records_id, cycleReference: buildCycleReference("repackage"), entrepriseId,
    });

    const journal = [];
    if (outputValue > 0) {
      journal.push(...(await postJournalPair(tx, { debitAccount: inventoryAccount, creditAccount: null, amount: outputValue, catalogueId: catalogue.Catalogue_id, transactionId: transaction.Transactions_id, productId: outputProduct.Product_id, periodId: openPeriod.Structures_id, administrationId, description: `REPACKAGE_INVENTORY: produced ${outputQuantity} ${outputProduct.Product_Name} (unit cost ${outputUnitCost})`, entrepriseId })));
    }
    for (const detail of inputDetails) {
      if (detail.lineValue <= 0) continue;
      journal.push(...(await postJournalPair(tx, { debitAccount: null, creditAccount: inventoryAccount, amount: detail.lineValue, catalogueId: catalogue.Catalogue_id, transactionId: transaction.Transactions_id, productId: detail.product.Product_id, periodId: openPeriod.Structures_id, administrationId, description: `REPACKAGE_INVENTORY: consumed ${detail.quantity} ${detail.product.Product_Name} (unit cost ${detail.unitCost})`, entrepriseId })));
    }
    if (spoilageValue > 0) {
      const spoilageAccount = await mustFindOrCreateAccount(tx, "5940", "Spoilage and Wastage Expense", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
      journal.push(...(await postJournalPair(tx, { debitAccount: spoilageAccount, creditAccount: null, amount: spoilageValue, catalogueId: catalogue.Catalogue_id, transactionId: transaction.Transactions_id, productId: inputDetails[0].product.Product_id, periodId: openPeriod.Structures_id, administrationId, description: `REPACKAGE_INVENTORY: ${spoilageQuantity} ${inputDetails[0].product.Product_Name} spoiled during processing`, entrepriseId })));
    }

    const totalDebit = round2(journal.reduce((s, j) => s + Number(j.Debit || 0), 0));
    const totalCredit = round2(journal.reduce((s, j) => s + Number(j.Credit || 0), 0));
    if (Math.abs(totalDebit - totalCredit) > 0.01) throw new PostingError(`Repackaging entry did not balance (debit ${totalDebit}, credit ${totalCredit}) — posting refused.`);

    for (const detail of inputDetails) {
      if (detail.resource) {
        await tx.Resources.update({ where: { Resources_id: detail.resource.Resources_id }, data: { Resources_Quantity: round2(Number(detail.resource.Resources_Quantity) - detail.quantity), Last_updated: new Date() } });
      }
    }

    const outputResource = await tx.Resources.findFirst({ where: { Product_id: outputProduct.Product_id } });
    if (outputResource) {
      await tx.Resources.update({ where: { Resources_id: outputResource.Resources_id }, data: { Resources_Quantity: round2(Number(outputResource.Resources_Quantity) + outputQuantity), Last_updated: new Date() } });
    } else {
      await tx.Resources.create({ data: { Product_id: outputProduct.Product_id, Resource_type: "INVENTORY", Resource_Class: "INVENTORY", Resources_Quantity: outputQuantity, Resources_Status: "AVAILABLE", Resources_Source: "PRODUCTION", Last_updated: new Date() } });
    }

    await tx.Product.update({ where: { Product_id: outputProduct.Product_id }, data: { Product_Cost: outputUnitCost } });

    const inputSummary = inputDetails.map((d) => `${d.quantity} ${d.product.Product_Name}`).join(" + ");
    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, { InputSummary: inputSummary, Quantity: outputQuantity, Product_Name: outputProduct.Product_Name, SpoilageNote: spoilageQuantity > 0 ? `${spoilageQuantity} ${inputDetails[0].product.Product_Name} lost to spoilage.` : notes }, entrepriseId);

    return { transaction, journal, recordsId: recordsRow.Records_id, outputUnitCost, totalInputValue, spoilageValue, outputValue, narrative };
  });
}

// ─── SECTION 2: SERVICE WORK-IN-PROGRESS ─────────────────────────────────────

/**
 * startServiceEngagement — begins tracking a new piece of effort-based
 * work. Does not post to Journal — starting work has no cash effect
 * until the engagement is billed.
 */
async function startServiceEngagement(input) {
  const { productId, hourlyRate, client, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!productId) throw new PostingError("productId is required — the engagement must belong to a real Service product");
  if (!hourlyRate || Number(hourlyRate) <= 0) throw new PostingError("A positive hourly rate is required");

  const product = await prisma.Product.findUnique({ where: { Product_id: Number(productId) } });
  if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError("Product not found for this business");
  if (!product.Is_Service && product.Product_Nature !== "SERVICE") throw new PostingError("This product isn't marked as a Service — set its type to Services on the Products page.");
  if (product.Is_Utility) throw new PostingError("Utilities have their own instant consumption cycle — work-in-progress is for genuine effort-based services only");

  return prisma.Resources.create({
    data: { Product_id: Number(productId), Resource_type: "WORK_IN_PROGRESS", Resource_Class: "WORK_IN_PROGRESS", Resource_Category: "SERVICE_ENGAGEMENT", Resources_Quantity: 1, Hourly_Rate: round2(Number(hourlyRate)), Hours_Logged: 0, Fair_Value: 0, Fair_Value_Date: new Date(), Fair_Value_Basis: "VALUATION_TECHNIQUE", Service_Client: client || null, Resources_Status: "AVAILABLE", Resources_Source: "PRODUCTION", Last_updated: new Date() },
  });
}

/**
 * logServiceHours — adds hours to an in-progress engagement, recomputing
 * its running value (Fair_Value = Hours_Logged × Hourly_Rate). No Journal
 * posting — logging time has no cash effect until billing.
 */
async function logServiceHours(input) {
  const { resourcesId, hours, note, administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");
  if (!hours || Number(hours) <= 0) throw new PostingError("A positive number of hours is required");

  const engagement = await prisma.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
  if (!engagement) throw new PostingError("Engagement not found");
  if (engagement.Resource_Class !== "WORK_IN_PROGRESS") throw new PostingError("This Resources row isn't a service engagement");
  if (engagement.Resources_Status !== "AVAILABLE") throw new PostingError(`This engagement is already marked ${engagement.Resources_Status} — cannot log more hours against it.`);

  const newHours = round2(Number(engagement.Hours_Logged || 0) + Number(hours));
  const newValue = round2(newHours * Number(engagement.Hourly_Rate || 0));

  const updated = await prisma.Resources.update({ where: { Resources_id: engagement.Resources_id }, data: { Hours_Logged: newHours, Fair_Value: newValue, Fair_Value_Date: new Date(), Last_updated: new Date() } });

  if (note && note.trim()) {
    await prisma.Narrative.create({ data: { Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `Service hours logged — ${Number(hours)}h: ${note.trim()} (running total ${newHours}h, KES ${newValue})`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId } });
  }
  return updated;
}

/**
 * billServiceEngagement — completes the engagement and posts the one
 * real Journal entry: DR Cash/Mobile/Bank/Trade Receivable CR Service
 * Income. Marks the engagement COMPLETE so no further hours can be
 * logged against it. Migrated onto runCatalogueEvent — a genuine SIMPLE
 * single-pair posting, variable payment debit side.
 */
async function billServiceEngagement(input) {
  const { resourcesId, paymentMethod = "CASH", finalAmount = null, businessUnit = "SHOP", administrationId = null, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");

  return prisma.$transaction(async (tx) => {
    const engagement = await tx.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
    if (!engagement) throw new PostingError("Engagement not found");
    if (engagement.Resource_Class !== "WORK_IN_PROGRESS") throw new PostingError("This Resources row isn't a service engagement");
    if (engagement.Resources_Status !== "AVAILABLE") throw new PostingError(`This engagement is already marked ${engagement.Resources_Status} — cannot bill it twice.`);

    const billedAmount = finalAmount != null ? round2(Number(finalAmount)) : round2(Number(engagement.Fair_Value || 0));
    if (billedAmount <= 0) throw new PostingError("Nothing to bill — no hours have been logged and no override amount was given.");

    await mustFindOrCreateCatalogue(tx, {
      eventName: "SERVICE_BILLED",
      description: "A work-in-progress service engagement (hours logged × rate) is billed to the client. DR Cash/Mobile/Bank/Trade Receivable CR Service Income. IFRS 15.",
      debitCode: "1000",
      creditCode: "4400",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "INCOME",
      alertRequired: 0,
      narrativeTemplate: "{Product_Name} billed: {Hours}h at KES {Hourly_Rate}/hr, KES {Amount} total.",
      reportSections: "INCOME_STATEMENT:Service Income",
      businessUnit,
      entrepriseId,
    });

    await mustFindOrCreateAccount(tx, "4400", "Service Income", "INCOME", "CREDIT", "OPERATING_REVENUE", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "SERVICE_BILLED",
      amount: billedAmount,
      productId: engagement.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "receive",
      paymentSide: "debit",
      narrativeValues: {
        Product_Name: (await tx.Product.findUnique({ where: { Product_id: engagement.Product_id } }))?.Product_Name || "Service",
        Hours: Number(engagement.Hours_Logged || 0),
        Hourly_Rate: Number(engagement.Hourly_Rate || 0),
      },
      entrepriseId,
    });

    await tx.Resources.update({ where: { Resources_id: engagement.Resources_id }, data: { Resources_Status: "SOLD", Fair_Value: billedAmount, Fair_Value_Date: new Date(), Last_updated: new Date() } });

    await tx.Narrative.create({ data: { Transaction_id: result.transaction.Transactions_id, Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `Service billed — ${engagement.Hours_Logged}h at KES ${engagement.Hourly_Rate}/hr, KES ${billedAmount} total.${engagement.Service_Client ? " Client: " + engagement.Service_Client : ""}`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId } });

    return { journal: result.journal, billedAmount, hoursLogged: Number(engagement.Hours_Logged || 0) };
  });
}

module.exports = { postRepackaging, startServiceEngagement, logServiceHours, billServiceEngagement, hireTemporaryLabour, logDaysWorked, payTemporaryLabour };

// ─── SECTION 3: TEMPORARY LABOUR REGISTER ────────────────────────────────────
//
// A structured way to record temporary/seasonal workers (planting labour,
// harvest security, day workers) without a full payroll system. Each
// engagement is a Resources row (WORK_IN_PROGRESS, category TEMPORARY_LABOUR)
// tracking who worked, how many days, at what daily rate. Billing posts the
// total as a single salary/labour expense.
//
// This is the honest middle ground between the system's current "post a single
// salary expense with no record of who was paid" and a formal payroll register
// with PAYE/NHIF/NSSF deduction tracking — the latter is Tier 3+ scope.

/**
 * hireTemporaryLabour — registers a named temporary worker for a defined
 * period. Does NOT post to the Journal — starting work has no cash effect
 * until the worker is paid via payTemporaryLabour.
 */
async function hireTemporaryLabour(input) {
  const { stakeholderId = null, workerName, role, dailyRate, startDate = null, businessUnit = "FARM", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!workerName || !workerName.trim()) throw new PostingError("Worker name is required");
  if (!role || !role.trim()) throw new PostingError("Role is required — what this person is hired to do (planting, security, harvesting)");
  if (!dailyRate || Number(dailyRate) <= 0) throw new PostingError("A positive daily rate is required");

  // Create a placeholder Product if one doesn't exist for this role
  let product = await prisma.Product.findFirst({ where: { Product_Name: `Labour: ${role.trim()}`, Entreprise_id: entrepriseId } });
  if (!product) {
    product = await prisma.Product.create({
      data: { Product_Name: `Labour: ${role.trim()}`, Product_type: "Services", Is_Service: 1, Entreprise_id: entrepriseId },
    });
  }

  const engagement = await prisma.Resources.create({
    data: {
      Product_id: product.Product_id,
      Resource_type: "WORK_IN_PROGRESS",
      Resource_Class: "WORK_IN_PROGRESS",
      Resource_Category: "TEMPORARY_LABOUR",
      Resources_Quantity: 1,
      Animal_Tag: workerName.trim(), // reusing Animal_Tag as the worker identifier
      Hourly_Rate: round2(Number(dailyRate)), // daily rate stored in the hourly rate field
      Hours_Logged: 0, // days worked
      Fair_Value: 0,
      Fair_Value_Date: new Date(),
      Service_Client: role.trim(),
      Resources_Manufacture_Date: startDate ? new Date(startDate) : new Date(),
      Resources_Status: "AVAILABLE",
      Resources_Source: "PRODUCTION",
      Last_updated: new Date(),
    },
  });

  if (stakeholderId) {
    const stakeholder = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
    if (stakeholder && stakeholder.Entreprise_id === entrepriseId) {
      await prisma.Resources.update({
        where: { Resources_id: engagement.Resources_id },
        data: { Stakeholder_id: Number(stakeholderId) },
      });
    }
  }

  return engagement;
}

/**
 * logDaysWorked — records days worked by a temporary worker. Updates the
 * running total (Hours_Logged = total days, Fair_Value = days × daily rate).
 * No Journal posting — logging time is an operational record, not a cash event.
 */
async function logDaysWorked(input) {
  const { resourcesId, days, note = "", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");
  if (!days || Number(days) <= 0) throw new PostingError("A positive number of days is required");

  const engagement = await prisma.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
  if (!engagement) throw new PostingError("Engagement not found");
  if (engagement.Resource_Category !== "TEMPORARY_LABOUR") throw new PostingError("This is not a temporary labour engagement");
  if (engagement.Resources_Status !== "AVAILABLE") throw new PostingError(`This engagement is already ${engagement.Resources_Status}`);

  const newDays = round2(Number(engagement.Hours_Logged || 0) + Number(days));
  const newValue = round2(newDays * Number(engagement.Hourly_Rate || 0));

  const updated = await prisma.Resources.update({
    where: { Resources_id: engagement.Resources_id },
    data: { Hours_Logged: newDays, Fair_Value: newValue, Fair_Value_Date: new Date(), Last_updated: new Date() },
  });

  if (note.trim()) {
    await prisma.Narrative.create({
      data: { Narrative_type: "NOTE", Narrative_source: "HUMAN", Narrative_audience: "OWNER", Is_Generated: 0, Description: `${engagement.Animal_Tag}: ${Number(days)} day(s) logged (total ${newDays}d, KES ${newValue}). ${note.trim()}`, Language: "en", Author: administrationId, Narrative_date: new Date(), Entreprise_id: entrepriseId },
    });
  }
  return updated;
}

/**
 * payTemporaryLabour — pays out a temporary worker's accumulated wages.
 * Posts DR Salaries Expense (5200) CR Cash/Mobile/Bank for the total
 * value, marks the engagement PAID, and writes a Narrative recording
 * who was paid, for how many days, at what rate, for what role.
 */
async function payTemporaryLabour(input) {
  const { resourcesId, paymentMethod = "CASH", finalAmount = null, businessUnit = "FARM", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!resourcesId) throw new PostingError("resourcesId is required");

  return prisma.$transaction(async (tx) => {
    const engagement = await tx.Resources.findUnique({ where: { Resources_id: Number(resourcesId) } });
    if (!engagement) throw new PostingError("Engagement not found");
    if (engagement.Resource_Category !== "TEMPORARY_LABOUR") throw new PostingError("This is not a temporary labour engagement");
    if (engagement.Resources_Status !== "AVAILABLE") throw new PostingError(`This engagement is already ${engagement.Resources_Status}`);

    const payAmount = finalAmount != null ? round2(Number(finalAmount)) : round2(Number(engagement.Fair_Value || 0));
    if (payAmount <= 0) throw new PostingError("Nothing to pay — no days have been logged and no override amount was given.");

    await mustFindOrCreateCatalogue(tx, {
      eventName: "PAY_TEMPORARY_LABOUR",
      description: "Pay a temporary/seasonal worker's accumulated wages. DR Salaries Expense (5200) CR Cash/Mobile/Bank.",
      debitCode: "5200",
      creditCode: "1000",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "EXPENDITURE",
      alertRequired: 0,
      narrativeTemplate: "Paid {Worker_Name} for {Days} day(s) at KES {Rate}/day: KES {Amount}. Role: {Role}.",
      reportSections: "INCOME_STATEMENT:Salaries",
      businessUnit,
      entrepriseId,
    });

    await mustFindOrCreateAccount(tx, "5200", "Salaries Expense", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "PAY_TEMPORARY_LABOUR",
      amount: payAmount,
      productId: engagement.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: {
        Worker_Name: engagement.Animal_Tag,
        Days: Number(engagement.Hours_Logged || 0),
        Rate: Number(engagement.Hourly_Rate || 0),
        Role: engagement.Service_Client || "Labour",
      },
      entrepriseId,
    });

    await tx.Resources.update({
      where: { Resources_id: engagement.Resources_id },
      data: { Resources_Status: "SOLD", Fair_Value: payAmount, Last_updated: new Date() },
    });

    return { journal: result.journal, paidAmount: payAmount, workerName: engagement.Animal_Tag, daysWorked: Number(engagement.Hours_Logged || 0) };
  });
}
