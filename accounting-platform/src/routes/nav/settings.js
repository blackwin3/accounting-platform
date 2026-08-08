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
    const period = await advancePeriodStatus({ structuresId: req.params.id, status: "CLOSED", entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, structuresId: period.Structures_id, status: period.Period_Status });
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
    const { seedAccountingRules, seedProcessActions, seedSourceOfTruthPolicy } = require("../../services/seed");
    await seedAccountingRules(null);
    await seedProcessActions();
    await seedSourceOfTruthPolicy(null);

    standardRows = await prisma.Structures.findMany({
      where: { Structures_Type: "STANDARD", Entreprise_id: null },
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
      const catalogueEvents = await prisma.Catalogue.findMany({ where: { Structures_id: s.Structures_id } });

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
        catalogueEvents: catalogueEvents.map((c) => c.Event_Name),
      });
    }

    const entrepriseId = req.currentUser.Entreprise_id;
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

module.exports = router;
