const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

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

module.exports = { seedAccountCodes, seedAccounts, upsertCode, upsertAccount };
