const express = require("express");
const router = express.Router();
const { prisma, PostingError, openAccountingPeriod, advancePeriodStatus, getPeriodCalendar } = require("../../services/postingEngine");
const { getAlerts } = require("../../services/alerts");

// GET /settings/alerts
router.get("/settings/alerts", async (req, res) => {
  try {
    const alerts = await getAlerts(req.currentUser.Entreprise_id);
    res.render("alerts", { title: "Alerts", active: "settingsAlerts", alerts });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading alerts: " + err.message);
  }
});

// GET /settings — Structures browser
router.get("/settings", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Structures.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: [{ Structures_Type: "asc" }, { Structures_id: "asc" }] });

    const today = new Date();
    const requestedYear = parseInt(req.query.year, 10) || today.getFullYear();
    const requestedMonth = parseInt(req.query.month, 10) || today.getMonth() + 1;
    const calendarByDate = await getPeriodCalendar(requestedYear, requestedMonth, entrepriseId);

    const daysInMonth = new Date(requestedYear, requestedMonth, 0).getDate();
    const firstWeekday = new Date(requestedYear, requestedMonth - 1, 1).getDay();
    const todayStr = today.toISOString().slice(0, 10);

    const calendarDays = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${requestedYear}-${String(requestedMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const entry = calendarByDate[dateStr];
      calendarDays.push({
        day: d,
        dateStr,
        isToday: dateStr === todayStr,
        status: entry ? entry.status : null,
        structuresId: entry ? entry.structuresId : null,
      });
    }

    let prevMonth = requestedMonth - 1, prevYear = requestedYear;
    if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
    let nextMonth = requestedMonth + 1, nextYear = requestedYear;
    if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

    res.render("settings", {
      title: "Settings",
      active: "settings",
      structures: rows.map((s) => ({
        id: s.Structures_id,
        parentId: s.Parent_Structure_id,
        type: s.Structures_Type || "UNCATEGORIZED",
        name: s.Structures_Name,
        description: s.Structures_Description,
        standardReference: s.Standard_Reference,
        periodStatus: s.Period_Status,
        ruleSeverity: s.Rule_Severity,
      })),
      calendar: {
        year: requestedYear,
        month: requestedMonth,
        monthLabel: new Date(requestedYear, requestedMonth - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
        firstWeekday,
        days: calendarDays,
        prevMonth, prevYear, nextMonth, nextYear,
        todayStr,
      },
      canReset: req.currentUser.Access_Level === "OWNER_FULL",
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading settings: " + err.message);
  }
});

// POST /settings/structures/:id/period-status
router.post("/settings/structures/:id/period-status", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const existing = await prisma.Structures.findUnique({ where: { Structures_id: Number(req.params.id) } });
    if (!existing || existing.Entreprise_id !== entrepriseId) {
      return res.status(404).send("Period not found");
    }
    await prisma.Structures.update({
      where: { Structures_id: Number(req.params.id) },
      data: { Period_Status: req.body.Period_Status },
    });
    res.redirect("/settings");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating period status: " + err.message);
  }
});

// POST /settings/period/open { date }
router.post("/settings/period/open", async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "date is required" });
    const period = await openAccountingPeriod({ date, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, structuresId: period.Structures_id, status: period.Period_Status });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error opening period" });
  }
});

// POST /settings/period/:id/close
router.post("/settings/period/:id/close", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;

    // Run the period-end checklist before allowing closure.
    // Seed checks first so a business that has never visited Settings
    // has the default check definitions available.
    const { seedPeriodEndChecks } = require("../../services/seed");
    const { getPeriodEndChecklist } = require("../../services/postingEngine");
    await seedPeriodEndChecks(entrepriseId);
    const checklist = await getPeriodEndChecklist(req.params.id, entrepriseId);

    if (!checklist.canClose) {
      return res.status(400).json({
        error: `This period has ${checklist.blockers.length} unresolved issue(s) that must be fixed before closing.`,
        canClose: false,
        blockers: checklist.blockers,
        checklist,
      });
    }

    const period = await advancePeriodStatus({ structuresId: req.params.id, status: "CLOSED", entrepriseId });
    res.json({ ok: true, structuresId: period.Structures_id, status: period.Period_Status, checklist });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error closing period" });
  }
});

// POST /settings/structures/:id/rule-severity
router.post("/settings/structures/:id/rule-severity", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const existing = await prisma.Structures.findUnique({ where: { Structures_id: Number(req.params.id) } });
    const isUniversal = existing && existing.Entreprise_id === null;
    if (!existing || (!isUniversal && existing.Entreprise_id !== entrepriseId)) {
      return res.status(404).send("Rule not found");
    }
    await prisma.Structures.update({
      where: { Structures_id: Number(req.params.id) },
      data: { Rule_Severity: req.body.Rule_Severity },
    });
    res.redirect("/settings");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating rule severity: " + err.message);
  }
});

// POST /settings/logic-conditions/:id/enforcement
router.post("/settings/logic-conditions/:id/enforcement", async (req, res) => {
  try {
    const validLevels = ["BLOCK", "WARN", "INFO"];
    if (!validLevels.includes(req.body.Enforcement)) {
      return res.status(400).send("Enforcement must be BLOCK, WARN, or INFO");
    }
    await prisma.LogicConditions.update({
      where: { LogicConditions_id: Number(req.params.id) },
      data: { Enforcement: req.body.Enforcement },
    });
    res.redirect("/settings/rules");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating enforcement level: " + err.message);
  }
});

// GET /settings/profile
router.get("/settings/profile", async (req, res) => {
  try {
    const { PERMISSIONS } = require("../../services/auth");
    const accessLevel = req.currentUser.Access_Level;
    const permissions = Object.entries(PERMISSIONS).map(([section, allowedLevels]) => ({
      label: section.charAt(0).toUpperCase() + section.slice(1),
      allowed: accessLevel === "OWNER_FULL" || allowedLevels.includes(accessLevel),
    }));

    res.render("profile", {
      title: "Profile",
      active: "profile",
      profile: {
        name: req.currentUser.Management_Name,
        username: req.currentUser.Username,
        role: req.currentUser.Management_Role,
        accessLevel,
        inheritanceStatus: req.currentUser.Inheritance_Status,
      },
      permissions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading profile: " + err.message);
  }
});

// GET /settings/rules — IAS/IFRS standards mapped to real Catalogue events,
// plus the LogicConditions enforcement rules actually running in the engine
router.get("/settings/rules", async (req, res) => {
  try {
    let standardRows = await prisma.Structures.findMany({
      where: { Structures_Type: "STANDARD", Entreprise_id: null },
      orderBy: { Structures_id: "asc" },
    });
    let sourceOfTruthRows = await prisma.Structures.findMany({
      where: { Structures_Type: "SYSTEM_ARCHITECTURE", Structure_Level: "RULE", Entreprise_id: null },
      orderBy: { Structures_id: "asc" },
    });
    let logicRows = await prisma.LogicConditions.findMany({ orderBy: { LogicConditions_id: "asc" } });

    // Auto-provision on first access — a business created through Sign Up
    // never had the manual seed script run for it, so without this these
    // sections would silently stay empty forever. Always re-run rather
    // than gating on "zero rows": upsertStructure/upsertProcessAction/
    // upsertLogicCondition only write when content has genuinely changed,
    // so this is cheap on every subsequent visit — and it's the only way
    // an already-seeded business (created before a content fix landed,
    // like ProcessActions' isPopulated flag) ever picks up that fix,
    // since the previous "only if zero rows" gate meant this whole block
    // could never run again once a business had any rows at all.
    const { seedAccountingRules, seedProcessActions, seedSourceOfTruthPolicy, seedCatalogueEvents } = require("../../services/seed");
    const entrepriseId = req.currentUser.Entreprise_id;
    await seedCatalogueEvents(entrepriseId);
    await seedAccountingRules(entrepriseId);
    await seedProcessActions();
    await seedSourceOfTruthPolicy(null);

    standardRows = await prisma.Structures.findMany({
      where: { Structures_Type: "STANDARD", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "asc" },
    });
    sourceOfTruthRows = await prisma.Structures.findMany({
      where: { Structures_Type: "SYSTEM_ARCHITECTURE", Structure_Level: "RULE", Entreprise_id: null },
      orderBy: { Structures_id: "asc" },
    });
    logicRows = await prisma.LogicConditions.findMany({ orderBy: { LogicConditions_id: "asc" } });

    const standards = [];
    for (const s of standardRows) {
      const policy = await prisma.Structures.findFirst({
        where: { Structures_Type: "ACCOUNTING_POLICY", Parent_Structure_id: s.Structures_id },
      });

      // Catalogue events stored on Structures_Condition as a pipe-separated
      // list at seed time — readable from the very first Rules page visit,
      // before any Catalogue rows exist for this business. Also check live
      // Catalogue rows if any have been linked (they get linked the first
      // time the relevant posting function runs and seeds its Catalogue row).
      const eventNamesFromSeed = s.Structures_Condition
        ? s.Structures_Condition.split("|").filter(Boolean)
        : [];
      const linkedCatalogueRows = await prisma.Catalogue.findMany({
        where: { Structures_id: s.Structures_id, Entreprise_id: entrepriseId },
      });
      const linkedEventNames = linkedCatalogueRows.map((c) => c.Event_Name);
      // Merge both sources — seed list gives the intent, live FK gives confirmation
      const allEventNames = [...new Set([...eventNamesFromSeed, ...linkedEventNames])];

      const [fullName, ownerExplanation] = (s.Structures_Description || "").split("|");

      standards.push({
        id: s.Structures_id,
        name: fullName || s.Structures_Name,
        reference: s.Standard_Reference,
        ownerExplanation: ownerExplanation || "",
        appliesTo: s.Applies_To_Table,
        ruleSeverity: s.Rule_Severity,
        policy: policy
          ? (() => {
              const [policyName, accountantDetail] = (policy.Structures_Description || "").split("|");
              return { name: policyName || policy.Structures_Name, accountantDetail: accountantDetail || "" };
            })()
          : null,
        catalogueEvents: allEventNames,
      });
    }

    const businessUnitRows = await prisma.Structures.findMany({ where: { Structures_Type: "BUSINESS_UNIT", Entreprise_id: entrepriseId }, orderBy: { Structures_Name: "asc" } });

    res.render("rules", {
      title: "Rules",
      active: "rules",
      standards,
      businessUnits: businessUnitRows.map((u) => u.Structures_Name),
      logicConditions: logicRows.map((l) => ({
        id: l.LogicConditions_id,
        name: l.Conditons_Name,
        checkExpression: l.Check_Expression,
        enforcement: l.Enforcement,
        ownerMessage: l.Owner_Message,
        accountantMessage: l.Accountant_Message,
        validationTier: l.Validation_Tier || "ACCOUNTING",
      })),
      sourceOfTruth: sourceOfTruthRows.map((r) => {
        const [question, note] = (r.Structures_Description || "").split("|");
        return {
          question: question || "",
          table: r.Structures_Name,
          note: note || "",
          isPopulated: r.Rule_Severity === "BLOCK",
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading rules: " + err.message);
  }
});

// POST /settings/reset-account — Owner-only. Clears all transactional
// data (Journal, Transactions, Records, Ledger, Income, Expenditure,
// Assets, Liability, Equity, Money, Evidence, Narrative, Knowledge,
// Documents, Reports) while keeping: Organisation, Management,
// Stakeholders, Products, Account_codes, Account, Catalogue, Structures,
// LogicConditions, ProcessActions. The user keeps their business setup,
// chart of accounts, products, and team — they just lose all posted
// transactions and start with a clean ledger.
router.post("/settings/reset-account", async (req, res) => {
  try {
    if (req.currentUser.Access_Level !== "OWNER_FULL") {
      return res.status(403).json({ error: "Only the Owner can reset the account." });
    }
    const entrepriseId = req.currentUser.Entreprise_id;
    const confirm = req.body.confirm;
    if (confirm !== "RESET") {
      return res.status(400).json({ error: 'Type "RESET" to confirm. This cannot be undone.' });
    }

    const { prisma } = require("../../services/postingEngine");

    // Delete in FK-safe order: children before parents.
    // Each deleteMany is scoped to this business's Entreprise_id.
    await prisma.$transaction(async (tx) => {
      // Knowledge and Narrative (no FK children)
      await tx.Knowledge.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Narrative.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Evidence → Documents
      await tx.Evidence.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Documents.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Reports
      await tx.Reports.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Ledger (references Journal, Transactions, Income, Expenditure, etc.)
      await tx.Ledger.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Money (financial instruments — loans, policies, debts)
      await tx.Money.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Income, Expenditure, Assets, Liability, Equity
      await tx.Income.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Expenditure.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Assets.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Liability.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Equity.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Journal (references Transactions)
      await tx.Journal.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Resources (inventory/biological assets)
      await tx.Resources.deleteMany({});
      // Records → Transactions
      await tx.Records.deleteMany({ where: { Entreprise_id: entrepriseId } });
      await tx.Transactions.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Payment
      await tx.Payment.deleteMany({});
      // Account_History
      await tx.Account_History.deleteMany({ where: { Entreprise_id: entrepriseId } });
      // Reset account balances to zero
      await tx.Account.updateMany({
        where: { Entreprise_id: entrepriseId },
        data: { Current_Balance: 0 },
      });
      // Clear period statuses (re-open today)
      await tx.Structures.deleteMany({
        where: { Structures_Type: "ACCOUNTING_PERIOD", Entreprise_id: entrepriseId },
      });
      const todayStr = new Date().toISOString().slice(0, 10);
      await tx.Structures.create({
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
    });

    res.json({ ok: true, message: "Account reset. All transactions cleared. Today's period is open." });
  } catch (err) {
    console.error("Reset failed:", err);
    res.status(500).json({ error: "Reset failed: " + err.message });
  }
});

module.exports = router;
