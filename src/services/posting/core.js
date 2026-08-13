/**
 * core.js — shared posting infrastructure.
 *
 * Every domain module (till.js, assets.js, expenses.js, funds.js,
 * leasesAndProvisions.js) imports from here rather than duplicating any
 * of this logic. Nothing in this file is specific to one kind of
 * transaction — it's the plumbing every posting function relies on:
 * the Prisma client, the shared error type, payment-account resolution,
 * the Transactions/Journal/Narrative primitives, and the auto-provisioning
 * helpers that create Account_codes/Account/Catalogue rows on first use.
 *
 * If you're looking for a specific business operation (a sale, an asset
 * purchase, a lease payment), it isn't here — see the domain module for
 * that area instead. This file should only grow when a genuinely new
 * primitive is needed by more than one domain.
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

class PostingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostingError";
  }
}

/**
 * truncateAtBoundary — cuts a string to fit within maxLength, breaking at
 * the last sentence end (". ") if one exists within range, otherwise the
 * last word boundary, so truncated text still reads as a complete
 * thought rather than stopping mid-word. Appends "…" when actually cut.
 *
 * Mirrors the identical helper in seed.js. That copy protects the
 * one-time seeding functions; this one protects the auto-provisioning
 * helpers below (mustFindOrCreateCatalogue, mustFindOrCreateAccount,
 * findOrCreateExpensePlaceholder) that every domain module calls on
 * every real posting — the actual chokepoint where a too-long
 * description or narrative template crashes a live transaction, not
 * just a seed run. The "value too long for the column's type" crash was
 * fixed twice before (Structures, then LogicConditions) but only inside
 * seed.js; this is the gap that let the exact same bug class reach a
 * real user through Processing/Repackaging's Catalogue auto-provisioning
 * instead.
 */
function truncateAtBoundary(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  const hardCut = text.slice(0, maxLength - 1); // reserve 1 char for the ellipsis
  const lastSentenceEnd = hardCut.lastIndexOf(". ");
  if (lastSentenceEnd > maxLength * 0.5) {
    return hardCut.slice(0, lastSentenceEnd + 1);
  }
  const lastSpace = hardCut.lastIndexOf(" ");
  return (lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut) + "…";
}

// Real column caps for every table the auto-provisioning helpers below can
// write to. Applied defensively inside each helper so no caller — however
// long a description or narrative template it builds — can reintroduce
// the "value too long for the column's type" crash.
const CATALOGUE_FIELD_CAPS = {
  Event_Name: 45, Event_Description: 255, Debit_Account_code: 10,
  Credit_Account_code: 10, Secondary_Debit_code: 10, Secondary_Credit_code: 10,
  Cash_Flow_Category: 15, Operational_Impact: 45, Risk_Level: 10,
  Documentation_type: 45, Report_trigger: 45, Escalation_Role: 45,
  Cycle_type: 20, Posting_Complexity: 10, Evidence_template: 100,
  Report_sections: 255, Review_Level: 45, Default_Business_Unit: 20,
};
const ACCOUNT_CODES_FIELD_CAPS = { Code: 10, Code_name: 100, Code_categories: 45, Statement_Section: 45 };
const ACCOUNT_FIELD_CAPS = { Account_Name: 100, Account_Type: 45, Normal_Balance: 10, Authoritative_Source: 20 };
const PRODUCT_FIELD_CAPS = { Product_type: 45, Product_Name: 45 };

function applyFieldCaps(data, caps) {
  const safe = { ...data };
  for (const [field, cap] of Object.entries(caps)) {
    if (typeof safe[field] === "string" && safe[field].length > cap) {
      safe[field] = truncateAtBoundary(safe[field], cap);
    }
  }
  return safe;
}

/**
 * PAYMENT_METHODS — the account each payment method resolves to.
 * CASH/MOBILE/BANK are genuinely separate Account rows (their own running
 * balance, visible individually on the Ledger and in Cash Flow). CREDIT
 * doesn't touch a cash account at all — it posts to a receivable (on a
 * sale) or payable (on a purchase) instead, since no cash has moved yet.
 */
const PAYMENT_METHODS = {
  CASH: { code: "1000", label: "Cash / Till", type: "ASSET", normalBalance: "DEBIT" },
  MOBILE: { code: "1010", label: "Mobile Money", type: "ASSET", normalBalance: "DEBIT" },
  BANK: { code: "1020", label: "Bank", type: "ASSET", normalBalance: "DEBIT" },
  CREDIT_RECEIVABLE: { code: "1200", label: "Trade Receivables", type: "ASSET", normalBalance: "DEBIT" },
  CREDIT_PAYABLE: { code: "2000", label: "Trade Payables", type: "LIABILITY", normalBalance: "CREDIT" },
};

/**
 * resolvePaymentAccount — given a payment method ("CASH"|"MOBILE"|"BANK"|
 * "CREDIT") and a direction ("receive" for a sale/income, "pay" for a
 * purchase/expense), returns the live Account row to post against,
 * auto-provisioning the Account_codes/Account rows on first use — same
 * self-healing pattern as every other helper in this file.
 */
async function resolvePaymentAccount(tx, method, direction, entrepriseId) {
  const key = method === "CREDIT" ? (direction === "receive" ? "CREDIT_RECEIVABLE" : "CREDIT_PAYABLE") : method;
  const def = PAYMENT_METHODS[key];
  if (!def) throw new PostingError(`Unknown payment method "${method}"`);

  let codeRow = await tx.Account_codes.findFirst({ where: { Code: def.code, Entreprise_id: entrepriseId } });
  if (!codeRow) {
    codeRow = await tx.Account_codes.create({
      data: {
        Code: def.code,
        Code_name: def.label,
        Code_categories: def.type,
        Statement_Section: def.type === "ASSET" ? "CURRENT_ASSET" : "CURRENT_LIABILITY",
        Is_Active: 1,
        Entreprise_id: entrepriseId,
      },
    });
  }
  let account = await tx.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
  if (!account) {
    account = await tx.Account.create({
      data: {
        Account_Name: def.label,
        Account_Type: def.type,
        Account_Code_id: codeRow.Account_codes_id,
        Normal_Balance: def.normalBalance,
        Current_Balance: 0,
        Authoritative_Source: "JOURNAL",
        Is_Active: 1,
        Entreprise_id: entrepriseId,
      },
    });
  }
  return account;
}

// The three Catalogue events every Till transaction depends on, defined
// once here so mustFindCatalogue can self-provision them for a business
// that has never had seed.js run for it — matching seed.js's own
// definitions exactly, so there is only one source of truth for what
// these events mean regardless of which code path creates them first.
const CORE_TILL_CATALOGUE_DEFS = {
  SELL_GOODS_CASH: {
    description: "Cash sale. DR Cash (1000) CR Sales (4000). At point of sale also fires RECORD_COGS. Receipt generated when payment is complete.",
    debitCode: "1000",
    creditCode: "4000",
    cashFlowCategory: "OPERATING",
    operationalImpact: "INVENTORY_DECREASE",
    riskLevel: "LOW",
    documentationType: "RECEIPT",
    reportTrigger: "DAILY_SALES",
    cycleType: "INCOME",
    narrativeTemplate: "Cash sale: {Quantity} x {Product_Name} at KES {UnitPrice} = KES {Amount}.",
    evidenceTemplate: "NONE",
    reportSections: "RECEIPT:LineItem|DAILY_SALES:Revenue",
  },
  RECORD_COGS: {
    description: "Transfer inventory cost to COGS when goods are sold. DR COGS (5000) CR Inventory (1100). Non-cash — moves cost from balance sheet to income statement.",
    debitCode: "5000",
    creditCode: "1100",
    cashFlowCategory: "NONE",
    operationalImpact: "NONE",
    riskLevel: "LOW",
    documentationType: "NONE",
    reportTrigger: "INCOME_STATEMENT",
    cycleType: "INCOME",
    narrativeTemplate: "COGS: {Quantity} x KES {UnitCost} = KES {Amount} transferred from inventory to expense.",
    evidenceTemplate: "NONE",
    reportSections: "INCOME_STATEMENT:COGS",
  },
  BUY_INVENTORY_CASH: {
    description: "Purchase inventory. DR Inventory (1100) CR Cash (1000). BALANCE SHEET MOVEMENT — not an income statement expense. Becomes COGS only when sold.",
    debitCode: "1100",
    creditCode: "1000",
    cashFlowCategory: "OPERATING",
    operationalImpact: "INVENTORY_INCREASE",
    riskLevel: "LOW",
    documentationType: "NONE",
    reportTrigger: "DAILY_PURCHASES",
    cycleType: "EXPENDITURE",
    narrativeTemplate: "Purchased {Quantity} {Product_Name} for KES {Amount}. Added to inventory.",
    evidenceTemplate: "RECEIPT",
    reportSections: "DAILY_REPORT:CashMovement|BALANCE_SHEET:Inventory",
  },
};

async function mustFindCatalogue(tx, eventName, entrepriseId) {
  let row = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
  if (row) return row;

  const def = CORE_TILL_CATALOGUE_DEFS[eventName];
  if (!def) {
    throw new PostingError(`Catalogue event "${eventName}" is not seeded for this business. Run src/services/seed.js.`);
  }

  return tx.Catalogue.create({
    data: {
      Event_Name: eventName,
      Event_Description: def.description,
      Debit_Account_code: def.debitCode,
      Credit_Account_code: def.creditCode,
      Cash_Flow_Category: def.cashFlowCategory,
      Operational_Impact: def.operationalImpact,
      Risk_Level: def.riskLevel,
      Documentation_type: def.documentationType,
      Report_trigger: def.reportTrigger,
      Escalation_Role: "NONE",
      Cycle_type: def.cycleType,
      Alert_Required: 0,
      Narrative_template: def.narrativeTemplate,
      Evidence_template: def.evidenceTemplate,
      Report_sections: def.reportSections,
      Default_Business_Unit: "SHOP",
      Is_Active: 1,
      Version_No: 1,
      Effective_From: new Date("2020-04-01"),
      Entreprise_id: entrepriseId,
    },
  });
}

const CORE_ACCOUNT_DEFS = {
  "1100": { name: "Inventory", type: "ASSET", normalBalance: "DEBIT", statementSection: "CURRENT_ASSET" },
  "4000": { name: "Sales", type: "INCOME", normalBalance: "CREDIT", statementSection: "OPERATING_REVENUE" },
  "4400": { name: "Service Income", type: "INCOME", normalBalance: "CREDIT", statementSection: "OPERATING_REVENUE" },
  "4600": { name: "Utility Income", type: "INCOME", normalBalance: "CREDIT", statementSection: "OPERATING_REVENUE" },
  "5000": { name: "Cost of Goods Sold", type: "EXPENDITURE", normalBalance: "DEBIT", statementSection: "OPERATING_EXPENSE" },
  "5400": { name: "Utilities", type: "EXPENDITURE", normalBalance: "DEBIT", statementSection: "OPERATING_EXPENSE" },
  "5450": { name: "Service Expense", type: "EXPENDITURE", normalBalance: "DEBIT", statementSection: "OPERATING_EXPENSE" },
};

async function resolveAllAccounts(tx, entrepriseId) {
  const out = {};
  for (const [code, def] of Object.entries(CORE_ACCOUNT_DEFS)) {
    let codeRow = await tx.Account_codes.findFirst({ where: { Code: code, Entreprise_id: entrepriseId } });
    if (!codeRow) {
      codeRow = await tx.Account_codes.create({
        data: { Code: code, Code_name: def.name, Code_categories: def.type, Statement_Section: def.statementSection, Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    let account = await tx.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!account) {
      account = await tx.Account.create({
        data: { Account_Name: def.name, Account_Type: def.type, Account_Code_id: codeRow.Account_codes_id, Normal_Balance: def.normalBalance, Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
      });
    }
    out[code] = account;
  }
  return out;
}

async function openTransactionCycle(tx, { accountId, productId, quantity, amount, businessEvent, cycleType, businessUnit, recordsId, cycleReference, referenceNo = null, entrepriseId }) {
  const txn = await tx.Transactions.create({
    data: {
      Account_id: accountId,
      Product_id: productId,
      Transactions_date: new Date(),
      Quantity: quantity,
      Amount: amount,
      Business_Event: businessEvent,
      Cycle_type: cycleType,
      Cycle_status: "CLOSED",
      Cycle_reference: cycleReference,
      Reference_no: referenceNo,
      Records_id: recordsId,
      Business_Unit: businessUnit,
      Confidence_Level: 4,
      Correction_Status: "ORIGINAL",
      Entreprise_id: entrepriseId,
    },
  });
  await tx.Transactions.update({
    where: { Transactions_id: txn.Transactions_id },
    data: { Cycle_id: txn.Transactions_id },
  });
  return txn;
}

async function postJournalPair(tx, { debitAccount, creditAccount, amount, catalogueId, transactionId, productId, periodId, administrationId, description, entrepriseId, correctionOf = null, correctionReason = null, entryGroup = null }) {
  // Generate a Journal_Entry_Group that groups all DR/CR lines from
  // the same posting event. If the caller provides an explicit group
  // (for multi-pair events like asset disposal or lease termination),
  // use that; otherwise generate one from the transaction ID + a
  // timestamp suffix to ensure uniqueness within the same transaction.
  const group = entryGroup || `JE-${transactionId}-${Date.now().toString(36)}`;

  const rows = [];
  if (debitAccount) {
    rows.push(
      await tx.Journal.create({
        data: {
          Account_id: debitAccount.Account_id,
          Catalogue_id: catalogueId,
          Transactions_id: transactionId,
          Administration_id: administrationId,
          Product_id: productId,
          Period_id: periodId,
          Debit: amount,
          Credit: 0,
          Net_Amount: amount,
          Description: description,
          Recognition_Basis: "CASH",
          Journal_Entry_Group: group,
          Correction_Status: correctionOf ? "REVERSING" : "ORIGINAL",
          Correction_of: correctionOf,
          Correction_Reason: correctionReason,
          Entreprise_id: entrepriseId,
        },
      })
    );
  }
  if (creditAccount) {
    rows.push(
      await tx.Journal.create({
        data: {
          Account_id: creditAccount.Account_id,
          Catalogue_id: catalogueId,
          Transactions_id: transactionId,
          Administration_id: administrationId,
          Product_id: productId,
          Period_id: periodId,
          Debit: 0,
          Credit: amount,
          Net_Amount: amount,
          Description: description,
          Recognition_Basis: "CASH",
          Journal_Entry_Group: group,
          Correction_Status: correctionOf ? "REVERSING" : "ORIGINAL",
          Correction_of: correctionOf,
          Correction_Reason: correctionReason,
          Entreprise_id: entrepriseId,
        },
      })
    );
  }
  return rows;
}

async function adjustResourceQuantity(tx, productId, quantity, impact) {
  const resource = await tx.Resources.findFirst({ where: { Product_id: productId } });
  if (!resource) return null;
  const delta = impact === "INVENTORY_DECREASE" ? -quantity : quantity;
  const newQty = Number(resource.Resources_Quantity || 0) + delta;
  return tx.Resources.update({
    where: { Resources_id: resource.Resources_id },
    data: { Resources_Quantity: newQty, Last_updated: new Date() },
  });
}

async function writeNarrative(tx, catalogue, transaction, recordsRow, values, entrepriseId) {
  if (!catalogue.Narrative_template) return null;
  const text = fillTemplate(catalogue.Narrative_template, values);
  return tx.Narrative.create({
    data: {
      Transaction_id: transaction.Transactions_id,
      Records_id: recordsRow.Records_id,
      Narrative_type: "ORIGIN",
      Is_Generated: 1,
      Generated_from_catalogue: catalogue.Catalogue_id,
      Narrative_source: "SYSTEM",
      Narrative_audience: "OWNER",
      Description: text,
      Language: "en",
      Narrative_date: new Date(),
      Entreprise_id: entrepriseId,
    },
  });
}

function buildCycleReference(mode) {
  const prefixes = { sell: "SALE", buy: "PURCH", asset: "ASSET" };
  const prefix = prefixes[mode] || "TXN";
  const year = new Date().getFullYear();
  const seq = String(Date.now()).slice(-6);
  return `${prefix}-${year}-${seq}`;
}

function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (key in values ? values[key] : `{${key}}`));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * mustFindOrCreateCatalogue — shared helper: finds a Catalogue row by
 * Event_Name, or creates it with the given fields. Consolidates the
 * repeated auto-provisioning pattern used across every posting function.
 */
async function mustFindOrCreateCatalogue(tx, { eventName, description, debitCode, creditCode, cashFlowCategory, riskLevel, cycleType, alertRequired, narrativeTemplate, reportSections, businessUnit, entrepriseId }) {
  let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
  if (!catalogue) {
    const safeData = applyFieldCaps(
      {
        Event_Name: eventName,
        Event_Description: description,
        Debit_Account_code: debitCode,
        Credit_Account_code: creditCode,
        Posting_Complexity: "SIMPLE",
        Cash_Flow_Category: cashFlowCategory,
        Operational_Impact: "NONE",
        Risk_Level: riskLevel,
        Documentation_type: "NONE",
        Report_trigger: "BALANCE_SHEET",
        Escalation_Role: "OWNER",
        Cycle_type: cycleType,
        Alert_Required: alertRequired,
        Narrative_template: narrativeTemplate, // TEXT-equivalent in practice via Evidence_template pairing, but capped defensively below too since some deployments may have it as VARCHAR
        Evidence_template: "NONE",
        Report_sections: reportSections,
        Default_Business_Unit: businessUnit,
        Is_Active: 1,
        Version_No: 1,
        Effective_From: new Date("2020-04-01"),
        Entreprise_id: entrepriseId,
      },
      CATALOGUE_FIELD_CAPS
    );
    catalogue = await tx.Catalogue.create({ data: safeData });
  }
  return catalogue;
}

/**
 * mustFindOrCreateAccount — shared helper: finds an Account by its
 * Account_codes.Code, or creates both the code and account. Consolidates
 * the repeated auto-provisioning pattern used across every posting function.
 */
async function mustFindOrCreateAccount(tx, code, name, type, normalBalance, statementSection, entrepriseId) {
  let codeRow = await tx.Account_codes.findFirst({ where: { Code: code, Entreprise_id: entrepriseId } });
  if (!codeRow) {
    const safeCodeData = applyFieldCaps(
      { Code: code, Code_name: name, Code_categories: type, Statement_Section: statementSection, Is_Active: 1, Entreprise_id: entrepriseId },
      ACCOUNT_CODES_FIELD_CAPS
    );
    codeRow = await tx.Account_codes.create({ data: safeCodeData });
  }
  let account = await tx.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
  if (!account) {
    const safeAccountData = applyFieldCaps(
      {
        Account_Name: name,
        Account_Type: type,
        Account_Code_id: codeRow.Account_codes_id,
        Normal_Balance: normalBalance,
        Current_Balance: 0,
        Authoritative_Source: "JOURNAL",
        Is_Active: 1,
        Entreprise_id: entrepriseId,
      },
      ACCOUNT_FIELD_CAPS
    );
    account = await tx.Account.create({ data: safeAccountData });
  }
  return account;
}

async function findOrCreateExpensePlaceholder(tx, label, entrepriseId) {
  const name = truncateAtBoundary(`[Non-stock] ${label}`, PRODUCT_FIELD_CAPS.Product_Name);
  const existing = await tx.Product.findFirst({ where: { Product_Name: name, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return tx.Product.create({
    data: { Product_Name: name, Product_type: "Service", Product_Price: 0, Product_Cost: 0, Is_Service: 1, Entreprise_id: entrepriseId },
  });
}

/**
 * computeAccountBalance — sums an account's Journal history and returns
 * its balance on its normal side. Used by the settlement functions to
 * find the current outstanding Trade Receivables/Payables total without
 * requiring a separate running-balance column to stay in sync.
 */
async function computeAccountBalance(tx, accountId, normalSide) {
  const rows = await tx.Journal.findMany({ where: { Account_id: accountId } });
  let debit = 0, credit = 0;
  for (const r of rows) {
    debit += Number(r.Debit || 0);
    credit += Number(r.Credit || 0);
  }
  return normalSide === "DEBIT" ? round2(debit - credit) : round2(credit - debit);
}

/**
 * generateReceipt — creates a Documents row (type: RECEIPT) linked to
 * the Records row and Transaction that triggered it. Returns the
 * Document with a sequential receipt number (RCP-NNNN).
 *
 * This closes the gap where Catalogue events declared
 * Documentation_type: "RECEIPT" but no code ever created the actual
 * Document row. Now any posting function can call generateReceipt
 * after posting to produce a traceable, numbered receipt.
 */
async function generateReceipt(tx, { recordsId, transactionId, stakeholderId = null, amount, description, administrationId = null, entrepriseId }) {
  // Count existing receipts for this business to generate the next number
  const count = await tx.Documents.count({ where: { Document_type: "RECEIPT", Entreprise_id: entrepriseId } });
  const receiptNo = `RCP-${String(count + 1).padStart(4, "0")}`;

  return tx.Documents.create({
    data: {
      Records_id: recordsId || null,
      Transactions_id: transactionId || null,
      Document_type: "RECEIPT",
      Documents_no: receiptNo,
      Documents_version: 1,
      Stakeholder_id: stakeholderId,
      Document_Title: "Receipt",
      Action: "CREATE",
      Document_date: new Date(),
      Net_Amount: round2(amount),
      Document_status: "GENERATED",
      Document_Authenticity: "ORIGINAL",
      Is_Original: 1,
      Generated: 1,
      Generated_By: administrationId,
      Confidence_Level: 4,
      Created_at: new Date(),
      Entreprise_id: entrepriseId,
    },
  });
}

module.exports = {
  prisma,
  PostingError,
  PAYMENT_METHODS,
  resolvePaymentAccount,
  mustFindCatalogue,
  resolveAllAccounts,
  openTransactionCycle,
  postJournalPair,
  adjustResourceQuantity,
  writeNarrative,
  buildCycleReference,
  fillTemplate,
  round2,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
  findOrCreateExpensePlaceholder,
  computeAccountBalance,
  generateReceipt,
};
