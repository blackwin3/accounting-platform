const bcrypt = require("bcryptjs");
const { prisma } = require("./postingEngine");

const ROLES = {
  OWNER_FULL: "Owner",
  ACCOUNTANT: "Accountant",
  ADVISOR: "Advisor",
  CASHIER: "Cashier",
  MANAGER: "Manager",
  VIEWER: "Viewer",
};

// Section -> which Access_Level values may access it.
// OWNER_FULL always has access to everything regardless of this table.
const PERMISSIONS = {
  pos: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR", "CASHIER", "MANAGER"],
  journal: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  ledger: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  resources: ["OWNER_FULL", "MANAGER"],
  products: ["OWNER_FULL", "MANAGER"],
  processing: ["OWNER_FULL", "MANAGER"],
  assets: ["OWNER_FULL"],
  claims: ["OWNER_FULL", "ACCOUNTANT"],
  expense: ["OWNER_FULL", "ACCOUNTANT"],
  payables: ["OWNER_FULL", "ACCOUNTANT"],
  liability: ["OWNER_FULL", "ACCOUNTANT"],
  money: ["OWNER_FULL"],
  transactions: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  accounts: ["OWNER_FULL", "ACCOUNTANT"],
  reports: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  business: ["OWNER_FULL"],
  stakeholders: ["OWNER_FULL", "MANAGER", "ACCOUNTANT"],
  management: ["OWNER_FULL"],
  knowledge: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  narrative: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  documents: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  settingsAlerts: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR", "MANAGER"],
  rules: ["OWNER_FULL", "ACCOUNTANT", "ADVISOR"],
  settings: ["OWNER_FULL"],
};

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyLogin(username, password) {
  const person = await prisma.Management.findFirst({ where: { Username: username } });
  if (!person || !person.Password_Hash) return null;
  const ok = await bcrypt.compare(password, person.Password_Hash);
  if (!ok) return null;
  return person;
}

function canAccess(accessLevel, section) {
  if (accessLevel === "OWNER_FULL") return true;
  const allowed = PERMISSIONS[section];
  if (!allowed) return true; // sections with no explicit rule are open to any logged-in person
  return allowed.includes(accessLevel);
}

function roleLabel(accessLevel) {
  return ROLES[accessLevel] || accessLevel || "Unknown";
}

/**
 * requireAuth — Express middleware: redirects to /login if no session.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

/**
 * requireSection(name) — Express middleware factory: checks the logged-in
 * person's Access_Level against PERMISSIONS[name]. Must run after requireAuth
 * and after req.currentUser has been populated.
 */
function requireSection(sectionName) {
  return (req, res, next) => {
    if (!req.currentUser) return res.redirect("/login");
    if (!canAccess(req.currentUser.Access_Level, sectionName)) {
      return res.status(403).render("forbidden", {
        title: "Access Denied",
        active: "",
        section: sectionName,
        layout: false,
      });
    }
    next();
  };
}

/**
 * loadCurrentUser — Express middleware: populates req.currentUser from the
 * session for every request (if logged in), so views can show the person's
 * name/role without every route re-querying it.
 */
async function loadCurrentUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      req.currentUser = await prisma.Management.findUnique({ where: { Administration_id: req.session.userId } });
    } catch (err) {
      // A transient DB hiccup here shouldn't take down the whole request
      // with an unhandled exception (previously: no try/catch at all,
      // meaning any failure here fell through to Express's default HTML
      // error page — exactly the "JSON.parse: unexpected character"
      // symptom a client sees when it expected JSON back). Treat as
      // "not logged in" and let requireAuth below handle it normally.
      console.error("loadCurrentUser: Management lookup failed:", err.message);
      req.currentUser = null;
    }
  }
  res.locals.currentUser = req.currentUser || null;
  res.locals.roleLabel = req.currentUser ? roleLabel(req.currentUser.Access_Level) : null;
  next();
}

/**
 * loadBusinessUnit — Express middleware: resolves the currently-selected
 * Business Unit from the session (defaulting to SHOP), and exposes the
 * full list of units for the sidebar switcher. Every posting route and
 * every filtered read should use req.currentBusinessUnit.
 *
 * Scoped to the logged-in person's own Entreprise_id — this is the first
 * and most visible multi-tenancy boundary: two different businesses
 * sharing this database must never see each other's business units here.
 */
async function loadBusinessUnit(req, res, next) {
  const entrepriseId = req.currentUser ? req.currentUser.Entreprise_id : null;
  const allUnits = entrepriseId
    ? await prisma.Structures.findMany({
        where: { Structures_Type: "BUSINESS_UNIT", Entreprise_id: entrepriseId },
        orderBy: { Structures_Name: "asc" },
      })
    : [];
  const selectedCode = (req.session && req.session.businessUnit) || "SHOP";
  const stillExists = allUnits.some((u) => u.Structures_Name === selectedCode);
  req.currentBusinessUnit = stillExists ? selectedCode : allUnits[0]?.Structures_Name || "SHOP";
  res.locals.currentBusinessUnit = req.currentBusinessUnit;
  res.locals.allBusinessUnits = allUnits;

  // Automatically open today's trading day if this business doesn't
  // already have one open — this is what removes the manual "open a new
  // day" step every morning. Checked on every authenticated page load
  // (cheap: a single indexed lookup), not just on Settings, so Till and
  // every other posting page just works without a prerequisite visit.
  // Deliberately silent: if this fails for any reason, the page still
  // loads normally and the existing "no period open" alert on the
  // dashboard still catches it — auto-opening is a convenience, not a
  // dependency the rest of the app should break without.
  if (entrepriseId) {
    try {
      const openPeriod = await prisma.Structures.findFirst({
        where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      });
      if (!openPeriod) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const existingToday = await prisma.Structures.findFirst({
          where: { Structures_Type: "ACCOUNTING_PERIOD", Structures_Name: todayStr, Entreprise_id: entrepriseId },
        });
        if (existingToday) {
          // Today exists but isn't OPEN (e.g. was manually closed earlier)
          // — re-open it rather than create a duplicate row.
          await prisma.Structures.update({
            where: { Structures_id: existingToday.Structures_id },
            data: { Period_Status: "OPEN" },
          });
        } else {
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
      }
    } catch (err) {
      console.error("Auto-open period check failed (non-fatal):", err.message);
    }
  }

  next();
}

/**
 * requireSetup — Express middleware: redirects to /setup if the logged-in
 * person's own business hasn't been set up yet. Scoped per Entreprise_id —
 * under multi-tenancy, one business finishing setup must never mark every
 * other business as "done" too.
 */
async function requireSetup(req, res, next) {
  if (req.path.startsWith("/setup") || req.path.startsWith("/api")) return next();
  const entrepriseId = req.currentUser ? req.currentUser.Entreprise_id : null;
  if (!entrepriseId) return res.redirect("/setup");
  const org = await prisma.Organisation.findUnique({ where: { Entreprise_id: entrepriseId } });
  // A freshly-created Organisation exists as a row (created at signup to
  // obtain a valid Entreprise_id) but has no real profile yet until the
  // Business step of the wizard runs — Organisational_Name is the signal.
  if (!org || !org.Organisational_Name) return res.redirect("/setup");
  next();
}

module.exports = { hashPassword, verifyLogin, canAccess, roleLabel, requireAuth, requireSection, requireSetup, loadCurrentUser, loadBusinessUnit, PERMISSIONS };
