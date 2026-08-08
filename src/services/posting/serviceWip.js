/**
 * serviceWip.js — work-in-progress tracking for genuine effort-based
 * Services (carpentry, consulting, repair work), distinct from a
 * Utility (electricity, water, internet — already has its own instant
 * consumption cycle and needs none of this) and distinct from a one-off
 * Service bought instantly through the Till (a quick, single-transaction
 * labour charge with no ongoing engagement to track).
 *
 * Mirrors livestock.js's shape deliberately: one Resources row per
 * engagement (Resources_Quantity always 1), logging hours is a routine
 * check-in with no cash implication until the engagement is actually
 * billed, and billing is the one genuinely different event that posts
 * to Journal. Resource_Class=WORK_IN_PROGRESS is the IFRS 15 analogue to
 * livestock's IAS 41 BIOLOGICAL_ASSET classification.
 */

const { prisma, PostingError, mustFindOrCreateAccount, mustFindOrCreateCatalogue, resolvePaymentAccount, openTransactionCycle, postJournalPair, buildCycleReference, round2 } = require("./core");

/**
 * startServiceEngagement — begins tracking a new piece of work. Does not
 * post to Journal — starting work has no cash effect until it's billed.
 */
async function startServiceEngagement(input) {
  const { productId, hourlyRate, client, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!productId) throw new PostingError("productId is required — the engagement must belong to a real Service product");
  if (!hourlyRate || Number(hourlyRate) <= 0) throw new PostingError("A positive hourly rate is required");

  const product = await prisma.Product.findUnique({ where: { Product_id: Number(productId) } });
  if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError("Product not found for this business");
  if (!product.Is_Service) throw new PostingError("This product isn't marked as a Service");
  if (product.Is_Utility) throw new PostingError("Utilities have their own consumption cycle — work-in-progress tracking is for genuine effort-based services, not utilities like internet or electricity");

  return prisma.Resources.create({
    data: {
      Product_id: Number(productId),
      Resource_type: "WORK_IN_PROGRESS",
      Resource_Class: "WORK_IN_PROGRESS",
      Resource_Category: "SERVICE_ENGAGEMENT",
      Resources_Quantity: 1,
      Hourly_Rate: round2(Number(hourlyRate)),
      Hours_Logged: 0,
      Fair_Value: 0,
      Fair_Value_Date: new Date(),
      Fair_Value_Basis: "VALUATION_TECHNIQUE",
      Service_Client: client || null,
      Resources_Status: "AVAILABLE",
      Resources_Source: "PRODUCTION",
      Last_updated: new Date(),
    },
  });
}

/**
 * logServiceHours — adds hours to an in-progress engagement and
 * recomputes its running value (Fair_Value = Hours_Logged x
 * Hourly_Rate). No Journal posting — logging time genuinely has no cash
 * effect until the work is billed, the same reasoning as a livestock
 * Monthly Review recording a condition change with no cash implication.
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

  const updated = await prisma.Resources.update({
    where: { Resources_id: engagement.Resources_id },
    data: { Hours_Logged: newHours, Fair_Value: newValue, Fair_Value_Date: new Date(), Last_updated: new Date() },
  });

  if (note && note.trim()) {
    await prisma.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `Service hours logged — ${Number(hours)}h: ${note.trim()} (running total ${newHours}h, KES ${newValue})`,
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
 * billServiceEngagement — the engagement is complete and genuinely
 * billed to the client. This is the one event in this file that posts
 * to Journal: DR Cash/Mobile/Bank/Trade Receivable CR Service Income,
 * for the accumulated value (Hours_Logged x Hourly_Rate at time of
 * billing, unless overridden). Marks the engagement COMPLETE so no
 * further hours can be logged against it.
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

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found.");

    const product = await tx.Product.findUnique({ where: { Product_id: engagement.Product_id } });
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);
    const serviceIncomeAccount = await mustFindOrCreateAccount(tx, "4400", "Service Income", "INCOME", "CREDIT", "OPERATING_REVENUE", entrepriseId);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "SERVICE_BILLED",
      description: "A work-in-progress service engagement (hours logged x rate) is billed to the client. DR Cash/Mobile/Bank/Trade Receivable CR Service Income.",
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

    const cycleReference = buildCycleReference("service-bill");
    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: engagement.Product_id,
      quantity: round2(Number(engagement.Hours_Logged || 0)),
      amount: billedAmount,
      businessEvent: "SALE",
      cycleType: "INCOME",
      businessUnit,
      recordsId: null,
      cycleReference,
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: paymentAccount,
      creditAccount: serviceIncomeAccount,
      amount: billedAmount,
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: engagement.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `SERVICE BILLED: ${product ? product.Product_Name : "Service"}${engagement.Service_Client ? " — " + engagement.Service_Client : ""}: ${engagement.Hours_Logged}h @ KES ${engagement.Hourly_Rate} (${paymentMethod})`,
      entrepriseId,
    });

    await tx.Resources.update({
      where: { Resources_id: engagement.Resources_id },
      data: { Resources_Status: "SOLD", Fair_Value: billedAmount, Fair_Value_Date: new Date(), Last_updated: new Date() },
    });

    await tx.Narrative.create({
      data: {
        Transaction_id: transaction.Transactions_id,
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "OWNER",
        Is_Generated: 0,
        Description: `Service billed — ${product ? product.Product_Name : "Service"}${engagement.Service_Client ? " for " + engagement.Service_Client : ""}: ${engagement.Hours_Logged}h at KES ${engagement.Hourly_Rate}/hr, KES ${billedAmount} total.`,
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { journal, billedAmount, hoursLogged: Number(engagement.Hours_Logged || 0) };
  });
}

module.exports = { startServiceEngagement, logServiceHours, billServiceEngagement };
