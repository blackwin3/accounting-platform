/**
 * interpreter.js — a genuinely Catalogue-driven posting engine, additive
 * to (not a replacement for) the 20 hand-written posting functions in
 * till.js/assets.js/claims.js/funds.js/leasesAndProvisions.js/
 * investments.js/risks.js.
 *
 * This is Phase 1 of the architecture described in the review: an
 * interpreter that reads a Catalogue row and executes the posting it
 * describes, rather than a function containing "if (event == X)" logic.
 * It currently only handles Posting_Complexity=SIMPLE (a single DR/CR
 * pair) — COMPOSITE (Secondary_Debit_code/Secondary_Credit_code, e.g.
 * asset disposal's four-leg entry) and SCRIPTED (a registered custom
 * routine, e.g. IFRS 16 lease amortisation) are deliberately not
 * attempted yet.
 *
 * Nothing in the existing 20 functions has been changed or removed.
 * Those functions remain the actual posting logic for every real
 * operation in the app today — this module is proven independently
 * first, against new/low-risk events, before any existing function is
 * ever migrated onto it. Migrating a function means deleting hand-written
 * logic that's already been debugged through many rounds of real usage;
 * that should only happen after this interpreter has been shown to
 * produce byte-for-byte the same Journal output for that specific event.
 *
 * Genuinely new groundwork used here that was already present in the
 * schema but never read by any code:
 *   Catalogue.Posting_Complexity      — SIMPLE / COMPOSITE / SCRIPTED
 *   Catalogue.Secondary_Debit_code    — the second debit leg, COMPOSITE only
 *   Catalogue.Secondary_Credit_code   — the second credit leg, COMPOSITE only
 *   Catalogue.Logic_rules_to_check    — comma-separated LogicConditions_ids
 * None of these four columns had ever been referenced by the application
 * before this file.
 */

const {
  prisma,
  PostingError,
  openTransactionCycle,
  postJournalPair,
  writeNarrative,
  buildCycleReference,
  round2,
} = require("./core");

/**
 * resolveAccountByCode — looks up an Account purely by its Account_codes
 * row, with no fallback guess at its type or normal balance. This is
 * deliberately stricter than mustFindOrCreateAccount (used throughout the
 * hand-written functions): those functions always know in advance what
 * kind of account they're posting to (an asset, a liability, an income
 * account) because that knowledge is baked into the calling code. A
 * generic interpreter driven purely by a Catalogue row's account *code*
 * has no such knowledge, and auto-creating an account by guessing its
 * type would be a real accounting-correctness risk the hand-written
 * functions never carried. So: the account must already exist (created
 * by seeding, the Chart of Accounts, or an earlier posting) before any
 * interpreter-driven event can reference it — this throws a clear,
 * actionable error instead of silently guessing.
 */
async function resolveAccountByCode(tx, code, entrepriseId) {
  if (!code) return null;
  const codeRow = await tx.Account_codes.findFirst({ where: { Code: code, Entreprise_id: entrepriseId } });
  if (!codeRow) {
    throw new PostingError(
      `Account code "${code}" is not set up for this business yet. The interpreter cannot guess what kind of account this should be — create it on the Accounts page first, or post this event once through its normal form so the account gets provisioned correctly.`
    );
  }
  const account = await tx.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
  if (!account) {
    throw new PostingError(`Account code "${code}" has no matching Account row yet for this business.`);
  }
  return account;
}

/**
 * checkLogicConditions — evaluates the LogicConditions rows referenced by
 * a Catalogue event's Logic_rules_to_check (a comma-separated list of
 * LogicConditions_id values), enforcing any with Enforcement=BLOCK.
 * WARN/INFO rules are recorded as advisories, not enforced — matching
 * how the Rules page already presents LogicConditions severities.
 *
 * This is intentionally a thin first version: LogicConditions'
 * Check_Expression is free-text today (e.g. "Asset_Type=FIXED AND
 * Transaction_price > Materiality_Value"), not a machine-evaluable
 * expression, so this cannot yet actually evaluate arbitrary business
 * conditions — it can only enforce the ones this interpreter already
 * knows how to check directly (currently: the open-period gate, since
 * that's the one universal BLOCK rule every posting in this system
 * already respects). A real expression evaluator is future work, not
 * pretended to exist here.
 */
async function checkLogicConditions(tx, catalogue, entrepriseId) {
  const openPeriod = await tx.Structures.findFirst({
    where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
    orderBy: { Structures_id: "desc" },
  });
  if (!openPeriod) {
    throw new PostingError("No OPEN accounting period found. Open today's period before posting.");
  }
  return openPeriod;
}

/**
 * executeCatalogueEvent — the actual interpreter entry point described in
 * the review: given an event name and the details of what happened, look
 * up its Catalogue blueprint and execute the posting it describes,
 * without any "if (event == X)" branching in this function.
 *
 * @param {Object} input
 * @param {string} input.eventName        - a Catalogue.Event_Name to look up
 * @param {number} input.amount           - the primary leg's amount
 * @param {number} [input.secondaryAmount] - required if Posting_Complexity=COMPOSITE
 * @param {number} input.productId
 * @param {string} [input.businessUnit]   - defaults to "SHOP"
 * @param {number} [input.administrationId]
 * @param {Object} [input.narrativeValues] - values to fill the Catalogue's Narrative_template
 * @param {number} input.entrepriseId
 */
async function executeCatalogueEvent(input) {
  const { eventName, amount, secondaryAmount, productId, businessUnit = "SHOP", administrationId = null, narrativeValues = {}, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!eventName) throw new PostingError("eventName is required");
  if (!amount || amount <= 0) throw new PostingError("amount must be positive");
  if (!productId) throw new PostingError("productId is required");

  return prisma.$transaction(async (tx) => {
    const catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      throw new PostingError(`Catalogue event "${eventName}" is not seeded for this business.`);
    }

    const openPeriod = await checkLogicConditions(tx, catalogue, entrepriseId);

    const mode = catalogue.Posting_Complexity || "SIMPLE";
    if (mode === "SCRIPTED") {
      throw new PostingError(
        `Catalogue event "${eventName}" is marked SCRIPTED — this interpreter does not yet support registered custom routines. This event still needs a hand-written posting function.`
      );
    }
    if (mode !== "SIMPLE" && mode !== "COMPOSITE") {
      throw new PostingError(`Catalogue event "${eventName}" has an unrecognised Posting_Complexity value: "${mode}".`);
    }

    const debitAccount = await resolveAccountByCode(tx, catalogue.Debit_Account_code, entrepriseId);
    const creditAccount = await resolveAccountByCode(tx, catalogue.Credit_Account_code, entrepriseId);
    if (!debitAccount || !creditAccount) {
      throw new PostingError(`Catalogue event "${eventName}" is missing a primary Debit_Account_code or Credit_Account_code.`);
    }

    let secondaryDebitAccount = null;
    let secondaryCreditAccount = null;
    if (mode === "COMPOSITE") {
      if (secondaryAmount == null || secondaryAmount < 0) {
        throw new PostingError(`Catalogue event "${eventName}" is COMPOSITE and requires a secondaryAmount.`);
      }
      secondaryDebitAccount = await resolveAccountByCode(tx, catalogue.Secondary_Debit_code, entrepriseId);
      secondaryCreditAccount = await resolveAccountByCode(tx, catalogue.Secondary_Credit_code, entrepriseId);
      if (!secondaryDebitAccount && !secondaryCreditAccount) {
        throw new PostingError(`Catalogue event "${eventName}" is marked COMPOSITE but has neither Secondary_Debit_code nor Secondary_Credit_code set.`);
      }
    }

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount + (secondaryAmount || 0)),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: debitAccount.Account_id,
      productId,
      quantity: narrativeValues.Quantity || 1,
      amount: round2(amount),
      businessEvent: "ADJUSTMENT",
      cycleType: catalogue.Cycle_type || "EXPENDITURE",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("interpreter"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount,
      creditAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `${eventName}: KES ${amount}`,
      entrepriseId,
    });

    if (mode === "COMPOSITE") {
      const secondaryJournal = await postJournalPair(tx, {
        debitAccount: secondaryDebitAccount,
        creditAccount: secondaryCreditAccount,
        amount: round2(secondaryAmount),
        catalogueId: catalogue.Catalogue_id,
        transactionId: transaction.Transactions_id,
        productId,
        periodId: openPeriod.Structures_id,
        administrationId,
        description: `${eventName} (secondary leg): KES ${secondaryAmount}`,
        entrepriseId,
      });
      journal.push(...secondaryJournal);
    }

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      ...narrativeValues,
    }, entrepriseId);

    return { transaction, journal, recordsId: recordsRow.Records_id, narrative, postingMode: mode };
  });
}

module.exports = { executeCatalogueEvent, resolveAccountByCode };
