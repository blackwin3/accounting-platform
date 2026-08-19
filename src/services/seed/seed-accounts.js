const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function seedAccountCodes(entrepriseId) {
  const rows = [
    // Assets
    ["1000", "Cash / Till", "ASSET", "CURRENT_ASSET"],
    ["1010", "Mobile Money", "ASSET", "CURRENT_ASSET"],
    ["1020", "Bank", "ASSET", "CURRENT_ASSET"],
    ["1100", "Inventory", "ASSET", "CURRENT_ASSET"],
    ["1200", "Trade Receivables", "ASSET", "CURRENT_ASSET"],
    ["1210", "Interest Receivable", "ASSET", "CURRENT_ASSET"],
    ["1220", "Rent Receivable", "ASSET", "CURRENT_ASSET"],
    ["1300", "Prepaid Expenses", "ASSET", "CURRENT_ASSET"],
    ["1400", "Property Plant and Equipment", "ASSET", "NON_CURRENT_ASSET"],
    ["1410", "Accumulated Depreciation", "ASSET", "NON_CURRENT_ASSET"],
    ["1420", "Accumulated Impairment", "ASSET", "NON_CURRENT_ASSET"],
    ["1450", "Biological Assets", "ASSET", "NON_CURRENT_ASSET"],
    ["1500", "Financial Investments", "ASSET", "NON_CURRENT_ASSET"],
    // Liabilities
    ["2000", "Trade Payables", "LIABILITY", "CURRENT_LIABILITY"],
    ["2050", "Warranty Provision", "LIABILITY", "CURRENT_LIABILITY"],
    ["2100", "Loan Payable", "LIABILITY", "NON_CURRENT_LIABILITY"],
    ["2200", "Lease Liability", "LIABILITY", "NON_CURRENT_LIABILITY"],
    // Equity
    ["3100", "Owner Capital", "EQUITY", "EQUITY"],
    ["3200", "Retained Earnings", "EQUITY", "EQUITY"],
    ["3300", "Revaluation Surplus", "EQUITY", "EQUITY"],
    // Income
    ["4000", "Sales Revenue", "INCOME", "OPERATING_REVENUE"],
    ["4100", "Rental Income", "INCOME", "OPERATING_REVENUE"],
    ["4200", "Interest Income", "INCOME", "OTHER_INCOME"],
    ["4300", "Gain on Disposal", "INCOME", "OTHER_INCOME"],
    ["4550", "Gain on Biological Assets", "INCOME", "OTHER_INCOME"],
    // Expenditure
    ["5000", "Cost of Goods Sold", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5100", "Rent Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5200", "Salaries Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5210", "Finance Costs", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5220", "Commission Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5250", "Casual Labour Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5300", "Transport Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5400", "Utilities Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5600", "Insurance Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5700", "Depreciation Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5800", "Tax Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5900", "Other Operating Expense", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5910", "Discount Allowed", "EXPENDITURE", "OPERATING_EXPENSE"],
    ["5950", "Loss on Biological Assets", "EXPENDITURE", "OPERATING_EXPENSE"],
  ];
  const out = {};
  for (const [code, name, category, section] of rows) {
    out[code] = await upsertCode(code, name, category, section, entrepriseId);
  }
  return out;
}

async function seedAccounts(codes, entrepriseId) {
  const normalBalances = {
    ASSET: "DEBIT", LIABILITY: "CREDIT", EQUITY: "CREDIT",
    INCOME: "CREDIT", EXPENDITURE: "DEBIT",
  };
  const result = {};
  for (const [code, row] of Object.entries(codes)) {
    const category = row.Code_categories;
    // Accumulated Depreciation and Impairment are contra-assets (credit normal)
    const normalBal = (code === "1410" || code === "1420") ? "CREDIT" : (normalBalances[category] || "DEBIT");
    result[code] = await upsertAccount(row.Code_name, category, row.Account_codes_id, normalBal, entrepriseId);
  }
  return result;
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

module.exports = { seedAccountCodes, seedAccounts, upsertCode, upsertAccount };
