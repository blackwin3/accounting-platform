/**
 * api-business.js — the Business Layer: Stakeholder, Management,
 * Organisation. Who the business is, who works in it, and who it deals
 * with — customers, tenants, suppliers, providers, employees. Extracted
 * from the original single api.js (1,436 lines, 54 routes) as part of a
 * 5-layer split matching this system's own architectural documentation
 * (Business / Operational / Accounting / Knowledge / Evidence).
 */

const express = require("express");
const router = express.Router();
const { prisma } = require("../services/postingEngine");

async function provisionCashAccount(entrepriseId) {
  const codeRow = await prisma.Account_codes.create({
    data: { Code: "1000", Code_name: "Cash / Till", Code_categories: "ASSET", Statement_Section: "CURRENT_ASSET", Is_Active: 1, Entreprise_id: entrepriseId },
  });
  return prisma.Account.create({
    data: { Account_Name: "Cash / Till", Account_Type: "ASSET", Account_Code_id: codeRow.Account_codes_id, Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
  });
}

async function provisionSellGoodsCatalogue(entrepriseId) {
  return prisma.Catalogue.create({
    data: {
      Event_Name: "SELL_GOODS_CASH",
      Event_Description: "Cash sale. DR Cash (1000) CR Sales (4000). At point of sale also fires RECORD_COGS.",
      Debit_Account_code: "1000",
      Credit_Account_code: "4000",
      Cash_Flow_Category: "OPERATING",
      Operational_Impact: "INVENTORY_DECREASE",
      Risk_Level: "LOW",
      Documentation_type: "RECEIPT",
      Report_trigger: "DAILY_SALES",
      Escalation_Role: "NONE",
      Cycle_type: "INCOME",
      Alert_Required: 0,
      Narrative_template: "Cash sale: {Quantity} x {Product_Name} at KES {UnitPrice} = KES {Amount}.",
      Evidence_template: "NONE",
      Report_sections: "RECEIPT:LineItem|DAILY_SALES:Revenue",
      Default_Business_Unit: "SHOP",
      Is_Active: 1,
      Version_No: 1,
      Effective_From: new Date("2020-04-01"),
      Entreprise_id: entrepriseId,
    },
  });
}

// GET /api/products — list sellable products with current stock, filtered to the active Business Unit,
// grouped as Inventory (goods) / Services / Utilities — in that order, matching how often each is used at the till
// GET /api/stakeholders/lookup — a lightweight list for the Till's
// customer/supplier picker, distinct from the full /organisation/stakeholders
// page. Only Customer/Supplier/Creditor/Debtor categories are relevant at
// the point of sale — family/employee/advisor stakeholders aren't offered here.
router.get("/stakeholders/lookup", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Stakeholder.findMany({
      where: {
        Entreprise_id: entrepriseId,
        Stakeholder_Category: { in: ["Customer", "Supplier"] },
      },
      orderBy: { First_name: "asc" },
    });
    res.json(
      rows.map((s) => ({
        id: s.Stakeholder_id,
        name: [s.First_name, s.Last_name].filter(Boolean).join(" ") || s.Business_name || `#${s.Stakeholder_id}`,
        category: s.Stakeholder_Category,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/organisation — create or update the single Organisation record
router.post("/organisation", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { name, industry, type, address, country, currency, businessUnits } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Organisation name is required" });

    const existing = await prisma.Organisation.findUnique({ where: { Entreprise_id: entrepriseId } });

    // Organisation.Account_id and Catalogue_id are NOT NULL in the schema;
    // anchor to this business's own cash account and SELL_GOODS_CASH
    // catalogue event, not whichever business's happened to be created
    // first — the previous version had no Entreprise_id filter on either
    // lookup, which could anchor a brand-new business to another
    // business's accounts entirely.
    const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
    const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;
    const anchorCatalogue = await prisma.Catalogue.findFirst({ where: { Event_Name: "SELL_GOODS_CASH", Entreprise_id: entrepriseId } });

    // A brand-new business signing up has none of these yet — seed.js was
    // never run for it, since signup never called it. Rather than block
    // setup on that, provision the minimum this Organisation row actually
    // needs (NOT NULL Account_id/Catalogue_id) right here, the same
    // self-provisioning pattern used throughout the posting engine.
    const resolvedCashAccount = cashAccount || (await provisionCashAccount(entrepriseId));
    const resolvedCatalogue = anchorCatalogue || (await provisionSellGoodsCatalogue(entrepriseId));

    const data = {
      Account_id: resolvedCashAccount.Account_id,
      Catalogue_id: resolvedCatalogue.Catalogue_id,
      Organisational_Name: name.trim(),
      Industry: industry || null,
      Organisation_Type: type || null,
      Organisation_Address: address || null,
      Organisation_Country: country || "Kenya",
      Country: country || "Kenya",
      Organisation_Currency: currency || "KES",
      Business_Units: businessUnits || null,
      Entreprise_id: entrepriseId,
    };

    const org = existing
      ? await prisma.Organisation.update({ where: { Entreprise_id: entrepriseId }, data })
      : await prisma.Organisation.create({ data });

    // Open today as the very first trading day for this business — this
    // is the actual fix for "no period open" persisting after signup: the
    // setup wizard never opened one, and nothing else did either.
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyOpenToday = await prisma.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Structures_Name: todayStr, Entreprise_id: entrepriseId },
    });
    if (!alreadyOpenToday) {
      await prisma.Structures.create({
        data: {
          Structures_Type: "ACCOUNTING_PERIOD",
          Framework_Name: "INTERNAL",
          Framework_Priority: 4,
          Structures_Name: todayStr,
          Structures_Description: `Trading day ${todayStr}`,
          Period_name: todayStr,
          Period_Status: "OPEN",
          Structures_Period: new Date(),
          Effective_From: new Date(),
          Effective_To: new Date(),
          Mandatory: 1,
          Rule_Severity: "BLOCK",
          Entreprise_id: entrepriseId,
        },
      });
    }

    res.json({ ok: true, organisationId: org.Entreprise_id });

    // Seed Catalogue events and rules after the response — errors here
    // must never fall through to the outer catch (response already sent).
    try {
      const seed = require("../services/seed");
      await seed.seedCatalogueEvents(entrepriseId);
      await seed.seedAccountingRules(entrepriseId);
      await seed.seedProcessActions();
      await seed.seedSourceOfTruthPolicy(null);
    } catch (seedErr) {
      console.error("Background seed after org creation failed:", seedErr.message);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error saving business profile" });
  }
});

// POST /api/stakeholders — add a new Stakeholder
router.post("/stakeholders", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { firstName, lastName, category, relationship, location } = req.body;
    if (!firstName || !firstName.trim()) return res.status(400).json({ error: "First name is required" });

    const stakeholder = await prisma.Stakeholder.create({
      data: {
        First_name: firstName.trim(),
        Last_name: lastName ? lastName.trim() : null,
        Stakeholder_Category: category || null,
        Relationship_to_owner: relationship || null,
        Location: location || null,
        Relationship_Status: "ACTIVE",
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, stakeholderId: stakeholder.Stakeholder_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding stakeholder" });
  }
});

// POST /api/management — link an existing Stakeholder to a Management role
router.post("/management", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { stakeholderId, role, accessLevel } = req.body;
    if (!stakeholderId) return res.status(400).json({ error: "stakeholderId is required" });
    if (!role || !role.trim()) return res.status(400).json({ error: "Role is required" });

    const stakeholder = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
    if (!stakeholder || stakeholder.Entreprise_id !== entrepriseId) return res.status(400).json({ error: "Stakeholder not found" });

    const anchorCatalogue = await prisma.Catalogue.findFirst({ where: { Event_Name: "SELL_GOODS_CASH", Entreprise_id: entrepriseId } });
    if (!anchorCatalogue) return res.status(400).json({ error: "System not fully seeded yet. Run the seed script first." });

    const management = await prisma.Management.create({
      data: {
        Catalogue_id: anchorCatalogue.Catalogue_id,
        Stakeholder_id: Number(stakeholderId),
        Management_Name: [stakeholder.First_name, stakeholder.Last_name].filter(Boolean).join(" "),
        Management_Role: role.trim(),
        Access_Level: accessLevel || "VIEWER",
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, managementId: management.Administration_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding management role" });
  }
});

// POST /api/management/:id/edit — update an existing user's role/access level (Owner only, gated on the page route)
router.post("/management/:id/edit", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role, accessLevel } = req.body;
    const target = await prisma.Management.findUnique({ where: { Administration_id: id } });
    if (!target) return res.status(404).json({ error: "User not found" });

    // Guard: never let the last remaining Owner be demoted away from OWNER_FULL
    if (target.Access_Level === "OWNER_FULL" && accessLevel !== "OWNER_FULL") {
      const ownerCount = await prisma.Management.count({ where: { Access_Level: "OWNER_FULL" } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Can't change this — they're the only Owner account. Promote someone else to Owner first." });
      }
    }

    await prisma.Management.update({
      where: { Administration_id: id },
      data: { Management_Role: role || target.Management_Role, Access_Level: accessLevel || target.Access_Level },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error updating user" });
  }
});

// POST /api/management/:id/delete — remove a user's Management role (Owner only, gated on the page route)
router.post("/management/:id/delete", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = await prisma.Management.findUnique({ where: { Administration_id: id } });
    if (!target) return res.status(404).json({ error: "User not found" });

    // Hard block, not just a warning: deleting the last Owner would lock
    // everyone out of Owner-only sections with no way back in.
    if (target.Access_Level === "OWNER_FULL") {
      const ownerCount = await prisma.Management.count({ where: { Access_Level: "OWNER_FULL" } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Can't delete the only Owner account. Promote someone else to Owner first." });
      }
    }

    await prisma.Management.delete({ where: { Administration_id: id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    // Foreign key constraints (Journal.Administration_id, Records.Administration_id, etc.)
    // will block deletion of anyone who has actually posted transactions — surface that plainly.
    if (err.code === "P2003" || (err.message && err.message.includes("Foreign key"))) {
      return res.status(400).json({ error: "This user has posted transactions and can't be deleted. Change their access level instead." });
    }
    res.status(500).json({ error: "Internal error deleting user" });
  }
});

// POST /api/setup/business-unit — create a new BUSINESS_UNIT Structures row.
// Used both by the first-run setup wizard and the Business page's "Add
// Business Unit" action later in the business's life.
router.post("/setup/business-unit", async (req, res) => {
  try {
    const entrepriseId = req.currentUser ? req.currentUser.Entreprise_id : null;
    if (!entrepriseId) return res.status(401).json({ error: "Not logged in." });

    const { code, description } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: "A unit code is required" });
    const normalizedCode = code.trim().toUpperCase();

    const existing = await prisma.Structures.findFirst({
      where: { Structures_Type: "BUSINESS_UNIT", Structures_Name: normalizedCode, Entreprise_id: entrepriseId },
    });
    if (existing) return res.status(400).json({ error: `A business unit named "${normalizedCode}" already exists.` });

    const unit = await prisma.Structures.create({
      data: {
        Structures_Type: "BUSINESS_UNIT",
        Framework_Name: "INTERNAL",
        Framework_Priority: 4,
        Structures_Name: normalizedCode,
        Structures_Description: description && description.trim() ? `${normalizedCode} — ${description.trim()}` : normalizedCode,
        Mandatory: 1,
        Rule_Severity: "INFO",
        Applies_To_Table: "TRANSACTION",
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, structureId: unit.Structures_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding business unit" });
  }
});

// POST /api/accounts/:codeId/rename { newCode, newName } — lets an Owner
// or Accountant customise an account code and its display name to match
// how their business actually refers to these accounts.
//
// Guards:
//   1. Owner/Accountant only — renaming an account changes how the entire
//      chart of accounts displays; Cashier and Manager cannot do this.
//   2. newCode must be unique for this business — two accounts cannot
//      share the same code.
//   3. Catalogue rows that reference the OLD code by Debit_Account_code
//      or Credit_Account_code are updated to the new code in the same
//      transaction — so the interpreter's resolveAccountByCode continues
//      to find the right account after a rename.
//   4. Account.Account_Name is updated to match the newName so the
//      Ledger, Trial Balance, and Cash Flow pages display the new label.
router.post("/accounts/:codeId/rename", async (req, res) => {
  try {
    const accessLevel = req.currentUser.Access_Level;
    if (accessLevel !== "OWNER_FULL" && accessLevel !== "ACCOUNTANT") {
      return res.status(403).json({ error: "Only the Owner or Accountant can rename account codes." });
    }

    const entrepriseId = req.currentUser.Entreprise_id;
    const codeId = Number(req.params.codeId);
    const { newCode, newName } = req.body;

    if (!newCode || !newCode.trim()) return res.status(400).json({ error: "newCode is required" });
    if (!newName || !newName.trim()) return res.status(400).json({ error: "newName is required" });

    const codeRow = await prisma.Account_codes.findUnique({ where: { Account_codes_id: codeId } });
    if (!codeRow || codeRow.Entreprise_id !== entrepriseId) {
      return res.status(404).json({ error: "Account code not found for this business." });
    }

    const oldCode = codeRow.Code;
    if (oldCode === newCode.trim() && codeRow.Code_name === newName.trim()) {
      return res.json({ ok: true, changed: false });
    }

    // Check uniqueness if the code is actually changing
    if (newCode.trim() !== oldCode) {
      const clash = await prisma.Account_codes.findFirst({ where: { Code: newCode.trim(), Entreprise_id: entrepriseId } });
      if (clash) return res.status(400).json({ error: `Account code "${newCode.trim()}" is already in use by another account.` });
    }

    await prisma.$transaction(async (tx) => {
      await tx.Account_codes.update({
        where: { Account_codes_id: codeId },
        data: { Code: newCode.trim(), Code_name: newName.trim() },
      });

      // Update the Account row's display name
      const account = await tx.Account.findFirst({ where: { Account_Code_id: codeId, Entreprise_id: entrepriseId } });
      if (account) {
        await tx.Account.update({ where: { Account_id: account.Account_id }, data: { Account_Name: newName.trim() } });
      }

      // Update any Catalogue rows that reference this code directly —
      // this is what makes the rename safe for the interpreter: after
      // renaming, resolveAccountByCode(newCode) will find the account
      // correctly because the Catalogue rows have also been updated.
      if (newCode.trim() !== oldCode) {
        await tx.Catalogue.updateMany({
          where: { Debit_Account_code: oldCode, Entreprise_id: entrepriseId },
          data: { Debit_Account_code: newCode.trim() },
        });
        await tx.Catalogue.updateMany({
          where: { Credit_Account_code: oldCode, Entreprise_id: entrepriseId },
          data: { Credit_Account_code: newCode.trim() },
        });
      }
    });

    res.json({ ok: true, changed: true, oldCode, newCode: newCode.trim(), newName: newName.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error renaming account code" });
  }
});

module.exports = router;
