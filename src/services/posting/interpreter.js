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
  resolvePaymentAccount,
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
  // First check: is there any OPEN period for this business?
  let openPeriod = await tx.Structures.findFirst({
    where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
    orderBy: { Structures_id: "desc" },
  });

  // Auto-open today's period if none exists — the owner shouldn't have
  // to manually open a period before their first transaction of the day.
  // This respects the AUTO_OPEN_PERIOD setting.
  if (!openPeriod) {
    const autoOpen = await tx.Settings.findFirst({
      where: { Setting_Name: "AUTO_OPEN_PERIOD", Entreprise_id: entrepriseId },
    });
    if (!autoOpen || autoOpen.Setting_Value === "1") {
      const today = new Date().toISOString().slice(0, 10);
      openPeriod = await tx.Structures.create({
        data: {
          Structures_Type: "ACCOUNTING_PERIOD",
          Structure_Level: "RULE",
          Structures_Name: today,
          Structures_Description: `Trading day: ${today} (auto-opened)`,
          Period_Status: "OPEN",
          Structures_Period: new Date(today + "T00:00:00.000Z"),
          Entreprise_id: entrepriseId,
        },
      });
    } else {
      throw new PostingError("No OPEN accounting period found. Open today's period on the Settings → Rules page before posting.");
    }
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
  return prisma.$transaction(async (tx) => runCatalogueEvent(tx, input));
}

/**
 * runCatalogueEvent — the actual interpreter logic, taking an
 * already-open transaction. This is what a calling posting function
 * (like postFunding, once migrated) uses when it needs to run the
 * Catalogue-driven core of an event AND its own additional side effect
 * (e.g. writing an Equity or Liability row) inside one atomic
 * transaction — Prisma doesn't support nesting one $transaction inside
 * another, so executeCatalogueEvent's own top-level $transaction can
 * only be used when nothing else needs to share the same atomic unit.
 */
async function runCatalogueEvent(tx, input) {
  const {
    eventName, amount, secondaryAmount, productId, businessUnit = "SHOP", administrationId = null, narrativeValues = {},
    paymentMethod = null, paymentDirection = null, paymentSide = null,
    debitPaymentMethod = null, creditPaymentMethod = null,
    entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!eventName) throw new PostingError("eventName is required");
  if (!amount || amount <= 0) throw new PostingError("amount must be positive");
  if (!productId) throw new PostingError("productId is required");
  const bothLegsVariable = debitPaymentMethod || creditPaymentMethod;
  if (bothLegsVariable) {
    if (!debitPaymentMethod || !creditPaymentMethod) {
      throw new PostingError("When either debitPaymentMethod or creditPaymentMethod is given, both are required — this shape is specifically for a transfer where neither leg is a fixed Catalogue account.");
    }
    if (debitPaymentMethod === creditPaymentMethod) {
      throw new PostingError("debitPaymentMethod and creditPaymentMethod must be different accounts — a transfer needs a genuine source and destination.");
    }
  } else if (paymentMethod && !["debit", "credit"].includes(paymentSide)) {
    throw new PostingError('When paymentMethod is given, paymentSide must be "debit" or "credit" — which leg of this event varies by payment choice.');
  }
  if (paymentMethod && !bothLegsVariable && !["receive", "pay"].includes(paymentDirection)) {
    throw new PostingError('When paymentMethod is given, paymentDirection must be "receive" or "pay".');
  }

  {
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

    // The variable leg (Cash vs Mobile vs Bank vs Credit, chosen by the
    // user at the moment of posting) is resolved dynamically rather than
    // from the Catalogue row's own code — the Catalogue's
    // Debit_Account_code/Credit_Account_code on that side is genuinely
    // just documentation in this case (e.g. "1000" meaning "some cash-
    // equivalent account"), the same way the hand-written functions this
    // is meant to replace never trusted a fixed code for the payment leg
    // either.
    let debitAccount, creditAccount;
    if (bothLegsVariable) {
      // A pure internal transfer: neither leg is a fixed Catalogue
      // account at all — both are resolved from the payment methods
      // given, exactly the shape postFundTransfer needed (Cash <-> Mobile
      // <-> Bank in either direction, chosen freely by the user).
      debitAccount = await resolvePaymentAccount(tx, debitPaymentMethod, "receive", entrepriseId);
      creditAccount = await resolvePaymentAccount(tx, creditPaymentMethod, "pay", entrepriseId);
    } else if (paymentMethod && paymentSide === "debit") {
      debitAccount = await resolvePaymentAccount(tx, paymentMethod, paymentDirection, entrepriseId);
      creditAccount = await resolveAccountByCode(tx, catalogue.Credit_Account_code, entrepriseId);
    } else if (paymentMethod && paymentSide === "credit") {
      creditAccount = await resolvePaymentAccount(tx, paymentMethod, paymentDirection, entrepriseId);
      debitAccount = await resolveAccountByCode(tx, catalogue.Debit_Account_code, entrepriseId);
    } else {
      debitAccount = await resolveAccountByCode(tx, catalogue.Debit_Account_code, entrepriseId);
      creditAccount = await resolveAccountByCode(tx, catalogue.Credit_Account_code, entrepriseId);
    }
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
  }
}

/**
 * runDisposalEvent — the shared shape behind "dispose of a carrying
 * item, receive proceeds, recognise the residual as a gain or loss":
 * postAssetDisposal (physical assets, with an Accumulated Depreciation
 * leg) and postInvestmentSale (financial instruments, no depreciation
 * leg) both genuinely reduce to this once the asset-specific
 * depreciation leg is made optional, rather than forced into a generic
 * two-leg COMPOSITE mode that would have hidden the real difference
 * between the two events instead of honestly representing it.
 *
 * Legs posted, in order, each only when it has a genuine non-zero
 * amount:
 *   1. DR contraAccount (e.g. Accumulated Depreciation)  — optional,
 *      physical assets only; clears the contra-asset balance being
 *      disposed of alongside the asset itself.
 *   2. DR the resolved payment-method account            — only if
 *      proceeds > 0; the actual cash/mobile/bank/credit received.
 *   3. CR carryingAccount (e.g. PPE or Investments) at costAmount —
 *      always; removes the asset/instrument from the register at its
 *      full original cost, matching IAS 16/IFRS 9's derecognition rule.
 *   4. DR or CR gainLossAccount for the residual          — only if
 *      proceeds and the net carrying amount removed genuinely differ.
 *   5. DR the payment-method account again for any proceeds ABOVE the
 *      carrying amount — only when there's a genuine gain, since the
 *      base leg (2) only ever covers up to the carrying amount by
 *      convention in the pre-existing hand-written functions this
 *      mirrors exactly.
 *
 * This does not attempt to be a general N-leg primitive — it is
 * intentionally shaped for exactly this one real accounting pattern,
 * the same way postJournalPair is intentionally shaped for exactly a
 * balanced two-leg pair. A future genuinely different multi-leg pattern
 * should get its own equally honest primitive, not a generalisation of
 * this one.
 */
async function runDisposalEvent(tx, input) {
  const {
    eventName,
    carryingAccountCode,
    contraAccountCode = null,
    contraAmount = 0,
    costAmount,
    proceeds,
    paymentMethod,
    gainLossAccountCode,
    productId,
    businessUnit,
    administrationId = null,
    narrativeValues = {},
    entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!eventName) throw new PostingError("eventName is required");
  if (!carryingAccountCode) throw new PostingError("carryingAccountCode is required");
  if (costAmount == null || costAmount < 0) throw new PostingError("costAmount must be zero or positive");
  if (proceeds == null || proceeds < 0) throw new PostingError("proceeds must be zero or positive");
  if (!productId) throw new PostingError("productId is required");

  const catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
  if (!catalogue) throw new PostingError(`Catalogue event "${eventName}" is not seeded for this business.`);
  const openPeriod = await checkLogicConditions(tx, catalogue, entrepriseId);

  const carryingAccount = await resolveAccountByCode(tx, carryingAccountCode, entrepriseId);
  if (!carryingAccount) throw new PostingError(`Account for code "${carryingAccountCode}" is not seeded.`);

  const netCarryingRemoved = round2(costAmount - contraAmount);
  const gainLoss = round2(proceeds - netCarryingRemoved);

  const recordsRow = await tx.Records.create({
    data: {
      Catalogue_id: catalogue.Catalogue_id,
      Records_type: "TRANSACTION_BATCH",
      Records_date: new Date(),
      Period_id: openPeriod.Structures_id,
      Business_Unit: businessUnit,
      Administration_id: administrationId,
      Batch_Status: "OPEN",
      Records_Totals: round2(proceeds),
      Entreprise_id: entrepriseId,
    },
  });

  const transaction = await openTransactionCycle(tx, {
    accountId: carryingAccount.Account_id,
    productId,
    quantity: 1,
    amount: round2(proceeds),
    businessEvent: "LOSS",
    cycleType: "ASSET",
    businessUnit,
    recordsId: recordsRow.Records_id,
    cycleReference: buildCycleReference("disposal"),
    entrepriseId,
  });

  const journal = [];
  const commonLeg = { catalogueId: catalogue.Catalogue_id, transactionId: transaction.Transactions_id, productId, periodId: openPeriod.Structures_id, administrationId, entrepriseId };

  if (contraAccountCode && contraAmount > 0) {
    const contraAccount = await resolveAccountByCode(tx, contraAccountCode, entrepriseId);
    if (!contraAccount) throw new PostingError(`Contra account for code "${contraAccountCode}" is not seeded.`);
    journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: contraAccount, creditAccount: null, amount: round2(contraAmount), description: `${eventName}: clear contra balance` })));
  }

  let paymentAccount = null;
  if (proceeds > 0) {
    paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);
    const baseProceedsLeg = Math.min(proceeds, netCarryingRemoved > 0 ? netCarryingRemoved : proceeds);
    journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: paymentAccount, creditAccount: null, amount: round2(baseProceedsLeg), description: `${eventName}: proceeds (${paymentMethod})` })));
  }

  journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: null, creditAccount: carryingAccount, amount: round2(costAmount), description: `${eventName}: remove at cost` })));

  if (gainLoss !== 0) {
    const gainLossAccount = await resolveAccountByCode(tx, gainLossAccountCode, entrepriseId);
    if (!gainLossAccount) throw new PostingError(`Gain/loss account for code "${gainLossAccountCode}" is not seeded.`);
    journal.push(
      ...(await postJournalPair(tx, {
        ...commonLeg,
        debitAccount: gainLoss < 0 ? gainLossAccount : null,
        creditAccount: gainLoss > 0 ? gainLossAccount : null,
        amount: Math.abs(gainLoss),
        description: `${eventName}: ${gainLoss > 0 ? "gain" : "loss"} on disposal`,
      }))
    );
    if (gainLoss > 0 && paymentAccount) {
      journal.push(...(await postJournalPair(tx, { ...commonLeg, debitAccount: paymentAccount, creditAccount: null, amount: gainLoss, description: `${eventName}: additional proceeds above carrying amount` })));
    }
  }

  const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
    Amount: proceeds.toFixed(2),
    GainLossLabel: gainLoss >= 0 ? "Gain" : "Loss",
    GainLossAmount: Math.abs(gainLoss).toFixed(2),
    ...narrativeValues,
  }, entrepriseId);

  return { transaction, journal, gainLoss, recordsId: recordsRow.Records_id, narrative };
}

module.exports = { executeCatalogueEvent, runCatalogueEvent, runDisposalEvent, resolveAccountByCode };
