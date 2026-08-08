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

const EXPENSE_CATEGORIES = {
  RENT: { label: "Rent Expense", code: "5300", behaviour: "FIXED" },
  SALARIES: { label: "Salaries and Wages", code: "5100", behaviour: "FIXED" },
  UTILITIES: { label: "Utilities", code: "5400", behaviour: "VARIABLE" },
  TRANSPORT: { label: "Transport and Maintenance", code: "5500", behaviour: "VARIABLE" },
  INSURANCE: { label: "Insurance Premium", code: "5800", behaviour: "FIXED" },
  TAX: { label: "Tax Expense", code: "5600", behaviour: "VARIABLE" },
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
  const { category, amount, paymentMethod = "CASH", notes = "", administrationId = null, businessUnit = "SHOP", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  const categoryDef = EXPENSE_CATEGORIES[category];
  if (!categoryDef) throw new PostingError(`Unknown expense category "${category}"`);
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const eventName = `PAY_EXPENSE_${category}`;
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: `${categoryDef.label} expense. DR ${categoryDef.label} (${categoryDef.code}) CR payment method account.`,
          Debit_Account_code: categoryDef.code,
          Credit_Account_code: "1000",
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
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "pay", entrepriseId);

    const product = await findOrCreateExpensePlaceholder(tx, categoryDef.label, entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PAYMENT",
      cycleType: "EXPENDITURE",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("expense"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: expenseAccount,
      creditAccount: paymentAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `${eventName}: ${categoryDef.label}${notes ? " — " + notes : ""} (${paymentMethod})`,
      entrepriseId,
    });

    await tx.Expenditure.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: expenseAccount.Account_id,
        Records_id: recordsRow.Records_id,
        Transactions_id: transaction.Transactions_id,
        Expenditure_type: categoryDef.label,
        Expenditure_Category: category,
        Expenditure_Behaviour: categoryDef.behaviour,
        Accounting_Nature: "OPERATING_EXPENSE",
        Business_Unit: businessUnit,
        Net_Amount: round2(amount),
        Expenditure_Paid: paymentMethod === "CREDIT" ? 0 : round2(amount),
        Expenditure_Outstanding: paymentMethod === "CREDIT" ? round2(amount) : 0,
        Period_id: openPeriod.Structures_id,
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      Notes: notes,
    }, entrepriseId);

    return { transaction, journal, narrative };
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
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

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

    const catalogue = await mustFindOrCreateCatalogue(tx, {
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

    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);
    const product = await findOrCreateExpensePlaceholder(tx, "Receivable Settlement", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "RECEIPT",
      cycleType: "INCOME",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("settle-receivable"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: paymentAccount,
      creditAccount: receivableAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `SETTLE_RECEIVABLE: KES ${amount}${notes ? " — " + notes : ""} (${paymentMethod})`,
      entrepriseId,
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      Notes: notes,
    }, entrepriseId);

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

    return { transaction, journal, narrative, remainingReceivable: round2(outstanding - amount) };
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
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const payableAccount = await mustFindOrCreateAccount(tx, "2000", "Trade Payables", "LIABILITY", "CREDIT", "CURRENT_LIABILITY", entrepriseId);
    const outstanding = await computeAccountBalance(tx, payableAccount.Account_id, "CREDIT");
    if (amount > outstanding) {
      throw new PostingError(`Payment (KES ${amount}) exceeds the total outstanding payables (KES ${outstanding.toFixed(2)}).`);
    }

    const catalogue = await mustFindOrCreateCatalogue(tx, {
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

    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "pay", entrepriseId);
    const product = await findOrCreateExpensePlaceholder(tx, "Payable Settlement", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PAYMENT",
      cycleType: "EXPENDITURE",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("settle-payable"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: payableAccount,
      creditAccount: paymentAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `SETTLE_PAYABLE: KES ${amount}${notes ? " — " + notes : ""} (${paymentMethod})`,
      entrepriseId,
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      Notes: notes,
    }, entrepriseId);

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

    return { transaction, journal, narrative, remainingPayable: round2(outstanding - amount) };
  });
}

module.exports = { postExpense, postReceivableSettlement, postPayableSettlement, EXPENSE_CATEGORIES };
