/**
 * Seed data adapted from the standardized Village Hope Enterprises reference
 * seed (project_plan6a development seed). Faithful to that design's account
 * codes, Catalogue event split (SELL_GOODS_CASH + RECORD_COGS as two
 * separate events), and the balance-sheet-only treatment of inventory
 * purchases (BUY_INVENTORY_CASH never touches an expense account).
 *
 * Run once against a fresh database:
 *   docker compose exec app node src/services/seed.js
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { postFunding, postAssetPurchase, postBasket } = require("./postingEngine");
const prisma = new PrismaClient();

async function main() {
  // ---------------------------------------------------------------
  // 0. Resolve which business this seed data belongs to. Under the
  //    multi-tenancy model every row needs an Entreprise_id — find the
  //    existing Chebet/test Organisation if one exists, or create it if
  //    this is a genuinely fresh database. All Chebet seed data below is
  //    scoped to this one Entreprise_id.
  // ---------------------------------------------------------------
  let organisation = await prisma.Organisation.findFirst({ orderBy: { Entreprise_id: "asc" } });
  if (!organisation) {
    const placeholderCatalogue = await prisma.Catalogue.create({
      data: { Event_Name: "ORGANISATION_ROOT", Event_Description: "Placeholder anchor for the Organisation row — not a real business event." },
    });
    const placeholderAccount = await prisma.Account.create({
      data: { Account_Name: "Organisation Anchor", Account_Type: "ASSET", Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 0 },
    });
    organisation = await prisma.Organisation.create({
      data: {
        Organisational_Name: "Chebet Family Enterprises",
        Account_id: placeholderAccount.Account_id,
        Catalogue_id: placeholderCatalogue.Catalogue_id,
      },
    });
  }
  const entrepriseId = organisation.Entreprise_id;
  console.log(`Seeding against Organisation "${organisation.Organisational_Name}" (Entreprise_id ${entrepriseId})`);

  const codes = await seedAccountCodes(entrepriseId);
  const accounts = await seedAccounts(codes, entrepriseId);

  const businessUnits = {};
  for (const [code, name, description] of [
    ["SHOP", "Village Shop", "Retail shop — daily sales of milk, eggs, and household goods."],
    ["FARM", "Family Farm", "Dairy, poultry, and produce — supplies the shop and outside SACCOs."],
    ["RENTAL", "Rental Houses", "Fifteen one-bedroom rental houses in Nakuru."],
    ["INVESTMENTS", "Investments", "Co-operative Bank shares and government infrastructure bonds."],
  ]) {
    businessUnits[code] = await upsertStructure({
      Structures_Type: "BUSINESS_UNIT",
      Framework_Name: "INTERNAL",
      Framework_Priority: 4,
      Structures_Name: code,
      Structures_Description: `${name} — ${description}`,
      Period_Status: null,
      Mandatory: 1,
      Rule_Severity: "INFO",
      Applies_To_Table: "TRANSACTION",
      Entreprise_id: entrepriseId,
    });
  }
  const shopUnit = businessUnits.SHOP;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const openPeriod = await upsertStructure({
    Structures_Type: "ACCOUNTING_PERIOD",
    Framework_Name: "INTERNAL",
    Framework_Priority: 4,
    Structures_Name: todayStr,
    Structures_Description: `Trading day ${todayStr}`,
    Period_name: todayStr,
    Period_Status: "OPEN",
    Structures_Period: today,
    Effective_From: today,
    Effective_To: today,
    Mandatory: 1,
    Rule_Severity: "BLOCK",
    Entreprise_id: entrepriseId,
  });

  await seedCatalogueEvents(entrepriseId);

  const sugar = await upsertProduct("Sugar (1kg)", 150, 120, "SHOP", entrepriseId);
  const soap = await upsertProduct("Bar Soap", 60, 40, "SHOP", entrepriseId);
  await upsertResource(sugar.Product_id, 50);
  await upsertResource(soap.Product_id, 30);

  // ---------------------------------------------------------------
  // 6. Management — login accounts for the four roles.
  //    Default passwords are printed once at seed time; change them
  //    immediately via a real password-change flow in production.
  // ---------------------------------------------------------------
  const catalogueForManagement = await prisma.Catalogue.findFirst({ where: { Event_Name: "SELL_GOODS_CASH", Entreprise_id: entrepriseId } });
  const people = [
    { name: "Owner", username: "owner", password: "owner123", accessLevel: "OWNER_FULL", role: "Owner" },
    { name: "Accountant", username: "accountant", password: "accountant123", accessLevel: "ACCOUNTANT", role: "Accountant" },
    { name: "Advisor", username: "advisor", password: "advisor123", accessLevel: "ADVISOR", role: "Advisor" },
    { name: "Cashier", username: "cashier", password: "cashier123", accessLevel: "CASHIER", role: "Employee" },
  ];
  for (const p of people) {
    await upsertManagement(p, catalogueForManagement.Catalogue_id, entrepriseId);
  }

  // ---------------------------------------------------------------
  // 7. Chebet family biography — Stakeholders, family Management links,
  //    and SHOP/FARM catalog. Stage 1 of the staged seeding plan.
  // ---------------------------------------------------------------
  await seedChebetFamily(catalogueForManagement.Catalogue_id, entrepriseId);

  // ---------------------------------------------------------------
  // 8. Accounting rules — real Structures (STANDARD/ACCOUNTING_POLICY)
  //    rows with actual IAS/IFRS references tied to the Catalogue events
  //    we've built, plus LogicConditions rows documenting the enforcement
  //    logic already live in the posting engine (period gating, balance
  //    check). Feeds the Settings > Rules page.
  // ---------------------------------------------------------------
  // Standards and the Source of Truth policy are universal accounting/
  // system knowledge, not specific to this one business — seeded once
  // with Entreprise_id=NULL so every business shares the same copy,
  // matching how LogicConditions (enforcement rules) already worked.
  await seedAccountingRules(null);
  await seedProcessActions();
  await seedSourceOfTruthPolicy(null);

  console.log("Seed complete.");
  console.log(`Open period Structures_id: ${openPeriod.Structures_id}`);
  console.log(`SHOP business unit Structures_id: ${shopUnit.Structures_id}`);
  console.log(`Cash Account_id: ${accounts.cash.Account_id}`);
  console.log("Login accounts (username / password):");
  for (const p of people) {
    console.log(`  ${p.username} / ${p.password}  (${p.accessLevel})`);
  }
}

async function upsertManagement({ name, username, password, accessLevel, role }, catalogueId, entrepriseId) {
  const existing = await prisma.Management.findFirst({ where: { Username: username, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  const hash = await bcrypt.hash(password, 10);
  return prisma.Management.create({
    data: {
      Catalogue_id: catalogueId,
      Management_Name: name,
      Management_Role: role,
      Administration_type: role,
      Access_Level: accessLevel,
      Username: username,
      Password_Hash: hash,
      Entreprise_id: entrepriseId,
    },
  });
}

async function seedAccountCodes(entrepriseId) {
  const rows = [
    ["1000", "Cash and Cash Equivalents", "ASSET", "CURRENT_ASSET"],
    ["1100", "Inventory", "ASSET", "CURRENT_ASSET"],
    ["1400", "Property Plant and Equipment", "ASSET", "NON_CURRENT_ASSET"],
    ["4000", "Sales — Retail", "INCOME", "OPERATING_INCOME"],
    ["5000", "Cost of Goods Sold", "EXPENDITURE", "COGS"],
  ];
  const out = {};
  for (const [code, name, category, section] of rows) {
    out[code] = await upsertCode(code, name, category, section, entrepriseId);
  }
  return out;
}

async function seedAccounts(codes, entrepriseId) {
  return {
    cash: await upsertAccount("Cash / Till", "ASSET", codes["1000"].Account_codes_id, "DEBIT", entrepriseId),
    inventory: await upsertAccount("Inventory", "ASSET", codes["1100"].Account_codes_id, "DEBIT", entrepriseId),
    ppe: await upsertAccount("Property Plant and Equipment", "ASSET", codes["1400"].Account_codes_id, "DEBIT", entrepriseId),
    sales: await upsertAccount("Sales Revenue", "INCOME", codes["4000"].Account_codes_id, "CREDIT", entrepriseId),
    cogs: await upsertAccount("Cost of Goods Sold", "EXPENDITURE", codes["5000"].Account_codes_id, "DEBIT", entrepriseId),
  };
}

async function upsertCode(code, name, category, statementSection, entrepriseId) {
  const existing = await prisma.Account_codes.findFirst({ where: { Code: code, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return prisma.Account_codes.create({
    data: { Code: code, Code_name: name, Code_categories: category, Statement_Section: statementSection, Is_Active: 1, Entreprise_id: entrepriseId },
  });
}

async function upsertAccount(name, type, codeId, normalBalance, entrepriseId) {
  const existing = await prisma.Account.findFirst({ where: { Account_Code_id: codeId, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return prisma.Account.create({
    data: {
      Account_Name: name,
      Account_Type: type,
      Account_Code_id: codeId,
      Normal_Balance: normalBalance,
      Current_Balance: 0,
      Authoritative_Source: "JOURNAL",
      Is_Active: 1,
      Entreprise_id: entrepriseId,
    },
  });
}

/**
 * truncateAtBoundary — cuts a string to fit within maxLength, breaking at
 * the last sentence end (". ") if one exists within range, otherwise the
 * last word boundary, so truncated text still reads as a complete
 * thought rather than stopping mid-word. Appends "…" when actually cut.
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

  const existing = await prisma.Structures.findFirst({
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
      return prisma.Structures.update({ where: { Structures_id: existing.Structures_id }, data: updatable });
    }
    return existing;
  }

  return prisma.Structures.create({ data: safeFields });
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
    Event_Description: "Repay a loan instalment. DR Loan Payable (2100) CR Cash/Mobile/Bank. Reduces the outstanding liability. IFRS 9. Note: this system currently treats the full payment as principal reduction — a future improvement should split principal and interest components.",
    Debit_Account_code: "2100", Credit_Account_code: "1000",
    Cash_Flow_Category: "FINANCING", Operational_Impact: "NONE",
    Risk_Level: "MEDIUM", Documentation_type: "NONE", Report_trigger: "CASH_FLOW",
    Escalation_Role: "OWNER", Cycle_type: "LOAN", Alert_Required: 0,
    Narrative_template: "Loan repayment: KES {Amount}. {Notes}",
    Evidence_template: "NONE", Report_sections: "CASH_FLOW:Financing|BALANCE_SHEET:LoanPayable",
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
  const existing = await prisma.Catalogue.findFirst({ where: { Event_Name: fields.Event_Name, Entreprise_id: fields.Entreprise_id } });
  if (existing) return existing;
  return prisma.Catalogue.create({ data: fields });
}

async function upsertProduct(name, price, cost, businessUnit = "SHOP", entrepriseId) {
  const existing = await prisma.Product.findFirst({ where: { Product_Name: name, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return prisma.Product.create({
    data: { Product_Name: name, Product_type: "Goods", Product_Price: price, Product_Cost: cost, Product_Unit: "unit", Business_Unit: businessUnit, Entreprise_id: entrepriseId },
  });
}

async function upsertResource(productId, quantity) {
  const existing = await prisma.Resources.findFirst({ where: { Product_id: productId } });
  if (existing) return existing;
  return prisma.Resources.create({
    data: {
      Product_id: productId,
      Resource_type: "INVENTORY",
      Resource_Class: "INVENTORY",
      Resources_Quantity: quantity,
      Resources_Status: "AVAILABLE",
      Resources_Source: "PURCHASE",
      Last_updated: new Date(),
    },
  });
}

/**
 * seedChebetFamily — Stage 1 of the Chebet family biography seeding.
 * Real Stakeholder + Management rows for Daniel, Grace, the niece
 * (advisor), and the grandson (successor), plus FARM catalog items
 * (milk, eggs) so the FARM business unit has real products to sell
 * from, matching the multi-unit test case.
 *
 * Deliberately does NOT touch RENTAL or INVESTMENTS yet, or write any
 * Knowledge/succession narrative entries — those are Stage 2.
 */
async function seedChebetFamily(defaultCatalogueId, entrepriseId) {
  // --- Stakeholders: the people behind the business ---
  const daniel = await upsertStakeholder({
    First_name: "Daniel",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Owner",
    Stakeholder_Role: "Owner",
    Relationship_to_owner: null, // Daniel is the owner himself
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const grace = await upsertStakeholder({
    First_name: "Grace",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Owner",
    Stakeholder_Role: "Owner",
    Relationship_to_owner: "Spouse",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const niece = await upsertStakeholder({
    First_name: "Niece",
    Last_name: "Chebet",
    Location: "Nairobi",
    Stakeholder_Category: "Accountant", // financial guidance, per the biography
    Stakeholder_Role: "Employee",
    Relationship_to_owner: "Niece",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const grandson = await upsertStakeholder({
    First_name: "Grandson",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Child Successor",
    Stakeholder_Role: "Employee",
    Relationship_to_owner: "Grandson",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const daughterInLaw = await upsertStakeholder({
    First_name: "Daughter-in-law",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Employee",
    Stakeholder_Role: "Employee",
    Relationship_to_owner: "Daughter-in-law",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  // The son — modelled as data, not just narrative, because his reduced
  // involvement in succession planning is a structurally significant fact
  // the schema should be able to show: Relationship_Status=ESTRANGED and
  // Inheritance_Status=EXCLUDED, not merely described in prose.
  const son = await upsertStakeholder({
    First_name: "Son",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Owner", // family member by birth, not by role
    Stakeholder_Role: "Owner",
    Relationship_to_owner: "Son",
    Relationship_Status: "ESTRANGED", // reduced day-to-day involvement in family affairs — see the Knowledge entry for the family's stated reasoning
    Entreprise_id: entrepriseId,
  });

  // --- Management: their roles/access in the system ---
  await upsertManagementForStakeholder({
    stakeholderId: daniel.Stakeholder_id,
    name: "Daniel Chebet",
    role: "Owner",
    administrationType: "Owner",
    inheritanceStatus: "CURRENT_OWNER",
    accessLevel: "OWNER_FULL",
    catalogueId: defaultCatalogueId,
    username: "daniel",
    password: "daniel123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: grace.Stakeholder_id,
    name: "Grace Chebet",
    role: "Manager",
    administrationType: "Family",
    inheritanceStatus: "CURRENT_OWNER", // co-owner of the farm specifically
    accessLevel: "MANAGER",
    catalogueId: defaultCatalogueId,
    username: "grace",
    password: "grace123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: niece.Stakeholder_id,
    name: "Niece (Advisor)",
    role: "Advisor",
    administrationType: "Family",
    inheritanceStatus: "ADVISOR",
    accessLevel: "ADVISOR",
    catalogueId: defaultCatalogueId,
    username: "niece",
    password: "niece123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: grandson.Stakeholder_id,
    name: "Grandson (Successor)",
    role: "Employee",
    administrationType: "child",
    inheritanceStatus: "SUCCESSOR",
    accessLevel: "VIEWER", // preparing for succession, not yet operating the business
    catalogueId: defaultCatalogueId,
    username: "grandson",
    password: "grandson123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: daughterInLaw.Stakeholder_id,
    name: "Daughter-in-law",
    role: "Manager",
    administrationType: "Family",
    inheritanceStatus: null, // not part of the succession line per the biography
    accessLevel: "MANAGER",
    catalogueId: defaultCatalogueId,
    arrangementType: "PROFIT_SHARE",
    arrangementRate: 50, // fifty-fifty profit share on produce she manages
    username: "daughterinlaw",
    password: "family123",
    entrepriseId,
  });

  // The son has a Management row so the exclusion is structurally visible
  // (Inheritance_Status=EXCLUDED), not just narrated in Knowledge text. No
  // login credentials — he has no active operating role in the business.
  await upsertManagementForStakeholder({
    stakeholderId: son.Stakeholder_id,
    name: "Son",
    role: "None",
    administrationType: "Family",
    inheritanceStatus: "EXCLUDED",
    accessLevel: "VIEWER",
    catalogueId: defaultCatalogueId,
    entrepriseId,
  });

  // --- FARM catalog: milk and eggs, the two products the biography
  //     explicitly says feed the shop from the farm. Stock is seeded at 0
  //     and then built up through a real posted purchase — not a manufactured
  //     "today's remaining stock" figure with no transaction behind it.
  //     Narratives should explain facts, not invent them.
  const milk = await upsertProduct("Fresh Milk (1L)", 80, 55, "FARM", entrepriseId);
  const eggs = await upsertProduct("Eggs (each)", 15, 10, "FARM", entrepriseId);
  await upsertResource(milk.Product_id, 0);
  await upsertResource(eggs.Product_id, 0);

  // The farm delivers today's milk and eggs to the shop as an actual
  // inventory purchase — DR Inventory CR Cash — so the resulting stock
  // quantity is a real consequence of a posted transaction, matching how
  // every other product's stock in this system is derived.
  const existingMilkDelivery = await prisma.Journal.findFirst({ where: { Description: { startsWith: "BUY_INVENTORY_CASH" }, Entreprise_id: entrepriseId, Product_id: milk.Product_id } });
  if (!existingMilkDelivery) {
    await postBasket({
      mode: "buy",
      lines: [{ productId: milk.Product_id, quantity: 80, unitPrice: 55 }], // today's ~80L farm delivery, at cost
      paymentMethod: "CASH",
      businessUnit: "FARM",
      entrepriseId,
    });
    // Today's selling activity so far — 68L sold, 12L genuinely remaining,
    // both numbers now real consequences of posted transactions rather than
    // an assumed opening balance.
    await postBasket({
      mode: "sell",
      lines: [{ productId: milk.Product_id, quantity: 68, unitPrice: 80 }],
      paymentMethod: "CASH",
      businessUnit: "FARM",
      entrepriseId,
    });
  }
  const existingEggsDelivery = await prisma.Journal.findFirst({ where: { Description: { startsWith: "BUY_INVENTORY_CASH" }, Entreprise_id: entrepriseId, Product_id: eggs.Product_id } });
  if (!existingEggsDelivery) {
    // A week's lay from 25 hens, delivered to the shop at cost
    await postBasket({
      mode: "buy",
      lines: [{ productId: eggs.Product_id, quantity: 45, unitPrice: 10 }],
      paymentMethod: "CASH",
      businessUnit: "FARM",
      entrepriseId,
    });
  }

  console.log("Chebet family (Stage 1) seeded: Stakeholders, Management, FARM products.");
  console.log("Chebet family login accounts (username / password):");
  console.log("  daniel / daniel123  (OWNER_FULL)");
  console.log("  grace / grace123  (MANAGER)");
  console.log("  niece / niece123  (ADVISOR)");
  console.log("  grandson / grandson123  (VIEWER)");
  console.log("  daughterinlaw / family123  (MANAGER)");

  // ---------------------------------------------------------------
  // Stage 2: RENTAL tenants, INVESTMENTS instruments, and Knowledge/
  // succession narrative entries.
  // ---------------------------------------------------------------
  await seedChebetStage2({ daniel, grace, niece, grandson, daughterInLaw, son, entrepriseId });
}

async function seedChebetStage2({ daniel, grace, niece, grandson, daughterInLaw, son, entrepriseId }) {
  // --- RENTAL: 15 one-bedroom houses as tenant Stakeholders ---
  const tenantNames = [
    "Wanjiru Kamau", "Otieno Owuor", "Njeri Mwangi", "Kiprotich Rono", "Achieng Odhiambo",
    "Muthoni Karanja", "Barasa Wafula", "Wambui Ndung'u", "Cheruiyot Kiplagat", "Nyambura Githinji",
    "Onyango Ochieng", "Wairimu Njoroge", "Kiptoo Bett", "Auma Adhiambo", "Mutiso Kioko",
  ];
  const tenantStakeholders = [];
  for (let i = 0; i < tenantNames.length; i++) {
    const s = await upsertStakeholder({
      First_name: tenantNames[i].split(" ")[0],
      Last_name: tenantNames[i].split(" ")[1] || "",
      Business_name: `House ${i + 1}`,
      Location: "Nakuru",
      Stakeholder_Category: "Customer",
      Stakeholder_Role: "Tenant",
      Relationship_to_owner: "Tenant",
      Relationship_Status: "ACTIVE",
      Entreprise_id: entrepriseId,
    });
    tenantStakeholders.push(s);
  }

  // --- INVESTMENTS: 2 government bonds + Co-op Bank shares as Money rows ---
  const codeRow4200 = await upsertCode("4200", "Interest Income — Bonds", "INCOME", "OTHER_INCOME", entrepriseId);
  const codeRow4300 = await upsertCode("4300", "Dividend Income", "INCOME", "OTHER_INCOME", entrepriseId);
  const interestAccount = await upsertAccount("Interest Income", "INCOME", codeRow4200.Account_codes_id, "CREDIT", entrepriseId);
  const dividendAccount = await upsertAccount("Dividend Income", "INCOME", codeRow4300.Account_codes_id, "CREDIT", entrepriseId);

  await upsertMoneyInstrument({
    accountId: interestAccount.Account_id,
    name: "KE Infrastructure Bond — 14yr",
    instrumentType: "MONEY_MARKET",
    instrumentClass: "AMORTIZED_COST",
    principal: 500000,
    interestRate: 12.5,
    startDate: new Date("2018-01-15"),
    maturityDate: new Date("2032-01-15"),
    entrepriseId,
  });

  await upsertMoneyInstrument({
    accountId: interestAccount.Account_id,
    name: "KE Infrastructure Bond — 18yr",
    instrumentType: "MONEY_MARKET",
    instrumentClass: "AMORTIZED_COST",
    principal: 500000,
    interestRate: 13.0,
    startDate: new Date("2018-01-15"),
    maturityDate: new Date("2036-01-15"),
    entrepriseId,
  });

  await upsertMoneyInstrument({
    accountId: dividendAccount.Account_id,
    name: "Co-operative Bank Shares",
    instrumentType: "MONEY_MARKET",
    instrumentClass: "FAIR_VALUE_OCI",
    principal: 180000,
    interestRate: null,
    startDate: new Date("2005-06-01"),
    maturityDate: null,
    entrepriseId,
  });

  // --- Knowledge: succession and institutional-memory entries ---
  //
  // IMPORTANT FRAMING: Management.Inheritance_Status (CURRENT_OWNER /
  // SUCCESSOR / EXCLUDED / ADVISOR / RETIRED) records what the family has
  // decided and intends — it is not, and must never be read as, a legal
  // determination of inheritance. Kenyan succession law (and most East
  // African jurisdictions) requires a will, a trust instrument, or a
  // court-recognised process before any exclusion or designation is
  // legally binding. The two Knowledge entries below deliberately state
  // this distinction directly, and the second one names the concrete gap
  // (no legal instrument on file) rather than letting the database's own
  // confident-looking status field imply the matter is settled.
  await upsertKnowledge({
    knowledgeType: "DECISION_REASON",
    explanation: "Family succession intention — grandson identified as primary successor, son not currently involved. This is the family's stated intention, not a legal determination.",
    decisionReason:
      "The family has assessed availability, demonstrated interest, and readiness to take on operational responsibility when weighing who should be prepared for succession. The grandson has shown consistent engagement with the business and its investments over an extended period and has been gradually given more responsibility as a result. This reflects the family's current thinking about who should take on that role — it does not by itself change anyone's legal entitlement to inherit, which depends on a will, trust, or other legal instrument.",
    context: "SUCCESSION",
    confidenceLevel: 5,
    authorStakeholderId: daniel.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "WARNING",
    explanation: "Legal status of the succession plan — not yet verified.",
    recommendation:
      "No will, trust, or other legal instrument recording this succession intention has been recorded in this system. Until one exists, the family's stated preference (grandson as successor, son not currently involved) has no legal effect on inheritance, and a professional review with a lawyer is recommended before treating it as settled. Required next steps: (1) draft and execute a will or equivalent legal instrument, (2) have it reviewed by a lawyer familiar with succession law in this jurisdiction, (3) record the resulting document under Documents once it exists.",
    context: "SUCCESSION",
    confidenceLevel: 2, // low confidence deliberately — this documents an open gap, not a settled fact
    authorStakeholderId: daniel.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "RECOMMENDATION",
    explanation: "Role of professional advisors in ongoing decisions.",
    recommendation:
      "Daniel relies on his niece for financial guidance when evaluating investments and banking services. A local accountant periodically reviews financial statements and year-end adjustments. Bank officers evaluate financial reports whenever financing or investment opportunities arise. Future successors should maintain these relationships rather than trying to replace professional expertise with family judgement alone.",
    context: "SUCCESSION",
    confidenceLevel: 4,
    authorStakeholderId: niece.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "LESSON_LEARNED",
    explanation: "Why the farm supports the shop rather than operating as a fully separate business.",
    lessonLearned:
      "Fresh milk is purchased each morning from the family's own dairy cows and repackaged for retail; eggs are purchased weekly from the farm's poultry. Treating the farm-to-shop movement as an internal transfer rather than a sale-and-purchase between two unrelated businesses avoids double-counting income in the consolidated view.",
    context: "FAMILY",
    confidenceLevel: 5,
    authorStakeholderId: grace.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "EXPLANATION",
    explanation: "What the grandson inherits beyond the assets themselves.",
    recommendation:
      "Business records, accounting reports, operating procedures, supplier relationships, investment history, loan repayments, rental management, and financial decisions are documented so that the incoming generation understands not only what assets exist but how those assets were acquired, managed, and sustained. Ownership alone does not guarantee good stewardship — the intention is to transfer knowledge, not just title.",
    context: "SUCCESSION",
    confidenceLevel: 5,
    authorStakeholderId: daniel.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "EXPLANATION",
    explanation: "Who actually keeps the business running day to day.",
    recommendation:
      "Whenever Daniel and Grace are travelling or attending to other responsibilities, the daughter-in-law oversees both the village shop and the farm — supervising employees, making sure produce reaches market, and keeping daily business running uninterrupted. She has become, in practice, the operational manager of the household enterprise, even though she holds no ownership stake and no formal place in the succession line.",
    context: "FAMILY",
    confidenceLevel: 5,
    authorStakeholderId: daughterInLaw.Stakeholder_id,
    entrepriseId,
  });

  console.log("Chebet family (Stage 2) seeded: 15 rental tenants, 2 bonds + Co-op shares, 5 Knowledge/succession entries.");

  // ---------------------------------------------------------------
  // Stage 3: the business's actual origin transactions. The biography
  // gives specific figures for these — until now they existed only as
  // narrative text, never posted, so the ledger had no founding capital
  // and Cash could never genuinely start positive from Chebet data alone.
  // Posted through the real engine (not raw Prisma writes) so they
  // produce the same balanced Journal trail as every other transaction.
  // ---------------------------------------------------------------
  const existingCapital = await prisma.Journal.findFirst({ where: { Description: { startsWith: "OWNER_CAPITAL_INJECTION" }, Entreprise_id: entrepriseId } });
  if (!existingCapital) {
    await postFunding({
      source: "CAPITAL",
      amount: 350000,
      paymentMethod: "BANK",
      notes: "Initial capital from pension benefits, contributed at retirement, early 2020.",
      businessUnit: "SHOP",
      entrepriseId,
    });
  }

  const existingLoan = await prisma.Journal.findFirst({ where: { Description: { startsWith: "LOAN_DRAWDOWN" }, Entreprise_id: entrepriseId } });
  if (!existingLoan) {
    await postFunding({
      source: "LOAN",
      amount: 1000000,
      paymentMethod: "BANK",
      notes: "Business loan, repayable over eight years at 7% annual interest, taken at retirement.",
      businessUnit: "SHOP",
      entrepriseId,
    });
  }

  const existingVehicle = await prisma.Assets.findFirst({ where: { Assets_Type: "Toyota Vitz", Entreprise_id: entrepriseId } });
  if (!existingVehicle) {
    // The biography names the vehicle and its 2017 purchase date but does not
    // give a price; this cost is a reasonable period estimate, not a
    // documented figure, and should be corrected if a real value is known.
    await postAssetPurchase({
      name: "Toyota Vitz",
      cost: 1200000,
      usefulLifeYears: 8,
      residualValue: 200000,
      depreciationMethod: "STRAIGHT_LINE",
      paymentMethod: "BANK",
      businessUnit: "SHOP",
      entrepriseId,
    });
  }

  console.log("Chebet family (Stage 3) seeded: founding capital (350,000), founding loan (1,000,000 @ 7%/8yr), Toyota Vitz asset.");
}

async function upsertStakeholder(fields) {
  const existing = await prisma.Stakeholder.findFirst({
    where: { First_name: fields.First_name, Last_name: fields.Last_name, Entreprise_id: fields.Entreprise_id },
  });
  if (existing) return existing;
  return prisma.Stakeholder.create({ data: fields });
}

async function upsertManagementForStakeholder({
  stakeholderId,
  name,
  role,
  administrationType,
  inheritanceStatus,
  accessLevel,
  catalogueId,
  arrangementType = null,
  arrangementRate = null,
  username = null,
  password = null,
  entrepriseId,
}) {
  const existing = await prisma.Management.findFirst({ where: { Stakeholder_id: stakeholderId } });
  if (existing) return existing;
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  return prisma.Management.create({
    data: {
      Catalogue_id: catalogueId,
      Stakeholder_id: stakeholderId,
      Management_Name: name,
      Management_Role: role,
      Administration_type: administrationType,
      Inheritance_Status: inheritanceStatus,
      Access_Level: accessLevel,
      Arrangement_Type: arrangementType,
      Arrangement_Rate: arrangementRate,
      Username: username,
      Password_Hash: passwordHash,
      Entreprise_id: entrepriseId,
    },
  });
}

async function upsertMoneyInstrument({ accountId, name, instrumentType, instrumentClass, principal, interestRate, startDate, maturityDate, entrepriseId }) {
  const existing = await prisma.Money.findFirst({ where: { Money_Name: name, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return prisma.Money.create({
    data: {
      Account_id: accountId,
      Instrument_type: instrumentType,
      Instrument_Class: instrumentClass,
      Accounting_Treatment: instrumentClass === "AMORTIZED_COST" ? "AMORTIZED_COST_EIR" : "FAIR_VALUE_MARKET",
      Money_Status: "ACTIVE",
      Risk_Level: "LOW",
      Money_Name: name,
      Principal_amount: principal,
      Interest_rate: interestRate,
      Outstanding_Amount: principal,
      Start_date: startDate,
      Maturity_date: maturityDate,
      Entreprise_id: entrepriseId,
    },
  });
}

async function upsertKnowledge({
  knowledgeType,
  explanation,
  recommendation = null,
  lessonLearned = null,
  decisionReason = null,
  context,
  confidenceLevel,
  authorStakeholderId,
  entrepriseId,
}) {
  const existing = await prisma.Knowledge.findFirst({ where: { Explanation: explanation, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return prisma.Knowledge.create({
    data: {
      Explanation: explanation,
      Knowledge_type: knowledgeType,
      Recommendation: recommendation,
      Lesson_Learned: lessonLearned,
      Decision_Reason: decisionReason,
      Context: context,
      Confidence_Level: confidenceLevel,
      Language: "en",
      Author: authorStakeholderId,
      Entry_date: new Date(),
      Entreprise_id: entrepriseId,
    },
  });
}

/**
 * seedAccountingRules — real Structures (STANDARD/ACCOUNTING_POLICY) rows
 * with actual IAS/IFRS references, mapped to the Catalogue events this
 * system actually posts, plus LogicConditions rows documenting the two
 * enforcement rules already live in postingEngine.js (the OPEN-period gate
 * and the double-entry balance check). Feeds the Settings > Rules page.
 */
async function seedAccountingRules(entrepriseId) {
  const ifrsFramework = await upsertStructure({
    Structures_Type: "FRAMEWORK",
    Structure_Level: "FRAMEWORK",
    Framework_Name: "IFRS_SME",
    Framework_Priority: 2,
    Structures_Name: "IFRS for SMEs",
    Structures_Description: "The primary accounting framework this system is built toward.",
    Mandatory: 1,
    Rule_Severity: "INFO",
    Entreprise_id: entrepriseId,
  });

  const standards = [
    {
      code: "IAS2",
      name: "IAS 2 — Inventories",
      reference: "IAS 2.9",
      ownerExplanation: "Stock is valued at what you paid for it. The cost of goods you sell only counts as an expense when the sale actually happens — not when you first bought the stock.",
      description: "Inventory is measured at the lower of cost and net realisable value. Cost of goods sold is recognised as an expense in the period the related revenue is recognised — never at the point of purchase.",
      appliesTo: "RESOURCE",
      recognitionMethod: "On Consumption",
      catalogueEvents: ["BUY_INVENTORY_CASH", "RECORD_COGS", "SELL_GOODS_CASH"],
      policyName: "Cost formula — actual cost",
      policyDescription: "Inventory is purchased and consumed at its recorded cost. BUY_INVENTORY_CASH capitalises the purchase to the Inventory account (balance sheet); RECORD_COGS transfers that cost to expense only when the matching sale is recognised.",
    },
    {
      code: "IAS16",
      name: "IAS 16 — Property, Plant and Equipment",
      reference: "IAS 16.73",
      ownerExplanation: "Vehicles, equipment, and fixtures are recorded at what they cost, then their value is spread down over the years you'll actually use them — not written off all at once.",
      description: "Fixed assets are recognised at cost and depreciated over their useful life. Accumulated depreciation and the resulting carrying amount must be tracked and disclosed.",
      appliesTo: "ASSET",
      recognitionMethod: "On Depreciation",
      catalogueEvents: ["PURCHASE_FIXED_ASSET"],
      policyName: "Depreciation method — straight-line default",
      policyDescription: "Assets purchased through the Assets wizard default to straight-line depreciation over the stated useful life, with an explicit residual value. Reducing-balance and units-of-production are also available per asset.",
    },
    {
      code: "IFRS15",
      name: "IFRS 15 — Revenue from Contracts with Customers",
      reference: "IFRS 15.31",
      ownerExplanation: "A sale counts as income the moment the customer actually gets the goods — for a till sale, that's the moment you ring it up. Simply receiving a deposit or ordering stock doesn't count yet.",
      description: "Revenue is recognised when control of goods transfers to the customer — at the point of sale for cash retail transactions, not when cash is merely received or goods are merely purchased.",
      appliesTo: "INCOME",
      recognitionMethod: "On Delivery",
      catalogueEvents: ["SELL_GOODS_CASH", "RECEIVE_RENT_INCOME"],
      policyName: "Point-of-sale recognition",
      policyDescription: "SELL_GOODS_CASH recognises revenue at the moment the till posts the sale, matching cash receipt and delivery for this business's retail model. Rental income is recognised when received, per the cash-basis election documented under IFRS 9 below.",
    },
    {
      code: "IFRS9",
      name: "IFRS 9 — Financial Instruments",
      reference: "IFRS 9.5.1",
      ownerExplanation: "Money owed to you (unpaid customer bills) and money you owe (unpaid supplier bills, loans) are tracked at the actual amount involved — what's really outstanding, not an estimate.",
      description: "Loans, bonds, equity investments, trade receivables, and trade payables are all financial instruments under IFRS 9, each requiring classification (amortised cost vs fair value) and, for loans and credit balances, disclosure with an interest rate or credit terms and maturity.",
      appliesTo: "MONEY",
      recognitionMethod: "On Payment",
      catalogueEvents: ["OWNER_CAPITAL_INJECTION", "LOAN_DRAWDOWN", "RECEIVE_INTEREST_INCOME", "RECEIVE_DIVIDEND_INCOME", "SELL_GOODS_CASH", "BUY_INVENTORY_CASH", "PAY_EXPENSE_UTILITIES"],
      policyName: "Amortised cost throughout — bonds, shares, receivables, and payables",
      policyDescription: "Government bonds held for coupon income are measured at amortised cost (Instrument_Class=AMORTIZED_COST). Listed shares held for potential price appreciation are measured at fair value through OCI (Instrument_Class=FAIR_VALUE_OCI). Trade Receivables (1200) and Trade Payables (2000) — created whenever a sale, purchase, or expense is recorded on Credit rather than Cash/Mobile/Bank — are carried at amortised cost: the amount actually owed, with no discounting applied given their short (typically under 12 month) settlement horizon.",
    },
    {
      code: "IAS1",
      name: "IAS 1 — Presentation of Financial Statements",
      reference: "IAS 1.66-1.69",
      ownerExplanation: "Your financial reports can't be produced until the books are actually balanced and reviewed — the system won't let you skip straight to a Profit Statement or Balance Sheet from unchecked figures.",
      description: "Financial statements are prepared on an accrual basis and require a complete, balanced set of accounts before Income Statement or Balance Sheet can be presented — never generated directly from an unadjusted trial balance. Assets and liabilities must also be classified as current or non-current so a reader can judge short-term liquidity at a glance.",
      appliesTo: "REPORT",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Adjusted trial balance gate, and current/non-current classification",
      policyDescription: "The Reports page enforces the full chain: Unadjusted Trial Balance -> Adjusted Trial Balance -> Income Statement / Balance Sheet. Financial statements cannot be generated from a report that isn't marked Is_Adjusted=1. Separately, Assets.Asset_Classification and Liability.Liability_Classification each carry a CURRENT / NON_CURRENT value (IAS 1.66 and IAS 1.69) — Cash, Inventory, and Trade Receivables are current; Property Plant and Equipment is non-current; Trade Payables are current; a Loan Payable is classified by its remaining term.",
    },
    {
      code: "IFRS12",
      name: "IFRS 12 — Disclosure of Interests in Other Entities",
      reference: "IFRS 12.7",
      ownerExplanation: "Every business unit you run — however many, whatever they're called — is part of the same one business, not separate companies. Everything is reported together as a single enterprise.",
      description: "A reporting entity discloses enough information for a reader to evaluate the nature of, and risks from, its interests in other entities, and the effect of those interests on its financial position. Relevant to a family enterprise the moment it operates more than one business unit under common family control.",
      appliesTo: "ORGANISATION",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Single reporting entity, multiple business units — not separate legal entities",
      policyDescription: "Business units (Structures_Type=BUSINESS_UNIT) are modelled and posted as divisions of one Organisation, not as separate legal entities with their own accounts to consolidate. This is a deliberate scope decision, not a gap: there is no subsidiary, no non-controlling interest, and no group structure requiring elimination entries beyond the internal-transfer handling already documented under IFRS 15. If a business unit were ever incorporated separately — a common next step as a family enterprise formalises — this policy is where that change would be recorded, and Structures.Parent_Structure_id already supports the resulting BUSINESS_UNIT -> Structures_Type=DIVISION hierarchy without a schema change.",
    },
    {
      code: "IAS7",
      name: "IAS 7 — Statement of Cash Flows",
      reference: "IAS 7.10-7.17",
      ownerExplanation: "Your Cash Flow page shows real cash — money that actually moved through Cash, Mobile Money, and Bank — sorted into everyday trading, buying/selling big assets, and loans or capital. This is different from your profit figure, which includes sales not yet paid for.",
      description: "Cash flows are classified as operating, investing, or financing, and a reader must be able to see the enterprise's actual cash and cash-equivalent position separately from its accrual-basis profit — cash generated from trading is not the same figure as net income.",
      appliesTo: "REPORT",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Direct method — actual cash movements by activity",
      policyDescription: "The Cash Flow page (Money -> Cash Flow) uses the direct method: it reads real Journal postings against the Cash, Mobile Money, and Bank accounts and classifies each by the Cash_Flow_Category already set on its Catalogue event (OPERATING for sales/purchases/expenses, INVESTING for asset purchases and disposals, FINANCING for capital and loan drawdowns) — not an indirect reconciliation from net profit. Receivables and Payables are shown separately as the gap between profit and cash, per IAS 7.18's distinction between operating result and operating cash flow.",
    },
    {
      code: "IAS8",
      name: "IAS 8 — Accounting Policies, Estimates and Errors",
      reference: "IAS 8.13-8.14",
      ownerExplanation: "You apply the same rules the same way every time — the same depreciation method for similar assets, the same way of valuing stock. If a past entry needs correcting, it should be reversed and redone with a visible trail, not just quietly edited.",
      description: "An entity selects and applies its accounting policies consistently for similar transactions, discloses what those policies are, and — when a policy or an estimate changes, or an error from a prior period is found — accounts for that change or correction in a defined, traceable way rather than silently editing history.",
      appliesTo: "REPORT",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Consistent policies; corrections tracked, not overwritten",
      policyDescription: "Depreciation method and inventory cost basis (actual cost, not FIFO or weighted-average) are each set once per asset or event type and applied consistently rather than varied case by case. Transactions carry Correction_Status=ORIGINAL by default; the schema's Correction_Status/Correction_of fields are designed so a prior entry is reversed and replaced rather than edited in place, keeping a traceable history. This is the schema's intended mechanism for IAS 8 error correction — noted here as a known gap: no reversal action exists in the interface yet, so a correction currently has to be posted as a new offsetting entry rather than a formal linked reversal.",
    },
    {
      code: "IFRS16",
      name: "IFRS 16 — Leases",
      reference: "IFRS 16.22-16.26",
      ownerExplanation: "When you sign a lease — for premises, a vehicle, equipment — it goes on the books as both something you now have the right to use and something you owe. Rent is no longer just a monthly expense; it's paying down that debt.",
      description: "A lessee recognises a Right-of-Use asset and a corresponding Lease Liability at the start of a lease, rather than treating rent as a simple period expense. The Right-of-Use asset is then amortised over the lease term, and each payment reduces the Lease Liability rather than being expensed directly.",
      appliesTo: "ASSET",
      recognitionMethod: "On Commencement",
      catalogueEvents: ["LEASE_COMMENCEMENT", "LEASE_PAYMENT"],
      policyName: "Right-of-Use asset and Lease Liability recognised together at commencement",
      policyDescription: "Lease commencement records the Right-of-Use asset and the Lease Liability together, at the total contracted payments over the term — a simplification of full IFRS 16, which discounts future payments to present value using the lessee's incremental borrowing rate; this system does not yet have a rate input, so commencement uses the undiscounted total instead. Each lease payment then reduces the Lease Liability (the financing portion) and separately amortises the Right-of-Use asset over the lease term via the same depreciation mechanism used for owned assets.",
    },
    {
      code: "IAS37",
      name: "IAS 37 — Provisions, Contingent Liabilities and Contingent Assets",
      reference: "IAS 37.14",
      ownerExplanation: "If you offer a warranty on something you sell, you record the likely cost of future repairs at the time of sale — not just when a customer actually comes back with a problem. This is different from a supplier bill, where the amount owed is already certain.",
      description: "A provision is recognised only when there is a present obligation from a past event, payment is probable, and the amount can be reliably estimated — distinct from a Trade Payable, which is a known, certain amount. A warranty offered on goods sold is the clearest everyday example: the obligation exists at the point of sale even though the exact repair cost and timing are not yet known.",
      appliesTo: "MONEY",
      recognitionMethod: "On Estimate",
      catalogueEvents: ["RECORD_PROVISION", "UTILISE_PROVISION"],
      policyName: "Warranty provisions recognised at sale, utilised as claims arise",
      policyDescription: "Recording a provision posts an estimated Warranty Expense against a Provision for Warranties liability. When a claim is honoured, that same provision is drawn down (paid out of the existing liability) rather than a fresh expense being recognised — the expense was already booked when the provision was first estimated, per IAS 37.14's matching principle.",
    },
    {
      code: "IAS36",
      name: "IAS 36 — Impairment of Assets",
      reference: "IAS 36.59",
      ownerExplanation: "If something you own is damaged, becomes outdated, or is simply worth less than it used to be, its value on the books is written down right away to reflect that — separate from the normal gradual depreciation every asset goes through.",
      description: "When an asset's recoverable amount falls below its carrying amount — through damage, obsolescence, or a genuine drop in value — the carrying amount is written down immediately to the recoverable amount, and the loss is recognised in profit or loss. This is separate from scheduled depreciation, which spreads a known cost over a known life.",
      appliesTo: "ASSET",
      recognitionMethod: "On Impairment Test",
      catalogueEvents: ["RECORD_IMPAIRMENT"],
      policyName: "Impairment recognised immediately, distinct from depreciation",
      policyDescription: "The Assets page's Impairment form posts the write-down directly against the asset, capped at its current carrying amount so it can never go negative. Accumulated impairment is tracked separately from accumulated depreciation, and both are netted against cost to compute carrying amount, matching the schema's own documented formula — depreciation running after an impairment correctly accounts for the reduced remaining value rather than depreciating as if the impairment never happened.",
    },
    {
      code: "IAS41",
      name: "IAS 41 — Agriculture",
      reference: "IAS 41.10-41.12",
      ownerExplanation: "Your animals and crops are valued at what they would fetch at market today, not what you originally paid. When a calf is born or a crop grows, the increase in value is genuine income even though no cash changed hands. When an animal dies, the loss is genuine even though nothing was sold.",
      description: "Biological assets are measured at fair value less costs to sell. A gain or loss arising from a change in fair value is recognised in profit or loss for the period. At the point of harvest, the produce is measured at fair value less costs to sell and thereafter enters IAS 2 (Inventory) — IAS 41 does not govern post-harvest produce.",
      appliesTo: "RESOURCE",
      recognitionMethod: "On Fair Value Change",
      catalogueEvents: ["LIVESTOCK_BIRTH", "LIVESTOCK_LOSS", "LIVESTOCK_THEFT", "HARVEST"],
      policyName: "Biological assets at fair value less costs to sell",
      policyDescription: "Animals and crops are registered at estimated market fair value. Monthly reviews update the fair value without a journal posting — the gain or loss is recognised only at specific events: births (new asset, DR Biological Assets CR Gain on Biological Assets), deaths (DR Loss CR Biological Assets), and harvest (DR Inventory CR Biological Assets — the produce transitions from IAS 41 to IAS 2 at the point of harvest). Theft is tracked separately from natural loss for risk-pattern analysis.",
    },
    {
      code: "IFRS17",
      name: "IFRS 17 — Insurance Contracts",
      reference: "IFRS 17.3",
      ownerExplanation: "When you pay insurance premiums, that money is buying protection over a period of time. The cost is spread over the coverage period, not just recorded when you pay. When something goes wrong and the insurer pays you, that payout is income — separate from the premiums you paid.",
      description: "Insurance premiums are expensed over the period of coverage. Prepaid portions are carried as prepaid insurance until the coverage period passes. Claims are recognised when the right to compensation is established — the claim receipt is income (Insurance Claim Income), not a reversal of the premium expense, because the premium bought coverage and the claim is the coverage paying out.",
      appliesTo: "MONEY",
      recognitionMethod: "Over Coverage Period",
      catalogueEvents: ["PAY_EXPENSE_INSURANCE", "INSURANCE_CLAIM_RECEIPT"],
      policyName: "Premiums expensed over coverage period, claims as income when right established",
      policyDescription: "Insurance premiums are posted as Insurance Expense when paid, linked back to the specific policy via the Money row (postExpense with moneyId). The full premium is currently expensed immediately — a future improvement would spread it over the coverage months as a prepaid asset. Claims received from the insurer are posted as Insurance Claim Income (a separate income account, 4800), not a reversal of the expense. The Risk Position panel on the Risks & Insurance page computes the coverage ratio (total insured value ÷ total asset carrying value) to flag under-insurance.",
    },
  ];

  for (const std of standards) {
    const standardStructure = await upsertStructure({
      Structures_Type: "STANDARD",
      Structure_Level: "STANDARD",
      Parent_Structure_id: ifrsFramework.Structures_id,
      Framework_Name: "IAS",
      Framework_Priority: 1,
      Framework_Version: std.code,
      Rule_Code: std.code,
      Standard_Reference: std.reference,
      // Structures_Name is capped at 45 characters — std.name (e.g. "IAS
      // 37 — Provisions, Contingent Liabilities and Contingent Assets" at
      // 67 chars) regularly exceeded that and crashed seed.js on the
      // first standard reached in that state. std.code (e.g. "IAS37") is
      // always short; the full readable name moves into
      // Structures_Description, pipe-separated ahead of the owner
      // explanation, same pattern used elsewhere in this function.
      Structures_Name: std.code,
      Structures_Description: `${std.name}|${std.ownerExplanation}`,
      Applies_To_Table: std.appliesTo,
      Recognition_Method: std.recognitionMethod,
      Mandatory: 1,
      Rule_Severity: "BLOCK",
      Measurement_Basis: std.code === "IAS2" ? "HISTORICAL_COST" : std.code === "IFRS9" ? "AMORTIZED_COST" : null,
      // Pipe-separated list of Catalogue Event_Names this standard governs.
      // Stored here so the Rules page can display the linkage without
      // depending on the Catalogue.Structures_id FK being set — that FK
      // only gets written when a matching Catalogue row exists for this
      // business (i.e. after the relevant posting function has been called
      // at least once), but the display should work from the very first
      // visit to the Rules page, before any transactions have been posted.
      Structures_Condition: std.catalogueEvents.join("|"),
      Entreprise_id: entrepriseId,
    });

    await upsertStructure({
      Structures_Type: "ACCOUNTING_POLICY",
      Structure_Level: "RULE",
      Parent_Structure_id: standardStructure.Structures_id,
      Framework_Name: "INTERNAL",
      Framework_Priority: 4,
      // Structures_Name is capped at 45 characters — every one of the 11
      // policyName values here exceeds that, which is what was actually
      // crashing seed.js on the very first standard it tried to seed
      // (before even reaching the source-of-truth policy fixed earlier).
      // A short fixed label goes here; the real policy name and its full
      // detail both live in Structures_Description, separated by a pipe,
      // same pattern used for the source-of-truth rows.
      Structures_Name: "Policy",
      Structures_Description: `${std.policyName}|${std.description} ${std.policyDescription}`, // technical detail, accountant-facing
      Applies_To_Table: std.appliesTo,
      Mandatory: 1,
      Rule_Severity: "INFO",
      Entreprise_id: entrepriseId,
    });

    // Tag which Catalogue events this standard actually governs, so the
    // Rules page can show "this standard applies to these real processes"
    for (const eventName of std.catalogueEvents) {
      const cat = await prisma.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
      if (cat) {
        await prisma.Catalogue.update({
          where: { Catalogue_id: cat.Catalogue_id },
          data: { Structures_id: standardStructure.Structures_id },
        });
      }
    }
  }

  // --- LogicConditions: the two enforcement rules genuinely live in
  //     postingEngine.js today. Documenting them here makes the actual
  //     running behaviour visible on the Rules page, not aspirational.
  await upsertLogicCondition({
    name: "Closed Period Entry Block",
    whenEvent: "ANY_JOURNAL_INSERT",
    leftOperand: "Structures.Period_Status WHERE Structures_id = Journal.Period_id",
    operator: "!=",
    rightOperand: "OPEN",
    checkExpression: "Every Journal row must reference a Structures row with Period_Status = OPEN.",
    enforcement: "BLOCK",
    ownerMessage: "You cannot post entries right now — no accounting period is open. Open today's period in Settings.",
    accountantMessage: "IAS 1 cutoff: Journal.Period_id must reference an OPEN Structures period. This is enforced in postBasket, postExpense, postFunding, postAssetPurchase, and postUnitIncome before any Journal row is written.",
    logicExplanation: "Prevents backdating entries into a closed or nonexistent period. Genuinely enforced — every posting function in postingEngine.js checks for an OPEN period and throws before writing anything if none exists.",
    logicType: "VALIDATION",
    reviewLevel: "ACCOUNTANT",
    validationTier: "ACCOUNTING",
  });

  await upsertLogicCondition({
    name: "Double Entry Balance Check",
    whenEvent: "ANY_JOURNAL_INSERT",
    leftOperand: "SUM(Journal.Debit) WHERE Transactions_id = NEW.Transactions_id",
    operator: "=",
    rightOperand: "SUM(Journal.Credit) WHERE Transactions_id = NEW.Transactions_id",
    checkExpression: "Every posting function writes matched debit/credit Journal pairs within a single database transaction — postJournalPair always creates both sides together.",
    enforcement: "BLOCK",
    ownerMessage: "Entries are always recorded in matching pairs — you'll never see an unbalanced entry from normal use of the till, expenses, or funds pages.",
    accountantMessage: "Structural guarantee rather than a post-hoc check: postJournalPair() in postingEngine.js always writes a Debit row and a Credit row for the same amount inside one Prisma $transaction, so partial writes cannot occur. The Reports and Journal pages both display a live balance check as a secondary confirmation.",
    logicExplanation: "The Trial Balance and Journal pages compute SUM(Debit) vs SUM(Credit) live and flag any mismatch — this is a visible confirmation of what the engine already guarantees structurally.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "ACCOUNTING",
  });

  await upsertLogicCondition({
    name: "Loan Amortization Discipline",
    whenEvent: "PERIOD_CLOSE:MONTHLY",
    leftOperand: "Money.Outstanding_Amount WHERE Instrument_type=LOAN",
    operator: "=",
    rightOperand: "Opening_Principal - SUM(principal_repayments_this_period)",
    checkExpression: "A loan's Outstanding_Amount should reduce only by the principal portion of each repayment — interest paid does not reduce principal owed.",
    enforcement: "WARN",
    ownerMessage: "Loan repayments split into two parts: the amount that actually reduces what you owe, and the interest cost. Only the first part brings the loan balance down.",
    accountantMessage: "Not yet enforced structurally — currently modelled honestly as a gap. postFunding() records a loan drawdown (DR Cash/Bank CR Loan Payable) but this system has no repayment/amortization schedule function yet: no split of a repayment into principal and interest, no automatic reduction of Money.Outstanding_Amount, no interest accrual between payments. A single lump-sum loan (as currently seeded) doesn't expose this gap; a formally amortized loan with a fixed schedule and rate — the kind a larger multi-unit business is more likely to carry — would need this built before the loan register could be trusted for real repayment tracking.",
    logicExplanation: "Recorded here as a documented gap, not a working control, so the Rules page stays honest about what this system does and doesn't verify yet — matching the standard set elsewhere in this file that only real, running behaviour is described as enforced.",
    logicType: "VALIDATION",
    reviewLevel: "ACCOUNTANT",
    validationTier: "COMPLIANCE",
  });

  // IAS 1 and IAS 7 correctly have no Catalogue event — neither governs a
  // single postable transaction the way IAS 2 governs BUY_INVENTORY_CASH.
  // They govern presentation: whether a report can be generated at all,
  // and how cash movements get categorised once it is. That enforcement
  // is real and already running in reporting.js and the Cash Flow route —
  // it was just never represented as a LogicConditions row before, which
  // is what made the Rules page correctly say these standards had no
  // visible rule guiding how things are processed.
  await upsertLogicCondition({
    name: "Adjusted Trial Balance Gate",
    whenEvent: "REPORT_GENERATE",
    leftOperand: "Reports.Is_Adjusted WHERE Reports_id = parentReportId",
    operator: "=",
    rightOperand: "1",
    checkExpression: "generateIncomeStatement() and generateBalanceSheet() both call requireAdjustedParent(), which throws unless the referenced parent Reports row has Report_Stage=TRIAL_BALANCE_ADJUSTED and Is_Adjusted=1.",
    enforcement: "BLOCK",
    ownerMessage: "Your Income Statement or Balance Sheet can't be generated until the trial balance has actually been adjusted — this stops a report from being produced against unreviewed figures.",
    accountantMessage: "Genuinely enforced in reporting.js: requireAdjustedParent() is called at the top of both generateIncomeStatement() and generateBalanceSheet(), and throws ReportingError before any Reports row is written if the referenced parent isn't an adjusted trial balance. IAS 1's presentation requirement is a structural gate here, not a checklist item.",
    logicExplanation: "This is the actual rule behind IAS 1's Structures row on the Rules page — it has no Catalogue event because it governs report generation, not a transaction, but the block is real and running.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "COMPLIANCE",
  });

  await upsertLogicCondition({
    name: "Cash Flow Activity Classification",
    whenEvent: "REPORT_VIEW",
    leftOperand: "Catalogue.Cash_Flow_Category WHERE Catalogue_id = Journal.Catalogue_id",
    operator: "IN",
    rightOperand: "OPERATING, INVESTING, FINANCING",
    checkExpression: "Every cash-equivalent Journal row (Cash/Mobile/Bank) is sorted by its Catalogue event's Cash_Flow_Category into the three IAS 7 activity classes and totalled separately from accrual-basis profit.",
    enforcement: "INFO",
    ownerMessage: "Your Cash Flow page separates real cash movements — everyday trading, buying or selling big assets, and loans or capital — from your profit figure, which includes sales you haven't been paid for yet.",
    accountantMessage: "Genuinely enforced in the Money > Cash Flow route: every Journal row against a cash-equivalent account is looked up via its Catalogue_id to read Cash_Flow_Category (OPERATING/INVESTING/FINANCING/NONE), then summed per category. Catalogue rows that don't set a Cash_Flow_Category are correctly excluded from the classified totals rather than silently defaulting to one bucket.",
    logicExplanation: "This is the actual rule behind IAS 7's Structures row on the Rules page — a report-time classification rather than a single postable event, but genuinely computed from real data each time the page loads, not hardcoded.",
    logicType: "REPORTING",
    reviewLevel: "NONE",
    validationTier: "COMPLIANCE",
  });

  // BUSINESS tier: does this make operational sense, before any
  // accounting or compliance question is even reached? Both of these are
  // genuinely enforced today, not just documented — Product-existence was
  // already checked before this session; the stock-sufficiency check was
  // added specifically because building this rule's documentation
  // surfaced that it was missing.
  await upsertLogicCondition({
    name: "Product Must Exist",
    whenEvent: "BASKET_LINE_ADD",
    leftOperand: "Product.Product_id WHERE Product_id = line.productId AND Entreprise_id = current",
    operator: "NOT_NULL",
    rightOperand: "",
    checkExpression: "Every basket line's productId must resolve to a real Product row belonging to the business posting the sale — a stale or cross-business product reference is rejected before any posting begins.",
    enforcement: "BLOCK",
    ownerMessage: "The item you're trying to sell or buy couldn't be found — it may have been removed, or belongs to a different business unit.",
    accountantMessage: "Genuinely enforced in postBasket(): each line's Product_id is resolved via tx.Product.findUnique and checked against Entreprise_id first. A missing or cross-business product throws PostingError before any Journal write.",
    logicExplanation: "The most basic business-sense question a sale can be asked: does the thing being sold actually exist? This runs before any accounting or compliance check — there is no point validating a period is open for a sale of a product that doesn't exist.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "BUSINESS",
  });

  await upsertLogicCondition({
    name: "Sufficient Stock Available",
    whenEvent: "BASKET_LINE_ADD",
    leftOperand: "Resources.Resources_Quantity WHERE Product_id = line.productId",
    operator: ">=",
    rightOperand: "line.quantity",
    checkExpression: "A Goods sale cannot request more units than Resources.Resources_Quantity currently holds for that product. Services and Utilities are exempt — neither carries a physical quantity.",
    enforcement: "BLOCK",
    ownerMessage: "You're trying to sell more than you have in stock. Record a purchase first, or reduce the quantity.",
    accountantMessage: "Genuinely enforced in postBasket(): for Goods lines, current Resources_Quantity is checked against the requested quantity before any Journal write. Previously a sale could drive inventory negative unchecked — found and fixed while documenting this rule.",
    logicExplanation: "Business sense, checked before accounting: a sale that would take stock negative isn't an accounting problem to flag after the fact, it's an operational impossibility to refuse before posting begins.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "BUSINESS",
  });

  console.log("Accounting rules seeded: 11 IAS/IFRS standards with policies, mapped to real Catalogue events; 7 LogicConditions across all three validation tiers (Business, Accounting, Compliance), documenting live enforcement (and one honestly documented gap).");
}

/**
 * seedProcessActions — real workflow steps for the three processes this
 * system actually has: a Till sale, an expense payment, and a fixed
 * asset purchase. Each row answers "what step happened," never "what
 * accounts moved" — that separation is deliberate, matching the
 * architectural rule that ProcessActions must never Debit/Credit
 * (Catalogue answers "what accounts," ProcessActions answers "what
 * happened"). Accounting_Event=1 only on the step where a real posting
 * function actually calls postJournalPair, verified against till.js,
 * claims.js, and assets.js rather than invented.
 *
 * Ordered via Sequence_No and chained via ParentAction_id so a process
 * can be walked step by step, matching the review's diagram: Business
 * Event -> Catalogue -> LogicConditions -> ProcessActions -> Posting
 * Engine -> Journal.
 */
const PROCESS_ACTIONS_FIELD_CAPS = {
  Process_name: 45, Action_Type: 20, Cycle_type: 20, From_State: 20,
  To_State: 20, Applies_To: 20, Approval_Level: 20, Process_Description: 255,
  Default_Journal_Template: 45, Reversal_Method: 20, Required_Document: 45,
  Required_Evidence: 45, Scheduled_date: 45, Recurrence_Pattern: 20,
};

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

const LOGIC_CONDITIONS_FIELD_CAPS = {
  Conditons_Name: 45, When_Event: 20, Left_Operand: 100, Operator: 10,
  Right_Operand: 100, Check_Expression: 500, Enforcement: 10,
  Owner_Message: 255, Accountant_Message: 255, Logic_type: 20, Review_Level: 20,
  Validation_Tier: 15,
};

async function upsertLogicCondition({
  name,
  whenEvent,
  leftOperand,
  operator,
  rightOperand,
  checkExpression,
  enforcement,
  ownerMessage,
  accountantMessage,
  logicExplanation,
  logicType,
  reviewLevel,
  validationTier,
}) {
  // NOTE: LogicConditions has no Entreprise_id column yet — missing from
  // the original multi-tenancy migration, same gap as Equity. These rows
  // (the enforcement-rule documentation on the Rules page) are currently
  // shared globally across every business rather than scoped per-business.
  // Left unscoped deliberately rather than silently working around it;
  // needs a follow-up migration.
  const existing = await prisma.LogicConditions.findFirst({ where: { Conditons_Name: name } });
  if (existing) return existing;

  const safeData = {
    Conditons_Name: name,
    When_Event: whenEvent,
    Left_Operand: leftOperand,
    Operator: operator,
    Right_Operand: rightOperand,
    Check_Expression: checkExpression,
    Enforcement: enforcement,
    Owner_Message: ownerMessage,
    Accountant_Message: accountantMessage,
    Logic_Explanation: logicExplanation, // TEXT column, no practical length cap
    Logic_type: logicType,
    Review_Level: reviewLevel,
    Validation_Tier: validationTier || "ACCOUNTING",
    Fact_Type: "ACTUAL",
    Confidence_Level: 5,
  };

  // Defensive backstop, same pattern as upsertStructure: several of this
  // file's own accountantMessage values were already over the real
  // 255-char Accountant_Message cap and only avoided crashing because
  // Conditons_Name uniqueness meant they'd never actually been inserted
  // fresh since this bug was introduced. Truncating here closes that gap
  // regardless of what any calling code passes in.
  for (const [field, cap] of Object.entries(LOGIC_CONDITIONS_FIELD_CAPS)) {
    if (typeof safeData[field] === "string" && safeData[field].length > cap) {
      safeData[field] = truncateAtBoundary(safeData[field], cap);
    }
  }

  return prisma.LogicConditions.create({ data: safeData });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { seedAccountingRules, seedProcessActions, seedSourceOfTruthPolicy, seedCatalogueEvents, seedPeriodEndChecks, seedDefaultSettings };

/**
 * seedDefaultSettings — seeds the typed, categorised Settings rows that
 * every business needs. Unlike Preference_key/Preference_value on
 * Structures (which stores everything as strings), each setting has
 * an explicit Data_Type so consumers don't need to parse.
 */
async function seedDefaultSettings(entrepriseId) {
  const settings = [
    { category: "ACCOUNTING", name: "MATERIALITY_THRESHOLD", value: "5000", dataType: "DECIMAL", description: "Amounts below this threshold are expensed immediately rather than capitalised. IAS 16 materiality." },
    { category: "ACCOUNTING", name: "DEPRECIATION_DEFAULT_METHOD", value: "STRAIGHT_LINE", dataType: "STRING", description: "Default depreciation method for new fixed assets." },
    { category: "ACCOUNTING", name: "FISCAL_YEAR_START", value: "01", dataType: "INT", description: "Month number (1-12) when the fiscal year begins." },
    { category: "ACCOUNTING", name: "DEFAULT_CURRENCY", value: "KES", dataType: "STRING", description: "Default currency for all transactions." },
    { category: "INVENTORY", name: "COST_FORMULA", value: "FIFO", dataType: "STRING", description: "Inventory cost formula: FIFO, weighted average, or specific identification. IAS 2.25." },
    { category: "INVENTORY", name: "REORDER_ALERT_ENABLED", value: "1", dataType: "BOOLEAN", description: "Alert when stock falls below reorder level." },
    { category: "CASH_FLOW", name: "CASH_FLOW_METHOD", value: "INDIRECT", dataType: "STRING", description: "Cash flow statement method: DIRECT or INDIRECT. IAS 7." },
    { category: "COMPLIANCE", name: "VAT_RATE", value: "16.00", dataType: "DECIMAL", description: "Standard VAT rate. Kenya: 16%." },
    { category: "COMPLIANCE", name: "VAT_REGISTERED", value: "0", dataType: "BOOLEAN", description: "Whether this business is VAT registered." },
    { category: "USER", name: "REQUIRE_EVIDENCE_ON_POST", value: "0", dataType: "BOOLEAN", description: "Require evidence attachment before a transaction can be posted." },
    { category: "USER", name: "AUTO_OPEN_PERIOD", value: "1", dataType: "BOOLEAN", description: "Automatically open today's period when the first transaction is posted." },
    { category: "SUCCESSION", name: "SUCCESSION_PLAN_ACTIVE", value: "0", dataType: "BOOLEAN", description: "Whether a formal succession plan exists for this business." },
    { category: "SUCCESSION", name: "SUCCESSION_REVIEW_FREQUENCY", value: "ANNUAL", dataType: "STRING", description: "How often the succession plan should be reviewed." },
  ];

  for (const s of settings) {
    const existing = await prisma.Settings.findFirst({
      where: { Setting_Name: s.name, Entreprise_id: entrepriseId },
    });
    if (!existing) {
      await prisma.Settings.create({
        data: {
          Setting_Category: s.category,
          Setting_Name: s.name,
          Setting_Value: s.value,
          Data_Type: s.dataType,
          Description: s.description,
          Entreprise_id: entrepriseId,
        },
      });
    }
  }
}

/**
 * seedPeriodEndChecks — seeds the default period-end checklist as
 * Structures rows (Structures_Type = "PERIOD_END_CHECK"). Each row
 * defines one check: its name (maps to an evaluation function in
 * accounting_practice.js), its Rule_Severity (BLOCK/WARN/INFO), and an
 * optional Preference_value for threshold configuration.
 */
async function seedPeriodEndChecks(entrepriseId) {
  const checks = [
    { name: "JOURNAL_BALANCED", description: "Every debit must be matched by an equal credit. A period with an out-of-balance Journal should never be closed.", severity: "BLOCK", threshold: null },
    { name: "DEPRECIATION_RUN", description: "If the business has depreciating assets, at least one depreciation entry must have been posted in this period.", severity: "WARN", threshold: null },
    { name: "OPEN_RECEIVABLES_AGE", description: "Review any trade receivables still outstanding. Threshold (days) is configurable via Preference_value.", severity: "INFO", threshold: 30 },
    { name: "PROVISIONS_REVIEWED", description: "IAS 37 requires provisions to be reviewed at each reporting date.", severity: "INFO", threshold: 90 },
    { name: "INSURANCE_ACTIVE", description: "A business with fixed assets should have at least one active insurance policy.", severity: "INFO", threshold: null },
    { name: "STOCK_COUNT_VERIFIED", description: "Physical stock count should be reconciled against system quantities before closing a period.", severity: "INFO", threshold: null },
  ];

  for (const check of checks) {
    await upsertStructure({
      Structures_Type: "PERIOD_END_CHECK",
      Structure_Level: "RULE",
      Framework_Name: "INTERNAL",
      Framework_Priority: 4,
      Structures_Name: check.name,
      Structures_Description: check.description,
      Mandatory: check.severity === "BLOCK" ? 1 : 0,
      Rule_Severity: check.severity,
      Preference_value: check.threshold ? String(check.threshold) : null,
      Entreprise_id: entrepriseId,
    });
  }
}
