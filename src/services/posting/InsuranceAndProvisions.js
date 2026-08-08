/**
 * InsuranceAndProvisions.js — merged from risks.js and the Provisions
 * half of leasesAndProvisions.js. Covers the two ways a business
 * manages exposure to future loss: transferring the risk to an insurer
 * (insurance policies) and self-provisioning against a known, uncertain
 * obligation (IAS 37 provisions).
 *
 * risks.js was previously separate not because insurance and provisions
 * are genuinely different in kind — both represent a present obligation
 * arising from a past event, the difference is only who bears the
 * eventual cost — but because the original file split pre-dated this
 * system's awareness that Risks & Insurance and Provisions were already
 * shown on the same page in the UI. The merge reflects the UI's own
 * grouping honestly.
 *
 * Catalogue migration status per function:
 *
 *   postInsurancePolicy      — does not post to the Journal at all: it
 *                              creates a Money row to register the
 *                              policy. No Catalogue event applies. The
 *                              actual premium payment is a separate
 *                              postExpense(category: "INSURANCE") call,
 *                              which is already Catalogue-based.
 *   closeInsurancePolicy     — a Money row status update. No Journal
 *                              posting, no Catalogue event.
 *   postProvision            — migrated onto runCatalogueEvent: fixed
 *                              Catalogue codes (5930/2300), one Journal
 *                              pair, one Liability side-effect.
 *   postProvisionUtilisation — migrated onto runCatalogueEvent: variable
 *                              payment side (credit), fixed debit (2300),
 *                              with FIFO Liability reduction side-effect
 *                              matching the proven postLoanRepayment and
 *                              postPayableSettlement pattern.
 */

const {
  prisma,
  PostingError,
  resolvePaymentAccount,
  openTransactionCycle,
  writeNarrative,
  buildCycleReference,
  round2,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
  findOrCreateExpensePlaceholder,
} = require("./core");
const { runCatalogueEvent } = require("./interpreter");

// ─── SECTION 1: INSURANCE ────────────────────────────────────────────────────

/**
 * postInsurancePolicy — records a new insurance policy as a Money
 * instrument (Instrument_type=INSURANCE) for coverage and premium
 * tracking. Does not itself move any money — paying the premium is a
 * separate postExpense(category: "INSURANCE") action, which now
 * genuinely links back to this policy via moneyId.
 */
async function postInsurancePolicy(input) {
  const { name, coverageAmount, premiumAmount = null, startDate = null, maturityDate = null, riskLevel = "MEDIUM", riskNote = "", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!name || !name.trim()) throw new PostingError("Policy name is required");
  if (!coverageAmount || coverageAmount <= 0) throw new PostingError("Coverage amount must be positive");
  if (!["LOW", "MEDIUM", "HIGH"].includes(riskLevel)) throw new PostingError('riskLevel must be "LOW", "MEDIUM", or "HIGH"');

  const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
  const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;
  if (!cashAccount) throw new PostingError("Cash account is not seeded for this business yet.");

  const policy = await prisma.Money.create({
    data: {
      Account_id: cashAccount.Account_id,
      Instrument_type: "INSURANCE",
      Money_Status: "ACTIVE",
      Risk_Level: riskLevel,
      Risk_note: riskNote || null,
      Money_Name: name.trim(),
      Principal_amount: round2(coverageAmount),
      Outstanding_Amount: premiumAmount ? round2(premiumAmount) : null,
      Start_date: startDate ? new Date(startDate) : new Date(),
      Maturity_date: maturityDate ? new Date(maturityDate) : null,
      Entreprise_id: entrepriseId,
    },
  });

  return { policy };
}

/**
 * closeInsurancePolicy — marks a policy as CLOSED (lapsed, cancelled,
 * or not renewed). No money moves — any refund is recorded separately
 * via the income functions.
 */
async function closeInsurancePolicy({ moneyId, entrepriseId }) {
  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  const policy = await prisma.Money.findUnique({ where: { Money_id: Number(moneyId) } });
  if (!policy || policy.Entreprise_id !== entrepriseId || policy.Instrument_type !== "INSURANCE") {
    throw new PostingError("Insurance policy not found");
  }
  return prisma.Money.update({ where: { Money_id: policy.Money_id }, data: { Money_Status: "CLOSED" } });
}

/**
 * postInsuranceClaim — the claim settlement path missing from the
 * insurance cycle. When an insurer pays out against a policy, this
 * posts: DR Cash/Mobile/Bank CR Insurance Claim Income. Updates the
 * policy's Settlement_transaction_id so the claim is genuinely linked
 * back to the specific policy it settles, and optionally closes the
 * policy if the claim represents a full settlement.
 *
 * This is a different event from a premium payment (which is an Expense
 * reducing the business's cash) — a claim receipt is genuinely income,
 * classified separately so it doesn't blend with trading income on the
 * P&L and can be queried independently for the insurer's own records.
 *
 * Closes the Tier 2 gap: "insurance claim posting — no claim submission
 * or settlement event at all."
 */
async function postInsuranceClaim(input) {
  const { moneyId, amount, paymentMethod = "BANK", closePolicy = false, notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!moneyId) throw new PostingError("moneyId is required — the claim must be linked to a specific policy.");
  if (!amount || amount <= 0) throw new PostingError("Claim amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" — an insurance claim is always a real cash-equivalent receipt.');

  return prisma.$transaction(async (tx) => {
    const policy = await tx.Money.findUnique({ where: { Money_id: Number(moneyId) } });
    if (!policy || policy.Entreprise_id !== entrepriseId || policy.Instrument_type !== "INSURANCE") {
      throw new PostingError("Insurance policy not found for this business.");
    }
    if (policy.Money_Status === "CLOSED") {
      throw new PostingError("This policy is already CLOSED — cannot record a claim against it.");
    }

    // Seed the Catalogue event for insurance claim receipts — distinct
    // from RECEIVE_RENT_INCOME and other unit-income events so the Cash
    // Flow classification and P&L grouping stay clean.
    await mustFindOrCreateCatalogue(tx, {
      eventName: "INSURANCE_CLAIM_RECEIPT",
      description: "An insurer pays a claim against a specific policy. DR Cash/Mobile/Bank CR Insurance Claim Income (4800). Genuinely income, not a reversal of the premium expense — the premium bought coverage, the claim is the coverage paying out.",
      debitCode: "1000",
      creditCode: "4800",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "INCOME",
      alertRequired: 1,
      narrativeTemplate: "Insurance claim received: KES {Amount} against policy '{Policy_Name}'. {Notes}",
      reportSections: "INCOME_STATEMENT:InsuranceClaimIncome|CASH_FLOW:Operating",
      businessUnit,
      entrepriseId,
    });

    await mustFindOrCreateAccount(tx, "4800", "Insurance Claim Income", "INCOME", "CREDIT", "OTHER_INCOME", entrepriseId);

    const product = await findOrCreateExpensePlaceholder(tx, "Insurance Claim", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "INSURANCE_CLAIM_RECEIPT",
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "receive",
      paymentSide: "debit",
      narrativeValues: { Policy_Name: policy.Money_Name, Notes: notes },
      entrepriseId,
    });

    // Link the claim settlement back to this specific policy — the field
    // was designed for exactly this and was already used by postExpense's
    // moneyId path for premium payments. Using it here closes the claim
    // direction of the same linkage.
    await tx.Money.update({
      where: { Money_id: policy.Money_id },
      data: {
        Settlement_transaction_id: result.transaction.Transactions_id,
        Money_Status: closePolicy ? "SETTLED" : policy.Money_Status,
      },
    });

    return {
      transaction: result.transaction,
      journal: result.journal,
      narrative: result.narrative,
      policyClosed: closePolicy,
    };
  });
}

// ─── SECTION 2: PROVISIONS (IAS 37) ─────────────────────────────────────────

/**
 * postProvision — IAS 37: recognises an estimated obligation at the
 * point it arises. DR Warranty Expense (5930) CR Provision for
 * Warranties (2300). Non-cash — the cash effect only occurs when the
 * claim is actually honoured via postProvisionUtilisation.
 */
async function postProvision(input) {
  const { description = "", amount, administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    await mustFindOrCreateCatalogue(tx, {
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

    await mustFindOrCreateAccount(tx, "5930", "Warranty Expense", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);
    const provisionAccount = await mustFindOrCreateAccount(tx, "2300", "Provision for Warranties", "LIABILITY", "CREDIT", "CURRENT_LIABILITY", entrepriseId);
    const product = await findOrCreateExpensePlaceholder(tx, "Warranty Provision", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "RECORD_PROVISION",
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      narrativeValues: { Notes: description },
      entrepriseId,
    });

    // The Provision needs its own Liability row so postProvisionUtilisation
    // can find it by ID and draw it down correctly — a Catalogue posting
    // alone only writes to Journal, not to the Liability register.
    const liability = await tx.Liability.create({
      data: {
        Catalogue_id: (await tx.Catalogue.findFirst({ where: { Event_Name: "RECORD_PROVISION", Entreprise_id: entrepriseId } })).Catalogue_id,
        Account_id: provisionAccount.Account_id,
        Records_id: result.recordsId,
        Liability_Type: "Warranty Provision",
        Liability_Classification: "CURRENT",
        Net_Amount: round2(amount),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { transaction: result.transaction, journal: result.journal, liability, narrative: result.narrative };
  });
}

/**
 * postProvisionUtilisation — IAS 37: a warranty claim is honoured,
 * drawing down the existing provision. DR Provision for Warranties (2300)
 * CR Cash/Mobile/Bank. No new expense — already booked at
 * postProvision. Reduces the Liability row FIFO, the same pattern as
 * postLoanRepayment and postPayableSettlement.
 */
async function postProvisionUtilisation(input) {
  const { liabilityId, amount, paymentMethod = "CASH", administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!liabilityId) throw new PostingError("liabilityId is required");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    const liability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!liability || liability.Liability_Type !== "Warranty Provision" || liability.Entreprise_id !== entrepriseId) {
      throw new PostingError("Warranty provision not found");
    }

    const outstanding = Number(liability.Net_Amount || 0);
    if (amount > outstanding) throw new PostingError(`Claim (${amount}) exceeds the remaining provision (${outstanding}).`);

    await mustFindOrCreateCatalogue(tx, {
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

    const product = await findOrCreateExpensePlaceholder(tx, "Warranty Claim", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "UTILISE_PROVISION",
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

module.exports = { postInsurancePolicy, closeInsurancePolicy, postInsuranceClaim, postProvision, postProvisionUtilisation };
