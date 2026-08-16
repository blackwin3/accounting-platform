/**
 * api-administration.js — System administration routes:
 * diagnostics, settings, succession, and corrections.
 * Separated to reduce failure surface in the accounting routes.
 */

const express = require("express");
const router = express.Router();
const { postCorrection, postSuccession, replayAccountBalances, runSystemDiagnostics, PostingError, prisma } = require("../services/postingEngine");

// GET /api/diagnostics — runs all 10 system diagnostic checks
router.get("/diagnostics", async (req, res) => {
  try {
    const report = await runSystemDiagnostics(req.currentUser.Entreprise_id);
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error running diagnostics" });
  }
});

// POST /api/diagnostics/fix-balances — recalculates all account balances
// from the Journal. Owner only.
router.post("/diagnostics/fix-balances", async (req, res) => {
  try {
    if (req.currentUser.Access_Level !== "OWNER_FULL") {
      return res.status(403).json({ error: "Only the Owner can run balance repair." });
    }
    const result = await replayAccountBalances(req.currentUser.Entreprise_id, true);
    const fixed = result._fixedCount || 0;
    delete result._fixedCount;
    res.json({ ok: true, fixed, message: fixed > 0 ? `${fixed} account balance(s) corrected to match the Journal.` : "All balances already match the Journal." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error fixing balances" });
  }
});

// POST /api/settings { name, value, category } — update or create a setting
router.post("/settings", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { name, value, category } = req.body;
    if (!name || !value) return res.status(400).json({ error: "name and value are required" });

    const existing = await prisma.Settings.findFirst({ where: { Setting_Name: name, Entreprise_id: entrepriseId } });
    if (existing) {
      await prisma.Settings.update({ where: { Setting_id: existing.Setting_id }, data: { Setting_Value: String(value) } });
    } else {
      await prisma.Settings.create({
        data: { Setting_Category: category || "OTHER", Setting_Name: name, Setting_Value: String(value), Data_Type: "STRING", Entreprise_id: entrepriseId },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error saving setting" });
  }
});

// POST /api/corrections { originalTransactionId, amount, reason }
router.post("/corrections", async (req, res) => {
  try {
    const { originalTransactionId, amount, reason } = req.body;
    const result = await postCorrection({
      originalTransactionId: Number(originalTransactionId),
      amount: amount ? Number(amount) : null,
      reason,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, correction: result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error posting correction" });
  }
});

// POST /api/succession { outgoingManagementId/currentOwnerAdminId, ... }
router.post("/succession", async (req, res) => {
  try {
    const body = req.body;
    const result = await postSuccession({
      currentOwnerAdminId: body.currentOwnerAdminId || body.outgoingManagementId,
      successorStakeholderId: body.successorStakeholderId || body.incomingManagementId,
      reason: body.reason,
      alternativesConsidered: body.alternativesConsidered,
      witnesses: body.witnesses,
      valuationMethod: body.valuationMethod,
      valuationAmount: body.valuationAmount || body.transferAmount,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, succession: result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording succession" });
  }
});

module.exports = router;
