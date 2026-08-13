/**
 * claims.js — the Claims domain: operating expenses, and settling
 * outstanding Trade Receivables/Payables created by credit transactions
 * elsewhere (Till, Assets, Expenses themselves). Matches the Expenses and
 * Payables pages in the app.
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
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
  findOrCreateExpensePlaceholder,
  computeAccountBalance,
} = require("./core");
const { runCatalogueEvent } = require("./interpreter");

const EXPENSE_CATEGORIES = {
  RENT: { label: "Rent Expense", code: "5300", behaviour: "FIXED" },
  SALARIES: { label: "Salaries and Wages", code: "5100", behaviour: "FIXED" },
  UTILITIES: { label: "Utilities", code: "5400", behaviour: "VARIABLE" },
  TRANSPORT: { label: "Transport and Maintenance", code: "5500", behaviour: "VARIABLE" },
  INSURANCE: { label: "Insurance Premium", code: "5600", behaviour: "FIXED" },
  TAX: { label: "Tax Expense", code: "5800", behaviour: "VARIABLE" },
  OTHER: { label: "Other Operating Expense", code: "5999", behaviour: "MIXED" },
};

/**
 * postExpense — records a general operating expense (rent, salaries,
 * utilities, transport, insurance, tax, other). DR the chosen expense
 * account, CR the payment method's account (Cash/Mobile/Bank), or CR
 * Trade Payables if the expense is on credit (not yet paid). Does not
 * touch inventory or COGS — this is for money spent running the business
 * day to day, not stock.
 *
 * @param {Object} input
 * @param {string} input.category   - one of EXPENSE_CATEGORIES keys above
 * @param {number} input.amount
 * @param {"CASH"|"MOBILE"|"BANK"|"CREDIT"} [input.paymentMethod] - defaults to CASH
 * @param {string} [input.notes]
 * @param {number} [input.administrationId]
 */
async function postExpense(input) {
  const { category, amount, paymentMethod = "CASH", notes = "", moneyId = null, nextDueDate = null, administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  const categoryDef = EXPENSE_CATEGORIES[category];
  if (!categoryDef) throw new PostingError(`Unknown expense category "${category}"`);
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (moneyId && category !== "INSURANCE") {
    throw new PostingError("moneyId can only be given for an INSURANCE expense — it links this payment to a specific policy.");
  }

  return prisma.$transaction(async (tx) => {
    const eventName = `PAY_EXPENSE_${category}`;
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: `${categoryDef.label} expense. DR ${categoryDef.label} (${categoryDef.code}) CR payment method account.`,
          Debit_Account_code: categoryDef.code,
          Credit_Account_code: "1000",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "OPERATING",
          Operational_Impact: "NONE",
          Risk_Level: "LOW",
          Documentation_type: "RECEIPT",
          Report_trigger: "INCOME_STATEMENT",
          Escalation_Role: "NONE",
          Cycle_type: "EXPENDITURE",
          Alert_Required: 0,
          Narrative_template: `Paid ${categoryDef.label}: KES {Amount}. {Notes}`,
          Evidence_template: "RECEIPT",
          Report_sections: `INCOME_STATEMENT:${categoryDef.label}`,
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    let expenseCodeRow = await tx.Account_codes.findFirst({ where: { Code: categoryDef.code, Entreprise_id: entrepriseId } });
    if (!expenseCodeRow) {
      expenseCodeRow = await tx.Account_codes.create({
        data: {
          Code: categoryDef.code,
          Code_name: categoryDef.label,
          Code_categories: "EXPENDITURE",
          Statement_Section: "OPERATING_EXPENSE",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }
    let expenseAccount = await tx.Account.findFirst({ where: { Account_Code_id: expenseCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!expenseAccount) {
      expenseAccount = await tx.Account.create({
        data: {
          Account_Name: categoryDef.label,
          Account_Type: "EXPENDITURE",
          Account_Code_id: expenseCodeRow.Account_codes_id,
          Normal_Balance: "DEBIT",
          Current_Balance: 0,
          Authoritative_Source: "JOURNAL",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }

    const product = await findOrCreateExpensePlaceholder(tx, categoryDef.label, entrepriseId);

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

    await tx.Expenditure.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: expenseAccount.Account_id,
        Records_id: result.recordsId,
        Transactions_id: result.transaction.Transactions_id,
        Expenditure_type: categoryDef.label,
        Expenditure_Category: category,
        Expenditure_Behaviour: categoryDef.behaviour,
        Accounting_Nature: "OPERATING_EXPENSE",
        Business_Unit: businessUnit,
        Net_Amount: round2(amount),
        Expenditure_Paid: paymentMethod === "CREDIT" ? 0 : round2(amount),
        Expenditure_Outstanding: paymentMethod === "CREDIT" ? round2(amount) : 0,
        Period_id: result.transaction.Period_id,
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    // The actual fix for the reported gap: paying an INSURANCE expense
    // previously journaled and narrated correctly but had no way to be
    // recognised against the specific policy it was paying — the Money
    // row and the Expenditure row were completely disconnected. Linking
    // Settlement_transaction_id here (the same field postUnitIncome
    // already uses for the same purpose) is what actually closes that
    // gap; without this the Risks & Insurance page could only ever show
    // the static reference premium entered at policy creation, never a
    // real payment history.
    if (moneyId) {
      const moneyRow = await tx.Money.findUnique({ where: { Money_id: Number(moneyId) } });
      if (!moneyRow || moneyRow.Entreprise_id !== entrepriseId) {
        throw new PostingError("Insurance policy not found for this business.");
      }
      if (moneyRow.Instrument_type !== "INSURANCE") {
        throw new PostingError("This Money record isn't an insurance policy.");
      }
      await tx.Money.update({
        where: { Money_id: Number(moneyId) },
        data: {
          Settlement_transaction_id: result.transaction.Transactions_id,
          // Outstanding_Amount here represents the reference premium
          // due next, not a running balance being paid down (a policy
          // renews rather than depletes) — paying it clears what was
          // due; the next premium, once known, is entered fresh when
          // the policy is next reviewed or renewed.
          Outstanding_Amount: 0,
          Due_Date: nextDueDate ? new Date(nextDueDate) : moneyRow.Due_Date,
        },
      });
    }

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative };
  });
}

/**
 * postReceivableSettlement — a customer pays off some or all of an
 * outstanding Trade Receivable created by an earlier credit sale. DR the
 * payment method's account (Cash/Mobile/Bank), CR Trade Receivables (1200).
 * This is the missing third step in the credit-sale cycle: Sell on Credit
 * (DR Receivable CR Sales) -> Customer Pays (DR Cash CR Receivable) —
 * without this function a credit sale's receivable could never be settled
 * through the app.
 */
async function postReceivableSettlement(input) {
  const { amount, paymentMethod = "CASH", notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" — a receivable is settled by an actual cash-equivalent receipt.');

  return prisma.$transaction(async (tx) => {
    // The outstanding balance is the aggregate Trade Receivables account —
    // individual credit sales are already itemised on the Payables page via
    // the Journal, but settlement reduces the account as a whole, the same
    // way a loan repayment reduces the aggregate Liability balance elsewhere
    // in this system, rather than requiring the payer to name one specific
    // original sale.
    const receivableAccount = await mustFindOrCreateAccount(tx, "1200", "Trade Receivables", "ASSET", "DEBIT", "CURRENT_ASSET", entrepriseId);
    const outstanding = await computeAccountBalance(tx, receivableAccount.Account_id, "DEBIT");
    if (amount > outstanding) {
      throw new PostingError(`Payment (KES ${amount}) exceeds the total outstanding receivables (KES ${outstanding.toFixed(2)}).`);
    }

    await mustFindOrCreateCatalogue(tx, {
      eventName: "SETTLE_RECEIVABLE",
      description: "A customer pays down an outstanding credit sale. DR payment method account CR Trade Receivables (1200). Completes the credit-sale cycle. IFRS 9.",
      debitCode: "1000",
      creditCode: "1200",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "INCOME",
      alertRequired: 0,
      narrativeTemplate: "Received KES {Amount} from a customer settling an outstanding balance. {Notes}",
      reportSections: "CASH_FLOW:Operating|BALANCE_SHEET:TradeReceivables",
      businessUnit,
      entrepriseId,
    });

    const product = await findOrCreateExpensePlaceholder(tx, "Receivable Settlement", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "SETTLE_RECEIVABLE",
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

    // Reduce individual Trade Receivables Liability rows FIFO (oldest
    // credit sale first) until this payment is exhausted — this is what
    // was missing before: the aggregate account balance was always
    // correct (computeAccountBalance above, and everything the Payables
    // page shows), but the itemised Liability rows created at the moment
    // of each credit sale were never touched by a settlement, so the
    // Liability page kept showing every credit sale as still fully
    // outstanding even after it had genuinely been paid down.
    let remaining = round2(amount);
    const openReceivables = await tx.Liability.findMany({
      where: { Liability_Type: "Trade Receivables", Net_Amount: { gt: 0 } },
      orderBy: { Liability_id: "asc" },
    });
    for (const row of openReceivables) {
      if (remaining <= 0) break;
      const rowAmount = Number(row.Net_Amount || 0);
      const applied = Math.min(rowAmount, remaining);
      await tx.Liability.update({
        where: { Liability_id: row.Liability_id },
        data: { Net_Amount: round2(rowAmount - applied) },
      });
      remaining = round2(remaining - applied);
    }

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative, remainingReceivable: round2(outstanding - amount) };
  });
}

/**
 * postPayableSettlement — the business pays down an outstanding Trade
 * Payable created by an earlier credit purchase or credit expense. DR
 * Trade Payables (2000), CR the payment method's account (Cash/Mobile/
 * Bank). Completes the credit-purchase cycle the same way
 * postReceivableSettlement completes the credit-sale cycle.
 */
async function postPayableSettlement(input) {
  const { amount, paymentMethod = "CASH", notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" — a payable is settled by an actual cash-equivalent payment.');

  return prisma.$transaction(async (tx) => {
    const payableAccount = await mustFindOrCreateAccount(tx, "2000", "Trade Payables", "LIABILITY", "CREDIT", "CURRENT_LIABILITY", entrepriseId);
    const outstanding = await computeAccountBalance(tx, payableAccount.Account_id, "CREDIT");
    if (amount > outstanding) {
      throw new PostingError(`Payment (KES ${amount}) exceeds the total outstanding payables (KES ${outstanding.toFixed(2)}).`);
    }

    await mustFindOrCreateCatalogue(tx, {
      eventName: "SETTLE_PAYABLE",
      description: "The business pays down an outstanding credit purchase or expense. DR Trade Payables (2000) CR payment method account. Completes the credit-purchase cycle. IFRS 9.",
      debitCode: "2000",
      creditCode: "1000",
      cashFlowCategory: "OPERATING",
      riskLevel: "LOW",
      cycleType: "EXPENDITURE",
      alertRequired: 0,
      narrativeTemplate: "Paid KES {Amount} to a supplier settling an outstanding balance. {Notes}",
      reportSections: "CASH_FLOW:Operating|BALANCE_SHEET:TradePayables",
      businessUnit,
      entrepriseId,
    });

    const product = await findOrCreateExpensePlaceholder(tx, "Payable Settlement", entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName: "SETTLE_PAYABLE",
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

    // Same fix as postReceivableSettlement above: reduce individual Trade
    // Payables Liability rows FIFO (oldest credit purchase first) until
    // this payment is exhausted, so the Liability page reflects what's
    // actually still owed rather than every credit purchase forever.
    let remaining = round2(amount);
    const openPayables = await tx.Liability.findMany({
      where: { Liability_Type: "Trade Payables", Net_Amount: { gt: 0 } },
      orderBy: { Liability_id: "asc" },
    });
    for (const row of openPayables) {
      if (remaining <= 0) break;
      const rowAmount = Number(row.Net_Amount || 0);
      const applied = Math.min(rowAmount, remaining);
      await tx.Liability.update({
        where: { Liability_id: row.Liability_id },
        data: { Net_Amount: round2(rowAmount - applied) },
      });
      remaining = round2(remaining - applied);
    }

    // A credit expense (postExpense with paymentMethod=CREDIT — "pay this
    // rent later") settles through this exact same Trade Payables account,
    // but records its own outstanding balance on Expenditure_Outstanding,
    // not on a Liability row. Genuinely the same staleness bug, same fix:
    // reduce FIFO until the payment or the outstanding expenses run out,
    // whichever comes first.
    if (remaining > 0) {
      const openExpenses = await tx.Expenditure.findMany({
        where: { Expenditure_Outstanding: { gt: 0 }, Entreprise_id: entrepriseId },
        orderBy: { Expenditure_id: "asc" },
      });
      for (const row of openExpenses) {
        if (remaining <= 0) break;
        const rowOutstanding = Number(row.Expenditure_Outstanding || 0);
        const applied = Math.min(rowOutstanding, remaining);
        await tx.Expenditure.update({
          where: { Expenditure_id: row.Expenditure_id },
          data: {
            Expenditure_Outstanding: round2(rowOutstanding - applied),
            Expenditure_Paid: round2(Number(row.Expenditure_Paid || 0) + applied),
          },
        });
        remaining = round2(remaining - applied);
      }
    }

    return { transaction: result.transaction, journal: result.journal, narrative: result.narrative, remainingPayable: round2(outstanding - amount) };
  });
}

module.exports = { postExpense, postReceivableSettlement, postPayableSettlement, EXPENSE_CATEGORIES };
