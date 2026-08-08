/**
 * funds.js — the Funds domain: money coming into the business from the
 * owner or a lender, and income that isn't tied to selling stocked goods
 * (rent, bond interest, dividends). Matches the Money > Funds page.
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
  computeAccountBalance,
} = require("./core");

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
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const fromAccount = await resolvePaymentAccount(tx, from, "pay", entrepriseId);
    const toAccount = await resolvePaymentAccount(tx, to, "receive", entrepriseId);

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
          Debit_Account_code: null, // varies by direction, set explicitly on each posting instead
          Credit_Account_code: null,
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
      accountId: toAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "TRANSFER",
      cycleType: "CAPITAL",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("transfer"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: toAccount,
      creditAccount: fromAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `FUND_TRANSFER: KES ${amount} from ${fromAccount.Account_Name} to ${toAccount.Account_Name}${notes ? " — " + notes : ""}`,
      entrepriseId,
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      From: fromAccount.Account_Name,
      To: toAccount.Account_Name,
      Notes: notes,
    }, entrepriseId);

    return { transaction, journal, narrative };
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
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: `${creditLabel} received. DR payment method account CR ${creditLabel} (${creditCode}).`,
          Debit_Account_code: "1000",
          Credit_Account_code: creditCode,
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
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);

    const product = await findOrCreateExpensePlaceholder(tx, creditLabel, entrepriseId);

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
      cycleType: source === "LOAN" ? "LOAN" : "CAPITAL",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("fund"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: paymentAccount,
      creditAccount: creditAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `${eventName}: KES ${amount}${notes ? " — " + notes : ""} (${paymentMethod})`,
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
          Records_id: recordsRow.Records_id,
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
          Records_id: recordsRow.Records_id,
          Liability_Type: "Loan",
          Liability_Classification: "NON_CURRENT",
          Net_Amount: round2(amount),
          Period: new Date(),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      Notes: notes,
    }, entrepriseId);

    return { transaction, journal, narrative };
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
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const eventName = `RECEIVE_${incomeType}_INCOME`;
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: eventName,
          Event_Description: `${incomeDef.label} received. DR payment method account CR ${incomeDef.label} (${incomeDef.code}).`,
          Debit_Account_code: "1000",
          Credit_Account_code: incomeDef.code,
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
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);

    const product = await findOrCreateExpensePlaceholder(tx, incomeDef.label, entrepriseId);

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
      cycleType: incomeType === "RENT" ? "RENT" : "INVESTMENT",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("income"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: paymentAccount,
      creditAccount: incomeAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `${eventName}: KES ${amount}${notes ? " — " + notes : ""} (${paymentMethod})`,
      entrepriseId,
    });

    await tx.Income.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: incomeAccount.Account_id,
        Records_id: recordsRow.Records_id,
        Transactions_id: transaction.Transactions_id,
        Income_type: incomeDef.label,
        Income_Category: incomeType === "RENT" ? "RENTAL" : incomeType === "INTEREST" ? "INTEREST" : "DIVIDEND",
        Business_Unit: businessUnit,
        Net_Amount: round2(amount),
        Cash_Received: paymentMethod === "CREDIT" ? 0 : round2(amount),
        Outstanding_Amount: paymentMethod === "CREDIT" ? round2(amount) : 0,
        Period_id: openPeriod.Structures_id,
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    if (moneyId) {
      const moneyRow = await tx.Money.findUnique({ where: { Money_id: moneyId } });
      if (moneyRow && moneyRow.Entreprise_id === entrepriseId) {
        await tx.Money.update({
          where: { Money_id: moneyId },
          data: { Settlement_transaction_id: transaction.Transactions_id },
        });
      }
    }

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Amount: amount.toFixed(2),
      Notes: notes,
    }, entrepriseId);

    return { transaction, journal, narrative };
  });
}

module.exports = { postFunding, postUnitIncome, postFundTransfer, INCOME_TYPES };
