/**
 * funds.js — the Funds domain: money coming into the business from the
 * owner or a lender, and income that isn't tied to selling stocked goods
 * (rent, bond interest, dividends). Matches the Money > Funds page.
 */

const {
  prisma,
  PostingError,
  PAYMENT_METHODS,
  resolvePaymentAccount,
  openTransactionCycle,
  postJournalPair,
  writeNarrative,
  buildCycleReference,
  round2,
  findOrCreateExpensePlaceholder,
  mustFindOrCreateAccount,
  computeAccountBalance,
} = require("./core");
const { runCatalogueEvent } = require("./interpreter");

const INCOME_TYPES = {
  RENT: { label: "Rental Income", code: "4100" },
  INTEREST: { label: "Interest Income", code: "4200" },
  DIVIDEND: { label: "Dividend Income", code: "4300" },
};

/**
 * postFundTransfer — moves money between the business's own Cash, Mobile
 * Money, and Bank accounts. Distinct from postFunding: this never brings
 * money in from outside the business (no Equity or Liability leg) — it's
 * purely DR destination account, CR source account, the same amount on
 * both sides, since the money already belonged to the business either way.
 *
 * This is the actual capability behind "top up a low account" — e.g.
 * moving KES 5,000 from Bank into Mobile Money so a mobile-paid utility
 * bill can be settled, without that being confused with a fresh capital
 * injection or loan.
 *
 * @param {Object} input
 * @param {"CASH"|"MOBILE"|"BANK"} input.from
 * @param {"CASH"|"MOBILE"|"BANK"} input.to
 * @param {number} input.amount
 * @param {string} [input.notes]
 */
async function postFundTransfer(input) {
  const { from, to, amount, notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!["CASH", "MOBILE", "BANK"].includes(from)) throw new PostingError('from must be "CASH", "MOBILE", or "BANK"');
  if (!["CASH", "MOBILE", "BANK"].includes(to)) throw new PostingError('to must be "CASH", "MOBILE", or "BANK"');
  if (from === to) throw new PostingError("Transfer source and destination must be different accounts.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    const fromAccount = await resolvePaymentAccount(tx, from, "pay", entrepriseId);

    // Current_Balance is never kept in sync by any posting function in this
    // engine — the real balance is always the live Journal sum, the same
    // source of truth the Ledger and Accounts pages already use. Reading
    // Current_Balance here (as the first version of this function did) made
    // every transfer fail with "insufficient funds" regardless of the
    // account's actual activity, since that column is permanently 0.
    const sourceBalance = await computeAccountBalance(tx, fromAccount.Account_id, "DEBIT");
    if (amount > sourceBalance) {
      throw new PostingError(`Transfer amount (KES ${amount}) exceeds the current ${fromAccount.Account_Name} balance (KES ${sourceBalance.toFixed(2)}).`);
    }

    const eventName = "FUND_TRANSFER";
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: "Move money between the business's own Cash/Mobile Money/Bank accounts. Not a capital injection or loan — no Equity or Liability leg, just DR destination CR source for the same amount.",
          Debit_Account_code: null, // varies by direction — resolved via debitPaymentMethod/creditPaymentMethod, not a fixed Catalogue code
          Credit_Account_code: null,
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE", // nets to zero for the business as a whole — not a real inflow or outflow
          Operational_Impact: "NONE",
          Risk_Level: "LOW",
          Documentation_type: "NONE",
          Report_trigger: "CASH_FLOW",
          Escalation_Role: "NONE",
          Cycle_type: "CAPITAL",
          Alert_Required: 0,
          Narrative_template: "Transferred KES {Amount} from {From} to {To}. {Notes}",
          Evidence_template: "NONE",
          Report_sections: "BALANCE_SHEET:Cash",
          Default_Business_Unit: businessUnit,
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const product = await findOrCreateExpensePlaceholder(tx, "Fund Transfer", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      debitPaymentMethod: to,
      creditPaymentMethod: from,
      narrativeValues: { From: fromAccount.Account_Name, To: PAYMENT_METHODS[to] ? PAYMENT_METHODS[to].label : to, Notes: notes },
      entrepriseId,
    });

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative };
  });
}

/**
 * postFunding — records money coming into the business from the owner
 * (capital injection) or a lender (loan drawdown). DR the receiving
 * payment method's account (Cash/Mobile/Bank), CR Owner Capital (3000)
 * or Loan Payable (2100).
 */
async function postFunding(input) {
  const { source, amount, paymentMethod = "CASH", notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (source !== "CAPITAL" && source !== "LOAN") throw new PostingError('source must be "CAPITAL" or "LOAN"');
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" for funding');

  const creditCode = source === "CAPITAL" ? "3000" : "2100";
  const creditLabel = source === "CAPITAL" ? "Owner Capital" : "Loan Payable";
  const eventName = source === "CAPITAL" ? "OWNER_CAPITAL_INJECTION" : "LOAN_DRAWDOWN";

  return prisma.$transaction(async (tx) => {
    // Ensure the Catalogue event exists before the interpreter looks for
    // it — the interpreter deliberately never auto-creates a Catalogue
    // row itself (that's a real business decision about what accounting
    // events exist, not something an interpreter should invent), so
    // seeding it here, once, on first use, is still this function's job.
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: `${creditLabel} received. DR payment method account CR ${creditLabel} (${creditCode}).`,
          Debit_Account_code: "1000",
          Credit_Account_code: creditCode,
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "FINANCING",
          Operational_Impact: "NONE",
          Risk_Level: source === "LOAN" ? "MEDIUM" : "LOW",
          Documentation_type: source === "LOAN" ? "LOAN_AGREEMENT" : "NONE",
          Report_trigger: "CASH_FLOW",
          Escalation_Role: "OWNER",
          Cycle_type: source === "LOAN" ? "LOAN" : "INCOME",
          Alert_Required: source === "LOAN" ? 1 : 0,
          Narrative_template: `Received KES {Amount} as ${creditLabel.toLowerCase()}. {Notes}`,
          Evidence_template: source === "LOAN" ? "LOAN_AGREEMENT" : "NONE",
          Report_sections: `CASH_FLOW:Financing|BALANCE_SHEET:${creditLabel.replace(" ", "")}`,
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    // The credit-side account (Owner Capital or Loan Payable) still
    // needs to genuinely exist before the interpreter can resolve it by
    // code — resolveAccountByCode deliberately refuses to auto-create,
    // by design (see interpreter.js), so this function still owns
    // provisioning its own domain-specific account, same as before.
    let creditCodeRow = await tx.Account_codes.findFirst({ where: { Code: creditCode, Entreprise_id: entrepriseId } });
    if (!creditCodeRow) {
      const def = source === "CAPITAL"
        ? { name: "Owner Capital", category: "EQUITY", section: "EQUITY" }
        : { name: "Loan Payable", category: "LIABILITY", section: "NON_CURRENT_LIABILITY" };
      creditCodeRow = await tx.Account_codes.create({
        data: { Code: creditCode, Code_name: def.name, Code_categories: def.category, Statement_Section: def.section, Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let creditAccount = await tx.Account.findFirst({ where: { Account_Code_id: creditCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!creditAccount) {
      creditAccount = await tx.Account.create({
        data: {
          Account_Name: creditLabel,
          Account_Type: source === "CAPITAL" ? "EQUITY" : "LIABILITY",
          Account_Code_id: creditCodeRow.Account_codes_id,
          Normal_Balance: "CREDIT",
          Current_Balance: 0,
          Authoritative_Source: "JOURNAL",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }

    const product = await findOrCreateExpensePlaceholder(tx, creditLabel, entrepriseId);

    // The actual posting — this is the genuine migration. Everything
    // that used to be hand-written here (resolving the OPEN period,
    // resolving the payment-method account, creating the Records row,
    // opening the Transaction cycle, posting the balanced Journal pair,
    // writing the narrative) is now the interpreter's job, driven
    // entirely by the Catalogue row seeded above.
    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "receive",
      paymentSide: "debit",
      narrativeValues: { Notes: notes },
      entrepriseId,
    });

    if (source === "CAPITAL") {
      // NOTE: Equity has no Entreprise_id column yet — missing from the
      // original multi-tenancy migration. Left unscoped here deliberately
      // rather than silently working around it; needs a follow-up migration.
      await tx.Equity.create({
        data: {
          Catalogue_id: catalogue.Catalogue_id,
          Account_id: creditAccount.Account_id,
          Records_id: result.recordsId,
          Equity_type: "Owner Capital",
          Net_Amount: round2(amount),
          Period: new Date(),
        },
      });
    } else {
      await tx.Liability.create({
        data: {
          Catalogue_id: catalogue.Catalogue_id,
          Account_id: creditAccount.Account_id,
          Records_id: result.recordsId,
          Liability_Type: "Loan",
          Liability_Classification: "NON_CURRENT",
          Net_Amount: round2(amount),
          Period: new Date(),
          Entreprise_id: entrepriseId,
        },
      });
    }

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative };
  });
}

/**
 * postUnitIncome — records income that isn't tied to selling a stocked
 * product: rent collected, bond coupon interest, or dividends. DR the
 * payment method's account (Cash/Mobile/Bank), or DR Trade Receivables if
 * the income is owed but not yet collected. CR the matching income
 * account. No inventory, no COGS.
 */
async function postUnitIncome(input) {
  const { incomeType, amount, paymentMethod = "CASH", notes = "", stakeholderId = null, moneyId = null, administrationId = null, businessUnit, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  const incomeDef = INCOME_TYPES[incomeType];
  if (!incomeDef) throw new PostingError(`Unknown income type "${incomeType}"`);
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!businessUnit) throw new PostingError("businessUnit is required");

  return prisma.$transaction(async (tx) => {
    const eventName = `RECEIVE_${incomeType}_INCOME`;
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: `${incomeDef.label} received. DR payment method account CR ${incomeDef.label} (${incomeDef.code}).`,
          Debit_Account_code: "1000",
          Credit_Account_code: incomeDef.code,
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "OPERATING",
          Operational_Impact: "NONE",
          Risk_Level: "LOW",
          Documentation_type: incomeType === "RENT" ? "RECEIPT" : "BANK_STATEMENT",
          Report_trigger: "CASH_FLOW",
          Escalation_Role: "NONE",
          Cycle_type: incomeType === "RENT" ? "RENT" : "INVESTMENT",
          Alert_Required: 0,
          Narrative_template: `Received KES {Amount} in ${incomeDef.label.toLowerCase()}. {Notes}`,
          Evidence_template: incomeType === "RENT" ? "RECEIPT" : "BANK_STATEMENT",
          Report_sections: `INCOME_STATEMENT:${incomeDef.label}|CASH_FLOW:Operating`,
          Default_Business_Unit: businessUnit,
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    let incomeCodeRow = await tx.Account_codes.findFirst({ where: { Code: incomeDef.code, Entreprise_id: entrepriseId } });
    if (!incomeCodeRow) {
      incomeCodeRow = await tx.Account_codes.create({
        data: { Code: incomeDef.code, Code_name: incomeDef.label, Code_categories: "INCOME", Statement_Section: "OTHER_INCOME", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let incomeAccount = await tx.Account.findFirst({ where: { Account_Code_id: incomeCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!incomeAccount) {
      incomeAccount = await tx.Account.create({
        data: {
          Account_Name: incomeDef.label,
          Account_Type: "INCOME",
          Account_Code_id: incomeCodeRow.Account_codes_id,
          Normal_Balance: "CREDIT",
          Current_Balance: 0,
          Authoritative_Source: "JOURNAL",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }

    const product = await findOrCreateExpensePlaceholder(tx, incomeDef.label, entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "receive",
      paymentSide: "debit",
      narrativeValues: { Notes: notes },
      entrepriseId,
    });

    await tx.Income.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: incomeAccount.Account_id,
        Records_id: result.recordsId,
        Transactions_id: result.transaction.Transactions_id,
        Income_type: incomeDef.label,
        Income_Category: incomeType === "RENT" ? "RENTAL" : incomeType === "INTEREST" ? "INTEREST" : "DIVIDEND",
        Business_Unit: businessUnit,
        Net_Amount: round2(amount),
        Cash_Received: paymentMethod === "CREDIT" ? 0 : round2(amount),
        Outstanding_Amount: paymentMethod === "CREDIT" ? round2(amount) : 0,
        Period_id: result.transaction.Period_id,
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    if (moneyId) {
      const moneyRow = await tx.Money.findUnique({ where: { Money_id: moneyId } });
      if (moneyRow && moneyRow.Entreprise_id === entrepriseId) {
        await tx.Money.update({
          where: { Money_id: moneyId },
          data: { Settlement_transaction_id: result.transaction.Transactions_id },
        });
      }
    }

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative };
  });
}

/**
 * postCapitalWithdrawal — the owner takes capital back out of the
 * business. DR Owner Capital CR Cash/Mobile/Bank. Genuinely the reverse
 * of postFunding's CAPITAL path, and the real gap this system had no
 * way to record before: money could go in as capital, but never come
 * back out. Refuses to withdraw more than the owner has actually put in
 * — computed live from Equity's own Journal-derived balance, the same
 * "never trust a stored running total" discipline this system uses
 * everywhere else.
 */
async function postCapitalWithdrawal(input) {
  const { amount, paymentMethod = "CASH", notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" — a withdrawal is an actual cash-equivalent payment.');

  return prisma.$transaction(async (tx) => {
    const eventName = "OWNER_CAPITAL_WITHDRAWAL";
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: "Owner withdraws capital previously injected. DR Owner Capital (3000) CR payment method account.",
          Debit_Account_code: "3000",
          Credit_Account_code: "1000",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "FINANCING",
          Operational_Impact: "NONE",
          Risk_Level: "MEDIUM",
          Documentation_type: "NONE",
          Report_trigger: "CASH_FLOW",
          Escalation_Role: "OWNER",
          Cycle_type: "CAPITAL",
          Alert_Required: 1,
          Narrative_template: "Owner withdrew KES {Amount} in capital. {Notes}",
          Evidence_template: "NONE",
          Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:OwnerCapital",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const ownerCapitalAccount = await mustFindOrCreateAccount(tx, "3000", "Owner Capital", "EQUITY", "CREDIT", "EQUITY", entrepriseId);
    const capitalInjected = await computeAccountBalance(tx, ownerCapitalAccount.Account_id, "CREDIT");
    if (round2(amount) > round2(capitalInjected)) {
      throw new PostingError(`Cannot withdraw KES ${round2(amount)} — only KES ${round2(capitalInjected)} of capital has genuinely been injected and not yet withdrawn.`);
    }

    const product = await findOrCreateExpensePlaceholder(tx, "Owner Capital", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(amount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: { Notes: notes },
      entrepriseId,
    });

    await tx.Equity.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: ownerCapitalAccount.Account_id,
        Records_id: result.recordsId,
        Equity_type: "Owner Capital Withdrawal",
        Net_Amount: round2(-amount), // negative — reduces the capital balance when summed alongside injections
        Period: new Date(),
      },
    });

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative };
  });
}

/**
 * postLoanRepayment — the business pays down an outstanding loan. DR
 * Loan Payable CR Cash/Mobile/Bank. Genuinely distinct from
 * postPayableSettlement (which reduces Trade Payables, account 2000 —
 * money owed to suppliers) since a loan (account 2100) is owed to a
 * lender, not a supplier, and mixing the two would incorrectly blend
 * "what we owe suppliers" with "what we owe the bank" in reporting.
 * Refuses to repay more than is genuinely still outstanding.
 */
async function postLoanRepayment(input) {
  const { amount, interestAmount = 0, paymentMethod = "CASH", notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (interestAmount < 0) throw new PostingError("Interest amount cannot be negative");
  if (interestAmount >= amount) throw new PostingError("Interest amount must be less than the total payment — some portion must reduce the principal.");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" — a loan repayment is an actual cash-equivalent payment.');

  const principalAmount = round2(amount - interestAmount);

  return prisma.$transaction(async (tx) => {
    // Principal portion: DR Loan Payable CR Cash — reduces the liability
    const eventName = "LOAN_REPAYMENT";
    await mustFindOrCreateCatalogue(tx, {
      eventName,
      description: "Repay a loan instalment (principal portion). DR Loan Payable (2100) CR Cash/Mobile/Bank. Reduces the outstanding liability. IFRS 9.",
      debitCode: "2100",
      creditCode: "1000",
      cashFlowCategory: "FINANCING",
      riskLevel: "MEDIUM",
      cycleType: "LOAN",
      alertRequired: 1,
      narrativeTemplate: "Loan repayment: KES {Amount} (principal: KES {Principal}, interest: KES {Interest}). {Notes}",
      reportSections: "CASH_FLOW:Financing|BALANCE_SHEET:LoanPayable",
      businessUnit,
      entrepriseId,
    });

    const loanAccount = await mustFindOrCreateAccount(tx, "2100", "Loan Payable", "LIABILITY", "CREDIT", "NON_CURRENT_LIABILITY", entrepriseId);
    const outstanding = await computeAccountBalance(tx, loanAccount.Account_id, "CREDIT");
    if (round2(principalAmount) > round2(outstanding)) {
      throw new PostingError(`Cannot repay KES ${round2(principalAmount)} principal — only KES ${round2(outstanding)} is genuinely still outstanding.`);
    }

    const product = await findOrCreateExpensePlaceholder(tx, "Loan Payable", entrepriseId);

    // Post the principal reduction
    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: round2(principalAmount),
      productId: product.Product_id,
      businessUnit,
      administrationId,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: { Principal: principalAmount, Interest: interestAmount, Notes: notes },
      entrepriseId,
    });

    // Post the interest portion as a separate expense if > 0
    // DR Finance Costs (5210) CR Cash/Mobile/Bank — this is an expense,
    // not a liability reduction. IAS 7 classifies it as Operating (the
    // default) or Financing (policy choice) — we use Operating.
    const interestJournal = [];
    if (interestAmount > 0) {
      await mustFindOrCreateCatalogue(tx, {
        eventName: "LOAN_INTEREST_EXPENSE",
        description: "Interest portion of a loan repayment. DR Finance Costs (5210) CR Cash/Mobile/Bank. An expense, not a liability reduction. IFRS 9.",
        debitCode: "5210",
        creditCode: "1000",
        cashFlowCategory: "OPERATING",
        riskLevel: "LOW",
        cycleType: "LOAN",
        alertRequired: 0,
        narrativeTemplate: "Loan interest: KES {Amount}.",
        reportSections: "INCOME_STATEMENT:FinanceCosts|CASH_FLOW:Operating",
        businessUnit,
        entrepriseId,
      });

      await mustFindOrCreateAccount(tx, "5210", "Finance Costs", "EXPENDITURE", "DEBIT", "OPERATING_EXPENSE", entrepriseId);

      const interestResult = await runCatalogueEvent(tx, {
        eventName: "LOAN_INTEREST_EXPENSE",
        amount: round2(interestAmount),
        productId: product.Product_id,
        businessUnit,
        administrationId,
        paymentMethod,
        paymentDirection: "pay",
        paymentSide: "credit",
        narrativeValues: {},
        entrepriseId,
      });
      interestJournal.push(...interestResult.journal);
    }

    // Reduce individual Liability rows FIFO (principal only)
    let remaining = round2(principalAmount);
    const openLoans = await tx.Liability.findMany({
      where: { Liability_Type: "Loan", Net_Amount: { gt: 0 }, Entreprise_id: entrepriseId },
      orderBy: { Liability_id: "asc" },
    });
    for (const row of openLoans) {
      if (remaining <= 0) break;
      const rowAmount = Number(row.Net_Amount || 0);
      const applied = Math.min(rowAmount, remaining);
      await tx.Liability.update({
        where: { Liability_id: row.Liability_id },
        data: { Net_Amount: round2(rowAmount - applied) },
      });
      remaining = round2(remaining - applied);
    }

    return {
      transaction: result.transaction,
      journal: [...result.journal, ...interestJournal],
      narrative: result.narrative,
      principalPaid: principalAmount,
      interestPaid: interestAmount,
      remainingOutstanding: round2(outstanding - principalAmount),
    };
  });
}

/**
 * postLoanClosure — formally closes a fully-repaid loan. Confirms that
 * the outstanding balance is genuinely zero, marks all related Liability
 * rows with a Closure_Status of CLOSED, and writes a Narrative recording
 * who closed it and when. No Journal posting — closure is an administrative
 * act (the loan is already fully repaid), not a financial event.
 *
 * This closes the gap identified in the cycle evaluation: a fully-repaid
 * loan correctly disappeared from the Liability page's visible list (the
 * Net_Amount reaches 0) but had no formal closure event — no closure date,
 * no status transition, and no audit trail showing who confirmed the loan
 * was settled. A banker reviewing the register needs to see CLOSED with a
 * date, not just a zero-balance row with no explanation.
 */
async function postLoanClosure({ liabilityId, notes = "", administrationId = null, entrepriseId }) {
  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!liabilityId) throw new PostingError("liabilityId is required — the specific Loan Liability row being closed.");

  return prisma.$transaction(async (tx) => {
    const liability = await tx.Liability.findUnique({ where: { Liability_id: Number(liabilityId) } });
    if (!liability || liability.Liability_Type !== "Loan" || liability.Entreprise_id !== entrepriseId) {
      throw new PostingError("Loan Liability row not found for this business.");
    }
    if (Number(liability.Net_Amount || 0) > 0) {
      throw new PostingError(
        `This loan still has KES ${Number(liability.Net_Amount).toFixed(2)} outstanding — repay the full balance before closing it.`
      );
    }
    if (liability.Closure_Status === "CLOSED") {
      throw new PostingError("This loan is already marked CLOSED.");
    }

    await tx.Liability.update({
      where: { Liability_id: liability.Liability_id },
      data: {
        Closure_Status: "CLOSED",
        Closure_Date: new Date(),
        Closure_Note: notes.trim() || "Loan fully repaid and closed.",
      },
    });

    await tx.Narrative.create({
      data: {
        Narrative_type: "NOTE",
        Narrative_source: "HUMAN",
        Narrative_audience: "ACCOUNTANT",
        Is_Generated: 0,
        Description: `Loan formally closed — balance confirmed at KES 0. ${notes.trim() || ""}`.trim(),
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { closed: true, liabilityId: liability.Liability_id };
  });
}

module.exports = { postFunding, postUnitIncome, postFundTransfer, postCapitalWithdrawal, postLoanRepayment, postLoanClosure, INCOME_TYPES };
