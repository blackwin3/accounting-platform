/**
 * seed.js — Main orchestrator. Imports from:
 *   seed-accounts.js   — account codes and chart of accounts
 *   seed-catalogue.js  — Catalogue event definitions
 *   seed-settings.js   — accounting rules, settings, period checks
 *   seed-demo.js       — demo business data (Chebet family)
 *
 * Run directly:  node src/services/seed.js
 * Or called from auth.js (signup) and api-business.js (organisation create)
 */

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

const { seedAccountCodes, seedAccounts } = require("./seed-accounts");
const { seedCatalogueEvents, upsertStructure } = require("./seed-catalogue");
const { seedAccountingRules, seedDefaultSettings, seedPeriodEndChecks } = require("./seed-settings");
const { seedChebetFamily, upsertProduct, upsertResource } = require("../seed-demo");

async function main() {
  const entrepriseId = (await prisma.Organisation.findFirst())?.Entreprise_id || null;
  if (!entrepriseId) {
    console.log("No Organisation found — run signup first.");
    return;
  }

  console.log(`Seeding data for Entreprise_id = ${entrepriseId}`);

  const codes = await seedAccountCodes(entrepriseId);
  const accounts = await seedAccounts(codes, entrepriseId);

  // Business units
  const businessUnits = {};
  for (const code of ["SHOP", "FARM", "HERD", "CATTLE", "RENTAL", "INVESTMENTS"]) {
    businessUnits[code] = await upsertStructure({
      Structures_Type: "BUSINESS_UNIT",
      Structures_Name: code,
      Structures_Description: `Business unit: ${code}`,
      Entreprise_id: entrepriseId,
    });
  }

  // Open today's period
  const today = new Date().toISOString().slice(0, 10);
  await upsertStructure({
    Structures_Type: "ACCOUNTING_PERIOD",
    Structure_Level: "RULE",
    Structures_Name: today,
    Structures_Description: `Trading day: ${today}`,
    Period_Status: "OPEN",
    Structures_Period: new Date(today + "T00:00:00.000Z"),
    Entreprise_id: entrepriseId,
  });

  await seedCatalogueEvents(entrepriseId);

  // Demo products
  const sugar = await upsertProduct("Sugar (1kg)", 150, 120, "SHOP", entrepriseId);
  const soap = await upsertProduct("Bar Soap", 60, 40, "SHOP", entrepriseId);
  await upsertResource(sugar.Product_id, 50);
  await upsertResource(soap.Product_id, 30);

  // Default management users
  const catalogueForManagement = await prisma.Catalogue.findFirst({ where: { Entreprise_id: entrepriseId } });
  const defaultPeople = [
    { name: "Owner", username: "owner", password: "owner123", accessLevel: "OWNER_FULL", role: "Owner" },
    { name: "Accountant", username: "accountant", password: "acct123", accessLevel: "ACCOUNTANT", role: "Accountant" },
  ];
  for (const p of defaultPeople) {
    await upsertManagement(p, catalogueForManagement.Catalogue_id, entrepriseId);
  }

  // Chebet family demo data
  await seedChebetFamily(catalogueForManagement.Catalogue_id, entrepriseId);

  // Accounting rules and settings (global, not business-specific)
  await seedAccountingRules(null);

  console.log("Seed complete.");
}

async function upsertManagement({ name, username, password, accessLevel, role }, catalogueId, entrepriseId) {
  const existing = await prisma.Management.findFirst({ where: { Username: username, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return prisma.Management.create({
    data: {
      Catalogue_id: catalogueId,
      Management_Name: name,
      Username: username,
      Password_Hash: await bcrypt.hash(password, 10),
      Management_Role: role,
      Access_Level: accessLevel,
      Inheritance_Status: role === "Owner" ? "CURRENT_OWNER" : null,
      Entreprise_id: entrepriseId,
    },
  });
}

// Re-export everything that external callers need
module.exports = {
  main,
  seedCatalogueEvents,
  seedAccountingRules,
  seedDefaultSettings,
  seedPeriodEndChecks,
  seedAccountCodes,
  seedAccounts,
  upsertManagement,
};

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
