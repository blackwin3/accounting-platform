/**
 * api-hr.js — Human resource management routes.
 * Team management (add, update role, exit), payroll (salary, commission),
 * and workforce summary.
 */

const express = require("express");
const router = express.Router();
const {
  addTeamMember, updateTeamRole, exitTeamMember,
  postSalaryPayment, postCommissionPayment, getTeamSummary,
  PostingError,
} = require("../../services/postingEngine");

// ── TEAM MANAGEMENT ──────────────────────────────────────────────────

// POST /api/team/add { name, role, accessLevel, arrangementType, arrangementRate, monthlyCost, stakeholderId }
router.post("/team/add", async (req, res) => {
  try {
    const b = req.body;
    const result = await addTeamMember({
      stakeholderId: b.stakeholderId ? Number(b.stakeholderId) : null,
      name: b.name, role: b.role,
      accessLevel: b.accessLevel || "CASHIER",
      arrangementType: b.arrangementType || "SALARY",
      arrangementRate: b.arrangementRate ? Number(b.arrangementRate) : null,
      monthlyCost: b.monthlyCost ? Number(b.monthlyCost) : null,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, adminId: result.adminId, name: result.member.Management_Name });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error adding team member" });
  }
});

// POST /api/team/:id/update-role { newRole, newAccessLevel, newArrangementType, newRate, reason }
router.post("/team/:id/update-role", async (req, res) => {
  try {
    const b = req.body;
    const result = await updateTeamRole({
      adminId: Number(req.params.id),
      newRole: b.newRole, newAccessLevel: b.newAccessLevel,
      newArrangementType: b.newArrangementType,
      newRate: b.newRate ? Number(b.newRate) : null,
      reason: b.reason,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, changes: result.changes });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error updating role" });
  }
});

// POST /api/team/:id/exit { exitReason, notes }
router.post("/team/:id/exit", async (req, res) => {
  try {
    const result = await exitTeamMember({
      adminId: Number(req.params.id),
      exitReason: req.body.exitReason || "RESIGNED",
      notes: req.body.notes,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, exitReason: result.exitReason });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording exit" });
  }
});

// GET /api/team/summary
router.get("/team/summary", async (req, res) => {
  try {
    const summary = await getTeamSummary(req.currentUser.Entreprise_id);
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error loading team summary" });
  }
});

// ── PAYROLL ──────────────────────────────────────────────────────────

// POST /api/payroll/salary { adminId, amount, period, paymentMethod, notes }
router.post("/payroll/salary", async (req, res) => {
  try {
    const b = req.body;
    const result = await postSalaryPayment({
      adminId: Number(b.adminId), amount: b.amount ? Number(b.amount) : null,
      period: b.period, paymentMethod: b.paymentMethod,
      notes: b.notes, businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({
      ok: true, transactionId: result.transaction.Transactions_id,
      paidTo: result.paidTo, amount: result.amount, arrangement: result.arrangement,
    });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording salary payment" });
  }
});

// POST /api/payroll/commission { adminId, revenueBase, period, paymentMethod }
router.post("/payroll/commission", async (req, res) => {
  try {
    const b = req.body;
    const result = await postCommissionPayment({
      adminId: Number(b.adminId), revenueBase: Number(b.revenueBase),
      period: b.period, paymentMethod: b.paymentMethod,
      notes: b.notes, businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({
      ok: true, transactionId: result.transaction.Transactions_id,
      paidTo: result.paidTo, amount: result.amount,
    });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording commission" });
  }
});

module.exports = router;
