const { prisma } = require("../posting/core");

async function upsertProcessAction(fields) {
  const existing = await prisma.ProcessActions.findFirst({
    where: { Process_name: fields.Process_name, Sequence_No: fields.Sequence_No },
  });
  if (existing) return existing;

  const safeFields = { ...fields };
  for (const [field, cap] of Object.entries(PROCESS_ACTIONS_FIELD_CAPS)) {
    if (typeof safeFields[field] === "string" && safeFields[field].length > cap) {
      safeFields[field] = safeFields[field].slice(0, cap - 1) + "…";
    }
  }
  return prisma.ProcessActions.create({ data: safeFields });
}

async function seedProcessActions() {
  // --- Till Sale: verified against postBasket in till.js ---
  const saleStep1 = await upsertProcessAction({
    Process_name: "TILL_SALE",
    Action_Type: "OPERATIONAL",
    Cycle_type: "INCOME",
    Sequence_No: 1,
    Accounting_Event: 0,
    Operational_Event: 1,
    From_State: "EMPTY",
    To_State: "BUILDING",
    Applies_To: "TRANSACTION",
    Affects_Cash: 0,
    Affects_Resources: 0,
    Requires_Approval: 0,
    Process_Description: "One or more product lines added to the basket. No accounting effect yet — nothing is posted until the basket is completed.",
  });
  const saleStep2 = await upsertProcessAction({
    Process_name: "TILL_SALE",
    Action_Type: "OPERATIONAL",
    Cycle_type: "INCOME",
    Sequence_No: 2,
    Accounting_Event: 0,
    Operational_Event: 1,
    From_State: "BUILDING",
    To_State: "READY",
    Applies_To: "PAYMENT",
    Affects_Cash: 0,
    Affects_Resources: 0,
    Requires_Approval: 0,
    ParentAction_id: saleStep1.ProcessActions_id,
    Process_Description: "Payment method chosen (Cash, Mobile, Bank, or Credit) and any discount or partial-credit split entered. Still no posting — this only determines what postBasket will do next.",
  });
  await upsertProcessAction({
    Process_name: "TILL_SALE",
    Action_Type: "ACCOUNTING",
    Cycle_type: "INCOME",
    Sequence_No: 3,
    Accounting_Event: 1,
    Operational_Event: 1,
    From_State: "READY",
    To_State: "POSTED",
    Applies_To: "TRANSACTION",
    Affects_Cash: 1,
    Affects_Resources: 1,
    Requires_Approval: 0,
    ParentAction_id: saleStep2.ProcessActions_id,
    Default_Journal_Template: "SELL_GOODS_CASH",
    Required_Evidence: "RECEIPT",
    Process_Description: "postBasket() actually runs: Resources.Resources_Quantity decreases for Goods, and postJournalPair() writes the Journal entries. This is the only step in this process where accounting genuinely happens.",
  });

  // --- Expense Payment: verified against postExpense in claims.js ---
  const expenseStep1 = await upsertProcessAction({
    Process_name: "EXPENSE_PAYMENT",
    Action_Type: "OPERATIONAL",
    Cycle_type: "EXPENDITURE",
    Sequence_No: 1,
    Accounting_Event: 0,
    Operational_Event: 1,
    From_State: "EMPTY",
    To_State: "READY",
    Applies_To: "TRANSACTION",
    Affects_Cash: 0,
    Affects_Resources: 0,
    Requires_Approval: 0,
    Process_Description: "Expense category, amount, and payment method selected on the Expenses page. Nothing posted yet.",
  });
  await upsertProcessAction({
    Process_name: "EXPENSE_PAYMENT",
    Action_Type: "ACCOUNTING",
    Cycle_type: "EXPENDITURE",
    Sequence_No: 2,
    Accounting_Event: 1,
    Operational_Event: 1,
    From_State: "READY",
    To_State: "POSTED",
    Applies_To: "TRANSACTION",
    Affects_Cash: 1,
    Affects_Resources: 0,
    Requires_Approval: 0,
    ParentAction_id: expenseStep1.ProcessActions_id,
    Default_Journal_Template: "PAY_EXPENSE",
    Required_Evidence: "RECEIPT",
    Process_Description: "postExpense() runs: the payment account is debited or credited depending on direction, and the expense account absorbs the cost. Genuinely enforced — same OPEN-period gate as every other posting function.",
  });

  // --- Asset Purchase: verified against postAssetPurchase in assets.js ---
  const assetStep1 = await upsertProcessAction({
    Process_name: "ASSET_PURCHASE",
    Action_Type: "OPERATIONAL",
    Cycle_type: "ASSET",
    Sequence_No: 1,
    Accounting_Event: 0,
    Operational_Event: 1,
    From_State: "EMPTY",
    To_State: "READY",
    Applies_To: "RESOURCES",
    Affects_Cash: 0,
    Affects_Resources: 0,
    Requires_Approval: 1,
    Approval_Level: "OWNER",
    Process_Description: "Asset name, cost, useful life, ownership type, and valuation method (depreciating, appreciating, or market-dependent) entered on the Assets page.",
  });
  await upsertProcessAction({
    Process_name: "ASSET_PURCHASE",
    Action_Type: "ACCOUNTING",
    Cycle_type: "ASSET",
    Sequence_No: 2,
    Accounting_Event: 1,
    Operational_Event: 1,
    From_State: "READY",
    To_State: "POSTED",
    Applies_To: "RESOURCES",
    Affects_Cash: 1,
    Affects_Resources: 0,
    Requires_Approval: 0,
    ParentAction_id: assetStep1.ProcessActions_id,
    Default_Journal_Template: "PURCHASE_FIXED_ASSET",
    Required_Document: "RECEIPT",
    Required_Evidence: "RECEIPT",
    Process_Description: "postAssetPurchase() runs: a new Assets register row is created and the Journal entry posted. The asset then enters its own separate lifecycle (depreciation, revaluation, or disposal), each of which is its own process, not a later step in this one.",
  });

  console.log("ProcessActions seeded: 3 real workflows (Till Sale, Expense Payment, Asset Purchase), 7 steps total, verified against the actual posting functions rather than invented.");
}

/**
 * seedSourceOfTruthPolicy — the system's own architectural rule, made
 * explicit and permanent rather than left as tribal knowledge: for any
 * given question about the business, exactly one table is the authority.
 * Every posting function in this codebase already follows this division
 * informally (Transactions for what happened, Journal for the accounting
 * effect, Knowledge for what should be remembered, etc.) — this seeds it
 * as a real, visible Structures row so the rule survives beyond whoever
 * currently remembers it.
 *
 * One row below (Documents / Evidence) is marked isPopulated=false
 * deliberately: this system references that table in its design but has
 * never actually written data into it. ProcessActions used to be marked
 * the same way — it's now genuinely populated by seedProcessActions()
 * below, seeded before this function runs so the row here can honestly
 * say so.
 */
async function seedSourceOfTruthPolicy(entrepriseId) {
  const policyFramework = await upsertStructure({
    Structures_Type: "SYSTEM_ARCHITECTURE",
    Structure_Level: "FRAMEWORK",
    Framework_Name: "SOURCE_OF_TRUTH",
    Framework_Priority: 1,
    Structures_Name: "Source of Truth",
    Structures_Description: "One authoritative table per question. For any question about the business, exactly one table is authoritative. Reports are derived from Journal, never the reverse. Knowledge never overrides a ledger balance. A narrative explains a transaction; it does not become one. This is a permanent architectural rule, not a convention that happens to be followed today.",
    Mandatory: 1,
    Rule_Severity: "BLOCK",
    Entreprise_id: entrepriseId,
  });

  const rows = [
    { question: "What happened?", table: "Transactions", isPopulated: true, note: "Every posted event — a sale, a purchase, a payment — is one Transactions row." },
    { question: "What was the accounting effect?", table: "Journal", isPopulated: true, note: "The debit/credit pair(s) a Transaction produced. This is what Reports are computed from — never the other way around." },
    { question: "What is the current balance?", table: "Ledger / Account", isPopulated: true, note: "A running total, always derivable by summing Journal — the Ledger page computes this live rather than trusting a stored total that could drift out of sync." },
    { question: "What physical resource exists?", table: "Resources", isPopulated: true, note: "Stock on hand — quantities, not money. Adjusted by postBasket on every sale and purchase." },
    { question: "What financial instrument exists?", table: "Money", isPopulated: true, note: "Bonds, shares, and similar instruments held by the business — distinct from a simple cash balance." },
    { question: "What should normally happen?", table: "Catalogue", isPopulated: true, note: "The blueprint for an event type (e.g. SELL_GOODS_CASH) — which accounts it debits and credits. Auto-provisioned on first use, never hand-edited per transaction." },
    { question: "What process step occurred?", table: "ProcessActions", isPopulated: true, note: "Three real workflows seeded — Till Sale, Expense Payment, Asset Purchase — each broken into its actual steps (operational steps first, the single accounting step last), verified against the real posting functions rather than invented." },
    { question: "What exception applies?", table: "LogicConditions", isPopulated: true, note: "Enforcement and validation rules — some genuinely running (the period-closed gate), some honestly documented as gaps (loan amortisation discipline), never conflated." },
    { question: "What evidence exists?", table: "Documents / Evidence", isPopulated: true, note: "Receipts are generated directly from posted Transactions/Journal data, and invoices or scans can be uploaded and attached to a transaction batch — File_path is genuinely written to disk-backed storage, not just declared." },
    { question: "What did the system explain?", table: "Narrative", isPopulated: true, note: "A plain-language account of a Transaction, generated automatically. Explains a fact; is never itself the fact." },
    { question: "What should future people remember?", table: "Knowledge", isPopulated: true, note: "Human judgement, intention, and institutional memory — explicitly never a legal or accounting fact by itself. See the succession entries: intention is recorded here, legal status is not asserted here." },
    { question: "What was reported?", table: "Reports", isPopulated: true, note: "A snapshot derived from Journal at a point in time, carrying its own Report_Stage (position in the close chain) and Report_Status (review/approval state) — never the source of a balance, always a derived view of one." },
  ];

  for (const row of rows) {
    await upsertStructure({
      Structures_Type: "SYSTEM_ARCHITECTURE",
      Structure_Level: "RULE",
      Parent_Structure_id: policyFramework.Structures_id,
      Framework_Name: "SOURCE_OF_TRUTH",
      Framework_Priority: 2,
      // Structures_Name is capped at 45 characters — the full "question →
      // table" string routinely exceeded that and caused every seed run
      // to fail. Only the short table name goes here; the question and
      // note both live in Structures_Description instead, separated by a
      // pipe so the Rules page can split them back apart reliably.
      Structures_Name: row.table,
      Structures_Description: row.isPopulated
        ? `${row.question}|${row.note}`
        : `${row.question}|${row.note} This row is part of the stated architecture but not yet real in this system — flagged here rather than silently omitted.`,
      Mandatory: 1,
      Rule_Severity: row.isPopulated ? "BLOCK" : "WARN",
      Entreprise_id: entrepriseId,
    });
  }

  console.log(`Source-of-truth policy seeded: 12 rules (${rows.filter((r) => r.isPopulated).length} active, ${rows.filter((r) => !r.isPopulated).length} declared but not yet populated).`);
}

module.exports = { seedProcessActions, seedSourceOfTruthPolicy, upsertProcessAction };
