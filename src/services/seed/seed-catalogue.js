let _prisma;
function getPrisma() { if (!_prisma) { _prisma = require("../posting/core").prisma; } return _prisma; }

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

// Real column caps on Structures — the actual source of the "value too
// long for the column's type" crash, hit repeatedly because earlier
// fixes only checked individual field literals, never the length of
// template-literal concatenations built from multiple fields at once
// (e.g. `${name}|${description}` can overflow even when name and
// description are each independently short enough). Enforced here as a
// defensive backstop in upsertStructure itself, so no future call site —
// however it builds its Structures_Name or Structures_Description — can
// reintroduce this crash.
const STRUCTURES_FIELD_CAPS = {
  Structure_Level: 15, Structures_Type: 45, Compliance_Level: 20,
  Business_Maturity: 20, Escalation_Role: 20, Measurement_Basis: 20,
  Framework_Name: 20, Framework_Version: 20, Rule_Code: 20,
  Standard_Reference: 45, Rule_Severity: 10, Applies_To_Table: 45,
  Structures_Name: 45, Structures_Rule: 45, Structures_Condition: 45,
  Structures_Description: 255, Recognition_Method: 45,
  Preference_key: 255, Preference_value: 255, Period_Status: 10, Period_name: 45,
};

async function upsertStructure(fields) {
  const safeFields = { ...fields };
  for (const [field, cap] of Object.entries(STRUCTURES_FIELD_CAPS)) {
    if (typeof safeFields[field] === "string" && safeFields[field].length > cap) {
      safeFields[field] = truncateAtBoundary(safeFields[field], cap);
    }
  }

  const existing = await getPrisma().Structures.findFirst({
    where: { Structures_Name: safeFields.Structures_Name, Structures_Type: safeFields.Structures_Type, Entreprise_id: safeFields.Entreprise_id },
  });

  if (existing) {
    // Genuinely update, not just skip — a prior seed run can have created
    // this row with stale content (e.g. ProcessActions' source-of-truth
    // row was created with isPopulated=false before ProcessActions was
    // ever seeded; re-running seed.js after the fix found the row already
    // existed and silently kept the stale text, which is exactly why the
    // Rules page kept showing "Declared, not yet populated" even after
    // the code said isPopulated=true).
    //
    // Deliberately excludes Period_Status (and the accounting-period-only
    // fields Structures_Period, Period_name) — an ACCOUNTING_PERIOD row's
    // open/closed state is real, live data set by actual user action
    // (opening or closing a trading day), never something a re-run of the
    // seed script should silently reset back to its original value.
    const updatable = {};
    for (const field of ["Structures_Description", "Rule_Severity", "Standard_Reference", "Recognition_Method", "Applies_To_Table", "Measurement_Basis"]) {
      if (safeFields[field] !== undefined && safeFields[field] !== existing[field]) {
        updatable[field] = safeFields[field];
      }
    }
    if (Object.keys(updatable).length > 0) {
      return getPrisma().Structures.update({ where: { Structures_id: existing.Structures_id }, data: updatable });
    }
    return existing;
  }

  return getPrisma().Structures.create({ data: safeFields });
}

/**
 * seedCatalogueEvents — the single source of truth for every Catalogue
 * event definition in the system. Called at business-creation time and
 * on every visit to the Rules page (idempotent — upsertCatalogue is
 * find-or-create, safe to re-run).
 *
 * Before this function existed, Catalogue rows were created by two
 * different mechanisms: four events seeded in main() and 35+ events
 * created on-demand inside posting functions via mustFindOrCreateCatalogue
 * or tx.Catalogue.create. This meant:
 *   — The Rules page could only show events that had already been posted
 *   — Changing a debitCode or narrativeTemplate required finding the
 *     right file among 15+ posting files
 *   — An accountant reviewing the system's rules could not see what
 *     events existed without reading source code
 *
 * Every posting function that currently calls mustFindOrCreateCatalogue
 * should eventually drop that call and simply call runCatalogueEvent
 * (which will find the already-seeded row). The transition is safe:
 * mustFindOrCreateCatalogue is find-or-create, so if the row already
 * exists from seed it returns it; if seed hasn't run yet it creates it
 * — same behaviour, just with seed as the preferred first path.
 */
async function seedCatalogueEvents(entrepriseId) {
  const E = new Date("2020-04-01");
  const def = (fields) => upsertCatalogue({ ...fields, Is_Active: 1, Version_No: 1, Effective_From: E, Entreprise_id: entrepriseId });

  // ── REVENUE CYCLE ──────────────────────────────────────────────────
  await def({
    Event_Name: "SELL_GOODS_CASH",
    Event_Description: "Cash sale. DR Cash (1000) CR Sales (4000). Also fires RECORD_COGS at point of sale. Receipt generated on completion.",
    Debit_Account_code: "1000", Credit_Account_code: "4000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "INVENTORY_DECREASE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "DAILY_SALES",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Cash sale: {Quantity} x {Product_Name} at KES {UnitPrice} = KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "RECEIPT:LineItem|DAILY_SALES:Revenue",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "SELL_SERVICE",
    Event_Description: "Service sold. DR Cash (1000) CR Service Income (4400). No COGS — service has no physical inventory.",
    Debit_Account_code: "1000", Credit_Account_code: "4400",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "DAILY_SALES",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Service sold: {Product_Name} for KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:ServiceIncome",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "SELL_UTILITY",
    Event_Description: "Utility resale (electricity token, water). DR Cash (1000) CR Utility Income (4600). Consumed immediately — no COGS or stock tracking.",
    Debit_Account_code: "1000", Credit_Account_code: "4600",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "DAILY_SALES",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Utility sold: {Product_Name} for KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:UtilityIncome",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "RECORD_COGS",
    Event_Description: "Transfer inventory cost to COGS when goods are sold. DR COGS (5000) CR Inventory (1100). Non-cash. IAS 2.",
    Debit_Account_code: "5000", Credit_Account_code: "1100",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "COGS: {Quantity} x KES {UnitCost} = KES {Amount} transferred from inventory to expense.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:COGS",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "SETTLE_RECEIVABLE",
    Event_Description: "A customer pays down an outstanding credit sale. DR payment method account CR Trade Receivables (1200). Completes the credit-sale cycle. IFRS 9.",
    Debit_Account_code: "1000", Credit_Account_code: "1200",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "DAILY_SALES",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Received KES {Amount} from a customer settling an outstanding balance. {Notes}",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Operating|BALANCE_SHEET:TradeReceivables",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PARTIAL_CREDIT_SALE",
    Event_Description: "Part of a basket sale is on credit. DR Trade Receivables (1200) CR Cash payment account. Splits the basket's payment across cash and credit.",
    Debit_Account_code: "1200", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "DAILY_SALES",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "KES {Amount} of basket {CycleRef} on credit.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:TradeReceivables",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "DISCOUNT_ALLOWED",
    Event_Description: "A discount is given to a customer. DR Discount Allowed (4900) CR Cash/Mobile/Bank. Reduces the customer-facing price below the listed price.",
    Debit_Account_code: "4900", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "DAILY_SALES",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Discount allowed: KES {Amount} on basket {CycleRef}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:DiscountAllowed",
    Default_Business_Unit: "SHOP",
  });

  // ── EXPENSE CYCLE ──────────────────────────────────────────────────
  await def({
    Event_Name: "BUY_INVENTORY_CASH",
    Event_Description: "Purchase inventory. DR Inventory (1100) CR Cash (1000). Balance sheet movement — becomes COGS only when sold. IAS 2.",
    Debit_Account_code: "1100", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "INVENTORY_INCREASE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "DAILY_PURCHASES",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Purchased {Quantity} {Product_Name} for KES {Amount}. Added to inventory.",
    Evidence_template: "RECEIPT", Report_sections: "BALANCE_SHEET:Inventory",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_UTILITY",
    Event_Description: "Pay for a utility (electricity, water). DR Utilities Expense (5400) CR Cash (1000). Consumed immediately.",
    Debit_Account_code: "5400", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Paid KES {Amount} for {Product_Name}.",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:Utilities",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_SERVICE",
    Event_Description: "Pay for a service (labour, repairs). DR Service Expense (5450) CR Cash (1000).",
    Debit_Account_code: "5450", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Paid KES {Amount} for {Product_Name}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:ServiceExpense",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_RENT",
    Event_Description: "Pay rent. DR Rent Expense (5100) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5100", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Rent paid: KES {Amount}. {Notes}",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:Rent",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_SALARIES",
    Event_Description: "Pay staff salaries. DR Salaries Expense (5200) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5200", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "OWNER", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Salaries paid: KES {Amount}. {Notes}",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:Salaries",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_UTILITIES",
    Event_Description: "Pay utility bill (electricity token, water, internet). DR Utilities Expense (5400) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5400", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Utility paid: KES {Amount}. {Notes}",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:Utilities",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_TRANSPORT",
    Event_Description: "Pay transport or fuel costs. DR Transport Expense (5300) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5300", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Transport paid: KES {Amount}. {Notes}",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:Transport",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_INSURANCE",
    Event_Description: "Pay an insurance premium. DR Insurance Expense (5600) CR Cash/Mobile/Bank. Links back to a specific policy via moneyId.",
    Debit_Account_code: "5600", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Insurance premium paid: KES {Amount}. {Notes}",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:Insurance",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_TAX",
    Event_Description: "Pay tax (VAT, income tax, county levy). DR Tax Expense (5800) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5800", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "ACCOUNTANT", Cycle_type: "EXPENDITURE", Alert_Required: 1,
    Narrative_template: "Tax paid: KES {Amount}. {Notes}",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:Tax",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_EXPENSE_OTHER",
    Event_Description: "Other operating expense. DR Other Expense (5900) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5900", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Expense paid: KES {Amount}. {Notes}",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:OtherExpense",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "SETTLE_PAYABLE",
    Event_Description: "The business pays down an outstanding credit purchase. DR Trade Payables (2000) CR Cash/Mobile/Bank. Completes the credit-purchase cycle. IFRS 9.",
    Debit_Account_code: "2000", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Paid KES {Amount} to a supplier settling an outstanding balance. {Notes}",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Operating|BALANCE_SHEET:TradePayables",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PARTIAL_CREDIT_PURCHASE",
    Event_Description: "Part of a basket purchase is on credit. DR Cash payment account CR Trade Payables (2000).",
    Debit_Account_code: "1000", Credit_Account_code: "2000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "KES {Amount} of basket {CycleRef} on credit.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:TradePayables",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "DISCOUNT_RECEIVED",
    Event_Description: "A discount is received from a supplier. DR Cash/Mobile/Bank CR Discount Received (5910). Reduces the effective purchase price.",
    Debit_Account_code: "1000", Credit_Account_code: "5910",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Discount received: KES {Amount} on basket {CycleRef}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:DiscountReceived",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "RECORD_PREPAID_EXPENSE",
    Event_Description: "Excess payment recognised as a prepaid asset. DR Prepaid Expenses (1300) CR Cash/Mobile/Bank. The owner paid more than was due — the excess is a current asset consumed in a future period. Common for insurance, rent, internet.",
    Debit_Account_code: "1300", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "BALANCE_SHEET",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Prepaid: KES {Amount} excess on {Category} payment. {Notes}",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:PrepaidExpenses",
    Default_Business_Unit: "SHOP",
  });

  // ── CAPITAL & LOAN CYCLE ───────────────────────────────────────────
  await def({
    Event_Name: "OWNER_CAPITAL_INJECTION",
    Event_Description: "Owner injects capital into the business. DR Cash/Mobile/Bank CR Owner Capital (3100). Equity event — not income.",
    Debit_Account_code: "1000", Credit_Account_code: "3100",
    Cash_Flow_Category: "FINANCING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "NONE", Cycle_type: "CAPITAL", Alert_Required: 0,
    Narrative_template: "Capital injected: KES {Amount} from owner.",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:OwnerCapital",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "CAPITAL_WITHDRAWAL",
    Event_Description: "Owner withdraws capital (drawings). DR Owner Capital (3100) CR Cash/Mobile/Bank.",
    Debit_Account_code: "3100", Credit_Account_code: "1000",
    Cash_Flow_Category: "FINANCING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "OWNER", Cycle_type: "CAPITAL", Alert_Required: 1,
    Narrative_template: "Capital withdrawn: KES {Amount}. {Notes}",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:OwnerCapital",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "LOAN_DRAWDOWN",
    Event_Description: "Borrow money. DR Cash/Mobile/Bank CR Loan Payable (2100). Financing inflow. IFRS 9 governs the financial liability. IAS 23 applies only if borrowing costs are directly attributable to a qualifying asset — ordinary working-capital loans use IFRS 9 alone.",
    Debit_Account_code: "1000", Credit_Account_code: "2100",
    Cash_Flow_Category: "FINANCING", Operational_Impact: "NONE",
    Risk_Level: "HIGH", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "OWNER", Cycle_type: "LOAN", Alert_Required: 1,
    Narrative_template: "Loan drawn down: KES {Amount}. {Notes}",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:LoanPayable",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "LOAN_REPAYMENT",
    Event_Description: "Repay a loan instalment (principal portion). DR Loan Payable (2100) CR Cash/Mobile/Bank. Reduces the outstanding liability. IFRS 9. Interest is posted separately via LOAN_INTEREST_EXPENSE.",
    Debit_Account_code: "2100", Credit_Account_code: "1000",
    Cash_Flow_Category: "FINANCING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "OWNER", Cycle_type: "LOAN", Alert_Required: 0,
    Narrative_template: "Loan repayment: KES {Amount} (principal: KES {Principal}, interest: KES {Interest}). {Notes}",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:LoanPayable",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "LOAN_INTEREST_EXPENSE",
    Event_Description: "Interest portion of a loan repayment. DR Finance Costs (5210) CR Cash/Mobile/Bank. An operating expense, not a liability reduction. IFRS 9.",
    Debit_Account_code: "5210", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "LOAN", Alert_Required: 0,
    Narrative_template: "Loan interest: KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:FinanceCosts|CASH_FLOW:Operating",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "FUND_TRANSFER",
    Event_Description: "Move money between the business's own Cash/Mobile/Bank accounts. Neither leg is a fixed Catalogue account — both resolved dynamically from the chosen payment methods.",
    Debit_Account_code: null, Credit_Account_code: null,
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "NONE", Cycle_type: "CAPITAL", Alert_Required: 0,
    Narrative_template: "Transferred KES {Amount} from {From} to {To}. {Notes}",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:Cash",
    Default_Business_Unit: "SHOP",
  });

  // ── UNIT INCOME ────────────────────────────────────────────────────
  await def({
    Event_Name: "RECEIVE_RENT_INCOME",
    Event_Description: "Collect rent from a tenant. DR Cash/Mobile/Bank CR Rent Income (4100).",
    Debit_Account_code: "1000", Credit_Account_code: "4100",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Rent received: KES {Amount} from {Stakeholder_Name}.",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:RentIncome",
    Default_Business_Unit: "RENTAL",
  });
  await def({
    Event_Name: "RECEIVE_INTEREST_INCOME",
    Event_Description: "Bond coupon or savings account interest received. DR Cash/Mobile/Bank CR Interest Income (4200).",
    Debit_Account_code: "1000", Credit_Account_code: "4200",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Interest received: KES {Amount}.",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:InterestIncome",
    Default_Business_Unit: "INVESTMENTS",
  });
  await def({
    Event_Name: "RECEIVE_DIVIDEND_INCOME",
    Event_Description: "Share dividend received. DR Cash/Mobile/Bank CR Dividend Income (4300).",
    Debit_Account_code: "1000", Credit_Account_code: "4300",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "Dividend received: KES {Amount}.",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:DividendIncome",
    Default_Business_Unit: "INVESTMENTS",
  });

  // ── ASSET CYCLE ────────────────────────────────────────────────────
  await def({
    Event_Name: "PURCHASE_FIXED_ASSET",
    Event_Description: "Purchase a fixed asset. DR PPE (1400) CR Cash/Mobile/Bank. Creates an Assets row for depreciation. IAS 16.",
    Debit_Account_code: "1400", Credit_Account_code: "1000",
    Cash_Flow_Category: "INVESTING", Operational_Impact: "NONE",
    Risk_Level: "HIGH", Documentation_type: "RECEIPT", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "ASSET", Alert_Required: 1,
    Narrative_template: "Purchased {Product_Name} for KES {Amount}. Useful life {UsefulLife} years, residual value KES {Residual}.",
    Evidence_template: "RECEIPT", Report_sections: "BALANCE_SHEET:PPE|ASSET_REGISTER:Addition",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "RECORD_DEPRECIATION",
    Event_Description: "Periodic depreciation. DR Depreciation Expense (5700) CR Accumulated Depreciation (1410). Non-cash. IAS 16.",
    Debit_Account_code: "5700", Credit_Account_code: "1410",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "NONE", Cycle_type: "ASSET", Alert_Required: 0,
    Narrative_template: "Depreciation posted for {Product_Name}: KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:DepreciationExpense|BALANCE_SHEET:AccumDepreciation",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "RECORD_IMPAIRMENT",
    Event_Description: "Impairment write-down. DR Impairment Loss (5921) CR PPE (1400). Non-cash. IAS 36.",
    Debit_Account_code: "5921", Credit_Account_code: "1400",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "ASSET", Alert_Required: 1,
    Narrative_template: "Impairment recorded for {Product_Name}: KES {Amount} write-down. {Reason}",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:ImpairmentLoss|BALANCE_SHEET:PPE",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "REVALUE_ASSET_UP",
    Event_Description: "Upward revaluation of an appreciating asset. DR PPE (1400) CR Revaluation Surplus (3200). IAS 16.",
    Debit_Account_code: "1400", Credit_Account_code: "3200",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "ASSET", Alert_Required: 1,
    Narrative_template: "{Product_Name} revalued upward by KES {Amount} to KES {NewValue}. {Reason}",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:PPE|BALANCE_SHEET:RevaluationSurplus",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "REVALUE_ASSET_DOWN",
    Event_Description: "Downward revaluation of a market-dependent asset. DR Revaluation Loss (5922) CR PPE (1400). IAS 16.",
    Debit_Account_code: "5922", Credit_Account_code: "1400",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "ASSET", Alert_Required: 1,
    Narrative_template: "{Product_Name} revalued downward by KES {Amount} to KES {NewValue}. {Reason}",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:PPE|INCOME_STATEMENT:RevaluationLoss",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "DISPOSE_FIXED_ASSET",
    Event_Description: "Dispose of a fixed asset. Removes cost and accumulated depreciation, recognises proceeds and gain/loss. IAS 16.",
    Debit_Account_code: "1000", Credit_Account_code: "1400",
    Cash_Flow_Category: "INVESTING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "RECEIPT", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "ASSET", Alert_Required: 1,
    Narrative_template: "Disposed of {Product_Name} for KES {Amount}. {GainLossLabel}: KES {GainLossAmount}.",
    Evidence_template: "RECEIPT", Report_sections: "BALANCE_SHEET:PPE|ASSET_REGISTER:Disposal|INCOME_STATEMENT:GainLossOnDisposal",
    Default_Business_Unit: "SHOP",
  });

  // ── INVESTMENT CYCLE ───────────────────────────────────────────────
  await def({
    Event_Name: "PURCHASE_INVESTMENT",
    Event_Description: "Acquire a financial instrument. DR Investments (1500) CR Cash/Mobile/Bank. IFRS 9.",
    Debit_Account_code: "1500", Credit_Account_code: "1000",
    Cash_Flow_Category: "INVESTING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "INVESTMENT", Alert_Required: 1,
    Narrative_template: "Acquired {Product_Name} for KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:Investments|CASH_FLOW:Investing",
    Default_Business_Unit: "INVESTMENTS",
  });
  await def({
    Event_Name: "SELL_INVESTMENT",
    Event_Description: "Sell or redeem a financial instrument. DR Cash/Mobile/Bank CR Investments (1500) at carrying, gain/loss recognised. IFRS 9.",
    Debit_Account_code: "1000", Credit_Account_code: "1500",
    Cash_Flow_Category: "INVESTING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "INVESTMENT", Alert_Required: 1,
    Narrative_template: "Sold {Product_Name} for KES {Amount}. {GainLossLabel}: KES {GainLossAmount}.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:Investments|CASH_FLOW:Investing|INCOME_STATEMENT:GainLossOnDisposal",
    Default_Business_Unit: "INVESTMENTS",
  });

  // ── LEASE & LESSOR CYCLE ───────────────────────────────────────────
  await def({
    Event_Name: "LEASE_COMMENCEMENT",
    Event_Description: "Recognise a Right-of-Use asset and Lease Liability at lease start. DR ROU Asset (1600) CR Lease Liability (2200). IFRS 16.",
    Debit_Account_code: "1600", Credit_Account_code: "2200",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "ASSET_REGISTER",
    Escalation_Role: "OWNER", Cycle_type: "ASSET", Alert_Required: 1,
    Narrative_template: "Lease commenced: {Product_Name}. ROU asset and Lease Liability of KES {Amount} recognised over {Years} years.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:RightOfUseAsset|BALANCE_SHEET:LeaseLiability",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "LEASE_PAYMENT",
    Event_Description: "A lease payment reduces the Lease Liability. DR Lease Liability (2200) CR Cash/Mobile/Bank. IFRS 16.",
    Debit_Account_code: "2200", Credit_Account_code: "1000",
    Cash_Flow_Category: "FINANCING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "NONE", Cycle_type: "ASSET", Alert_Required: 0,
    Narrative_template: "Lease payment of KES {Amount} made, reducing the lease liability.",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:LeaseLiability",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "LEASE_OUT_INVENTORY",
    Event_Description: "A specific inventory unit is leased out instead of sold. Unit stays owned, status LEASED_OUT. DR Cash/Mobile/Bank CR Rental Income (4700).",
    Debit_Account_code: "1000", Credit_Account_code: "4700",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "RENT", Alert_Required: 0,
    Narrative_template: "{Product_Name} leased out for KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:RentalIncome",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "EQUIPMENT_HIRE",
    Event_Description: "Owned equipment hired out. Equipment stays owned and depreciates normally. DR Cash/Mobile/Bank CR Rental Income (4700).",
    Debit_Account_code: "1000", Credit_Account_code: "4700",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "RENT", Alert_Required: 0,
    Narrative_template: "{Assets_Type} hired out for KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:RentalIncome",
    Default_Business_Unit: "SHOP",
  });

  // ── INSURANCE & PROVISION CYCLE ────────────────────────────────────
  await def({
    Event_Name: "RECORD_PROVISION",
    Event_Description: "Recognise an estimated obligation at the point it arises. DR Warranty Expense (5930) CR Provision for Warranties (2300). IAS 37.",
    Debit_Account_code: "5930", Credit_Account_code: "2300",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Provision of KES {Amount} recognised. {Notes}",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:WarrantyExpense|BALANCE_SHEET:Provisions",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "UTILISE_PROVISION",
    Event_Description: "A warranty claim honoured, drawing down the provision. DR Provision for Warranties (2300) CR Cash/Mobile/Bank. IAS 37.",
    Debit_Account_code: "2300", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "Warranty claim of KES {Amount} honoured, drawing down the existing provision.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:Provisions|CASH_FLOW:Operating",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "INSURANCE_CLAIM_RECEIPT",
    Event_Description: "An insurer pays a claim. DR Cash/Mobile/Bank CR Insurance Claim Income (4800). Genuinely income, not a reversal of the premium.",
    Debit_Account_code: "1000", Credit_Account_code: "4800",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 1,
    Narrative_template: "Insurance claim received: KES {Amount} against policy '{Policy_Name}'. {Notes}",
    Evidence_template: "RECEIPT", Report_sections: "INCOME_STATEMENT:InsuranceClaimIncome|CASH_FLOW:Operating",
    Default_Business_Unit: "SHOP",
  });

  // ── AGRICULTURE & LIVESTOCK CYCLE (IAS 41) ────────────────────────
  await def({
    Event_Name: "LIVESTOCK_BIRTH",
    Event_Description: "A new animal born — IAS 41 fair value gain. DR Biological Assets (1450) CR Gain on Biological Assets (4550).",
    Debit_Account_code: "1450", Credit_Account_code: "4550",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "{Animal_Tag} born to {Parent_Tag}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:GainOnBiologicalAssets",
    Default_Business_Unit: "FARM",
  });
  await def({
    Event_Name: "LIVESTOCK_LOSS",
    Event_Description: "An animal dies or spoils. DR Loss on Biological Assets (5950) CR Biological Assets (1450). IAS 41.",
    Debit_Account_code: "5950", Credit_Account_code: "1450",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "EXPENDITURE", Alert_Required: 0,
    Narrative_template: "{Animal_Tag} lost — {Reason}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:LossOnBiologicalAssets",
    Default_Business_Unit: "FARM",
  });
  await def({
    Event_Name: "LIVESTOCK_THEFT",
    Event_Description: "An animal is stolen — distinct from loss for risk pattern review. DR Loss from Theft (5951) CR Biological Assets (1450). IAS 41.",
    Debit_Account_code: "5951", Credit_Account_code: "1450",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "HIGH", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "OWNER", Cycle_type: "EXPENDITURE", Alert_Required: 1,
    Narrative_template: "{Animal_Tag} stolen — {Reason}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:LossOnBiologicalAssets",
    Default_Business_Unit: "FARM",
  });
  await def({
    Event_Name: "HARVEST",
    Event_Description: "A crop planting matures into sellable inventory. DR Inventory (1100) CR Biological Assets (1450). IAS 41 governs the biological asset up to the point of harvest; after harvest the produce enters IAS 2 (Inventory) for measurement and sale.",
    Debit_Account_code: "1100", Credit_Account_code: "1450",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INVENTORY", Alert_Required: 0,
    Narrative_template: "{Animal_Tag} harvested into {Quantity} {Product_Name}.",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:Inventory",
    Default_Business_Unit: "FARM",
  });

  // ── PRODUCTION & COSTING ───────────────────────────────────────────
  await def({
    Event_Name: "REPACKAGE_INVENTORY",
    Event_Description: "Convert input products into an output product. DR Output Inventory CR each input's Inventory at cost. Spoilage posted separately. No cash movement.",
    Debit_Account_code: "1100", Credit_Account_code: "1100",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INVENTORY", Alert_Required: 0,
    Narrative_template: "Repackaged {InputSummary} into {Quantity} {Product_Name}. {SpoilageNote}",
    Evidence_template: "NONE", Report_sections: "BALANCE_SHEET:Inventory",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "SERVICE_BILLED",
    Event_Description: "A work-in-progress service engagement billed to the client. DR Cash/Mobile/Bank/Receivable CR Service Income (4400). IFRS 15.",
    Debit_Account_code: "1000", Credit_Account_code: "4400",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INCOME", Alert_Required: 0,
    Narrative_template: "{Product_Name} billed: {Hours}h at KES {Hourly_Rate}/hr, KES {Amount} total.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:ServiceIncome",
    Default_Business_Unit: "SHOP",
  });

  // ── PAYROLL / SEASONAL LABOUR ──────────────────────────────────────
  await def({
    Event_Name: "PAY_SEASONAL_LABOUR",
    Event_Description: "Payment to temporary/seasonal workers — cash-in-hand per day or per task. DR Casual Labour Expense (5250) CR Cash/Mobile/Bank. No statutory deductions.",
    Debit_Account_code: "5250", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "PAYROLL", Alert_Required: 0,
    Narrative_template: "{Description}: {Days} days at KES {Rate}/day = KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:CasualLabour",
    Default_Business_Unit: "FARM",
  });
  await def({
    Event_Name: "PAY_SALARY",
    Event_Description: "Pay a named team member their salary or wage. DR Salaries Expense (5200) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5200", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "PAYROLL", Alert_Required: 0,
    Narrative_template: "Salary payment to {Employee_Name}: KES {Amount} for {Period}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:SalariesExpense|CASH_FLOW:Operating",
    Default_Business_Unit: "SHOP",
  });
  await def({
    Event_Name: "PAY_COMMISSION",
    Event_Description: "Pay commission based on Arrangement_Rate percentage. DR Commission Expense (5220) CR Cash/Mobile/Bank.",
    Debit_Account_code: "5220", Credit_Account_code: "1000",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "PAYROLL", Alert_Required: 0,
    Narrative_template: "Commission payment to {Employee_Name}: KES {Amount} for {Period}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:CommissionExpense|CASH_FLOW:Operating",
    Default_Business_Unit: "SHOP",
  });

  // ── BOND / INVESTMENT INTEREST CYCLE ───────────────────────────────
  await def({
    Event_Name: "ACCRUE_INVESTMENT_INTEREST",
    Event_Description: "Interest earned on a bond or investment but not yet received in cash. DR Interest Receivable (1210) CR Interest Income (4200). Accrual basis — cash comes later when the coupon is paid. IFRS 9.",
    Debit_Account_code: "1210", Credit_Account_code: "4200",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "INVESTMENT", Alert_Required: 0,
    Narrative_template: "Interest accrued on {Investment_Name}: KES {Amount}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:InterestIncome|BALANCE_SHEET:InterestReceivable",
    Default_Business_Unit: "INVESTMENTS",
  });
  await def({
    Event_Name: "RECEIVE_COUPON",
    Event_Description: "Cash receipt of previously accrued investment interest. DR Cash/Mobile/Bank CR Interest Receivable (1210). Settles the accrual — NOT income recognition (that happened at accrual). IFRS 9.",
    Debit_Account_code: "1000", Credit_Account_code: "1210",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "BANK_STATEMENT", Report_trigger: "CASH_FLOW",
    Escalation_Role: "NONE", Cycle_type: "INVESTMENT", Alert_Required: 0,
    Narrative_template: "Coupon received on {Investment_Name}: KES {Amount}.",
    Evidence_template: "BANK_STATEMENT", Report_sections: "CASH_FLOW:Operating|BALANCE_SHEET:InterestReceivable",
    Default_Business_Unit: "INVESTMENTS",
  });

  // ── RENTAL ARREARS CYCLE ───────────────────────────────────────────
  await def({
    Event_Name: "RECORD_RENT_ARREARS",
    Event_Description: "Rent is due but the tenant has not paid. DR Rent Receivable (1220) CR Rental Income (4100). Income is recognised (the tenant owes it), cash comes later. IFRS 15.",
    Debit_Account_code: "1220", Credit_Account_code: "4100",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "OWNER", Cycle_type: "RENT", Alert_Required: 1,
    Narrative_template: "Rent arrears: KES {Amount} owed by {Tenant_Name} for {Period}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:RentalIncome|BALANCE_SHEET:RentReceivable",
    Default_Business_Unit: "RENTAL",
  });
  await def({
    Event_Name: "SETTLE_RENT_ARREARS",
    Event_Description: "Tenant pays outstanding rent. DR Cash/Mobile/Bank CR Rent Receivable (1220). Settles the arrears — NOT income recognition (that happened when arrears were recorded). IFRS 9.",
    Debit_Account_code: "1000", Credit_Account_code: "1220",
    Cash_Flow_Category: "OPERATING", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "RECEIPT", Report_trigger: "CASH_FLOW",
    Escalation_Role: "NONE", Cycle_type: "RENT", Alert_Required: 0,
    Narrative_template: "Rent arrears settled: KES {Amount} received from {Tenant_Name}.",
    Evidence_template: "RECEIPT", Report_sections: "CASH_FLOW:Operating|BALANCE_SHEET:RentReceivable",
    Default_Business_Unit: "RENTAL",
  });

  // ── BIOLOGICAL ASSET REVALUATION (IAS 41) ──────────────────────────
  await def({
    Event_Name: "REVALUE_BIOLOGICAL_ASSET_UP",
    Event_Description: "Fair value increase on a biological asset (animal grows, crop matures). DR Biological Assets (1450) CR Gain on Biological Assets (4550). IAS 41 — fair value change recognised in profit or loss.",
    Debit_Account_code: "1450", Credit_Account_code: "4550",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "LOW", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "FARMING", Alert_Required: 0,
    Narrative_template: "{Animal_Tag} revalued upward by KES {Amount} to KES {NewValue}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:GainOnBiologicalAssets|BALANCE_SHEET:BiologicalAssets",
    Default_Business_Unit: "FARM",
  });
  await def({
    Event_Name: "REVALUE_BIOLOGICAL_ASSET_DOWN",
    Event_Description: "Fair value decrease on a biological asset (disease, drought, market price drop). DR Loss on Biological Assets (5950) CR Biological Assets (1450). IAS 41.",
    Debit_Account_code: "5950", Credit_Account_code: "1450",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "INCOME_STATEMENT",
    Escalation_Role: "NONE", Cycle_type: "FARMING", Alert_Required: 0,
    Narrative_template: "{Animal_Tag} revalued downward by KES {Amount} to KES {NewValue}.",
    Evidence_template: "NONE", Report_sections: "INCOME_STATEMENT:LossOnBiologicalAssets|BALANCE_SHEET:BiologicalAssets",
    Default_Business_Unit: "FARM",
  });

  // ── SUCCESSION / INHERITANCE ───────────────────────────────────────
  await def({
    Event_Name: "SUCCESSION_TRANSFER",
    Event_Description: "Transfer of ownership equity from outgoing owner to successor. DR Outgoing Owner Capital (3100) CR Incoming Owner Capital (3100). Equity reallocation — no cash movement. IAS 1 Change in Equity.",
    Debit_Account_code: "3100", Credit_Account_code: "3100",
    Cash_Flow_Category: "NONE", Operational_Impact: "NONE",
    Risk_Level: "HIGH", Documentation_type: "NONE", Report_trigger: "EQUITY_STATEMENT",
    Escalation_Role: "LAWYER", Cycle_type: "INHERITANCE", Alert_Required: 1,
    Narrative_template: "Business succession: {OutgoingName} transfers KES {Amount} to {IncomingName}.",
    Evidence_template: "NONE", Report_sections: "EQUITY_STATEMENT:ChangesInEquity|SUCCESSION_REPORT:OwnershipTransfer",
    Default_Business_Unit: "SHOP",
  });
}

async function upsertCatalogue(fields) {
  const existing = await getPrisma().Catalogue.findFirst({ where: { Event_Name: fields.Event_Name, Entreprise_id: fields.Entreprise_id } });
  if (existing) return existing;
  return getPrisma().Catalogue.create({ data: fields });
}

module.exports = { seedCatalogueEvents, upsertCatalogue, truncateAtBoundary, upsertStructure };
