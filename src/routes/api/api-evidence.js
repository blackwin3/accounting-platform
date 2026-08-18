/**
 * api-evidence.js — the Evidence Layer: Documents, Evidence, Reports.
 * Report status transitions live here — Documents' own real routes
 * (upload, receipt generation, file serving) live entirely in
 * routes/nav/documents.js already, correctly separate since they're
 * page-rendering routes with file-handling middleware, not JSON API
 * endpoints. This file is where the genuinely API-shaped Evidence-layer
 * actions belong, and where any future Documents/Evidence API endpoint
 * should be added rather than back into a single catch-all file.
 * Extracted from the original single api.js as part of a 5-layer split
 * matching this system's own architectural documentation.
 */

const express = require("express");
const router = express.Router();
const { prisma, verifyResourceQuantities, replayAccountBalances, getPeriodEndChecklist } = require("../../services/postingEngine");

// POST /api/reports/:id/status — advance a report's review/approval status.
// Distinct from Report_Stage (position in the close chain, set once at
// generation and never changed) — this tracks whether a human has actually
// reviewed, approved, or issued the report, independent of where it sits
// in the accounting chain.
router.post("/reports/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["DRAFT", "GENERATED", "REVIEWED", "APPROVED", "ISSUED", "SUPERSEDED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
    }
    const reportId = Number(req.params.id);
    const report = await prisma.Reports.findUnique({ where: { Reports_id: reportId } });
    if (!report) return res.status(404).json({ error: "Report not found" });

    await prisma.Reports.update({ where: { Reports_id: reportId }, data: { Report_Status: status } });
    res.json({ ok: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error updating report status" });
  }
});

// GET /api/verify/stock-quantities — compares the live Resources quantities
// (what the system believes is in stock) against what the transactional
// record actually implies when replayed from scratch. A discrepancy means
// a quantity was adjusted outside the normal posting flow — theft, data
// entry error, or a bug. Returns the full comparison plus any discrepancies.
// Genuinely read-only — no posting, no side-effects.
router.get("/verify/stock-quantities", async (req, res) => {
  try {
    const result = await verifyResourceQuantities(req.currentUser.Entreprise_id);
    res.json({
      ok: true,
      checked: result.checked,
      discrepanciesFound: result.discrepancies.length,
      clean: result.discrepancies.length === 0,
      discrepancies: result.discrepancies,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error verifying stock quantities" });
  }
});

// GET /api/verify/account-balances — replays every account's balance from
// the Journal from scratch, independent of any running total stored on the
// Account row itself. Confirms the Journal is internally consistent and that
// no balance has been manually edited outside the normal posting flow.
// Genuinely read-only — no posting, no side-effects.
router.get("/verify/account-balances", async (req, res) => {
  try {
    const balances = await replayAccountBalances(req.currentUser.Entreprise_id);
    const accounts = Object.values(balances);
    res.json({
      ok: true,
      accountCount: accounts.length,
      accounts: accounts.sort((a, b) => a.accountName.localeCompare(b.accountName)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error replaying account balances" });
  }
});

// GET /api/periods/:id/checklist — runs the configurable period-end
// checklist against a specific period, returning a structured pass/fail
// result for each check plus a canClose flag. BLOCK-severity failures
// must be resolved before the period can move to CLOSED.
// Idempotent and read-only — safe to call as many times as needed while
// working through the checklist.
router.get("/periods/:id/checklist", async (req, res) => {
  try {
    const { seedPeriodEndChecks } = require("../../services/seed/seed");
    await seedPeriodEndChecks(req.currentUser.Entreprise_id);
    const result = await getPeriodEndChecklist(req.params.id, req.currentUser.Entreprise_id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error running period-end checklist" });
  }
});

module.exports = router;
