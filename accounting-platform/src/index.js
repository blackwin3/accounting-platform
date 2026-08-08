const express = require("express");
const path = require("path");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const { PrismaClient } = require("@prisma/client");
const { requireAuth, requireSection, requireSetup, loadCurrentUser, loadBusinessUnit } = require("./services/auth");

const app = express();
const prisma = new PrismaClient();

// GET /version — registered first, before any other middleware, and
// deliberately dependency-free (no session, no DB query, no multer/pdfkit
// require). This is the definitive way to check whether a deployment
// genuinely picked up new code: if VERSION_MARKER below doesn't match
// what you expect, the deployment hasn't landed — full stop, no need to
// interpret logs or guess. If it DOES match but a feature still doesn't
// work, the deployment genuinely landed and the bug is real and specific,
// not a deployment-sync issue.
const VERSION_MARKER = "2026-08-02-documents-resilience-fix";
app.get("/version", (req, res) => {
  let multerStatus = "not checked";
  let pdfkitStatus = "not checked";
  try {
    require("multer");
    multerStatus = "installed";
  } catch (e) {
    multerStatus = "MISSING: " + e.message;
  }
  try {
    require("pdfkit");
    pdfkitStatus = "installed";
  } catch (e) {
    pdfkitStatus = "MISSING: " + e.message;
  }
  res.json({
    versionMarker: VERSION_MARKER,
    serverTime: new Date().toISOString(),
    nodeVersion: process.version,
    multer: multerStatus,
    pdfkit: pdfkitStatus,
  });
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("layout", "layout");
app.use(expressLayouts);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * fmt — thousand-separated currency formatting, available in every EJS
 * view as a global local. Use in place of Number.toFixed(2):
 *   <%= fmt(1234567.5) %>   ->  "1,234,567.50"
 *   <%= fmt(-42) %>         ->  "-42.00"
 * Genuinely global rather than added file-by-file — every view that
 * currently calls .toFixed(2) directly can switch to this over time
 * without needing its own formatting logic.
 */
app.use((req, res, next) => {
  res.locals.fmt = (n) => {
    const num = Number(n || 0);
    const sign = num < 0 ? "-" : "";
    const abs = Math.abs(num);
    const [whole, decimals] = abs.toFixed(2).split(".");
    const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}${withCommas}.${decimals}`;
  };
  next();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || "nzovu-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8-hour session, a working shift
  })
);

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Login/logout are open, everything else requires a session
app.use("/", require("./routes/auth"));

app.use(loadCurrentUser);
app.use(requireAuth);
app.use(requireSetup);
app.use(loadBusinessUnit);

// Section-level role gates
app.use("/pos", requireSection("pos"));
app.use("/journal", requireSection("journal"));
app.use("/ledger", requireSection("ledger"));
app.use("/resources", requireSection("resources"));
app.use("/products", requireSection("products"));
app.use("/assets", requireSection("assets"));
app.use("/claims", requireSection("claims"));
app.use("/expense", requireSection("expense"));
app.use("/payables", requireSection("payables"));
app.use("/liability", requireSection("liability"));
app.use("/money", requireSection("money"));
app.use("/transactions", requireSection("transactions"));
app.use("/accounts", requireSection("accounts"));
app.use("/reports", requireSection("reports"));
app.use("/organisation/business", requireSection("business"));
app.use("/organisation/stakeholders", requireSection("stakeholders"));
app.use("/organisation/management", requireSection("management"));
app.use("/organisation/processing", requireSection("processing"));
app.use("/knowledge", requireSection("knowledge"));
app.use("/narrative", requireSection("narrative"));
app.use("/documents", requireSection("documents"));
// Profile is every logged-in person's own account info — always allowed.
// Alerts and Rules have their own, broader gates. Everything else under
// /settings (Structures view and its edit actions) is Owner-only.
app.use("/settings/alerts", requireSection("settingsAlerts"));
app.use("/settings/rules", requireSection("rules"));
app.use((req, res, next) => {
  if (req.path === "/settings/profile") return next();
  if (req.path.startsWith("/settings")) return requireSection("settings")(req, res, next);
  next();
});

app.use("/", require("./routes/nav"));
app.use("/", require("./routes/pos"));
app.use("/api", require("./routes/api"));

// Global error handler — must be registered last, after every route. Any
// exception thrown anywhere in the middleware chain that isn't already
// caught by a route's own try/catch lands here instead of falling
// through to Express's default HTML error page. API routes always get a
// real JSON error body (so a client's `await res.json()` never chokes on
// HTML), matching what the app's own route-level catch blocks already
// return everywhere else — this just closes the gap for the paths that
// don't have one yet, like loadCurrentUser's unguarded Prisma call.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (req.path.startsWith("/api")) {
    return res.status(500).json({ error: "Internal server error. Please try again." });
  }
  res.status(500).send("Something went wrong. Please try again or contact support if this continues.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
