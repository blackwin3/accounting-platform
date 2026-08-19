/**
 * api-services.js — Service engagements (start, log hours, bill) and
 * lessor routes (lease-out inventory, hire-out equipment).
 * Extracted from api-operational.js.
 */

const express = require("express");
const router = express.Router();
const {
  startServiceEngagement, logServiceHours, billServiceEngagement,
  leaseOutInventory, returnLeasedInventory,
  hireOutEquipment, endEquipmentHire,
  PostingError, prisma,
} = require("../../services/postingEngine");

// ── SERVICE ENGAGEMENTS ──────────────────────────────────────────────

router.post("/services/start", async (req, res) => {
  try {
    const b = req.body;
    const result = await startServiceEngagement({
      productId: Number(b.productId), client: b.stakeholderId ? Number(b.stakeholderId) : null,
      estimatedHours: b.estimatedHours ? Number(b.estimatedHours) : null,
      hourlyRate: b.hourlyRate ? Number(b.hourlyRate) : null,
      description: b.description,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, engagementId: result.engagement.Resources_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error starting service engagement" });
  }
});

router.post("/services/:id/log-hours", async (req, res) => {
  try {
    const result = await logServiceHours({
      resourcesId: Number(req.params.id),
      hours: Number(req.body.hours),
      notes: req.body.notes,
    });
    res.json({ ok: true, totalHours: result.totalHours });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error logging hours" });
  }
});

router.post("/services/:id/bill", async (req, res) => {
  try {
    const b = req.body;
    const result = await billServiceEngagement({
      resourcesId: Number(req.params.id),
      amount: Number(b.amount), paymentMethod: b.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error billing service" });
  }
});

// ── LESSOR — INVENTORY & EQUIPMENT ───────────────────────────────────

router.post("/lessor/lease-out", async (req, res) => {
  try {
    const b = req.body;
    const result = await leaseOutInventory({
      productId: Number(b.productId), quantity: Number(b.quantity),
      stakeholderId: Number(b.stakeholderId),
      dailyRate: b.dailyRate ? Number(b.dailyRate) : null,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, resourcesId: result.Resources_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error leasing out inventory" });
  }
});

router.post("/lessor/:id/return", async (req, res) => {
  try {
    const result = await returnLeasedInventory({
      resourcesId: Number(req.params.id),
      amount: req.body.amount ? Number(req.body.amount) : null,
      paymentMethod: req.body.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction?.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error returning leased inventory" });
  }
});

router.post("/lessor/equipment/hire-out", async (req, res) => {
  try {
    const b = req.body;
    const result = await hireOutEquipment({
      assetsId: Number(b.assetsId), stakeholderId: Number(b.stakeholderId),
      dailyRate: b.dailyRate ? Number(b.dailyRate) : null,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error hiring out equipment" });
  }
});

router.post("/lessor/equipment/:id/end-hire", async (req, res) => {
  try {
    const result = await endEquipmentHire({
      assetsId: Number(req.params.id),
      amount: req.body.amount ? Number(req.body.amount) : null,
      paymentMethod: req.body.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction?.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error ending equipment hire" });
  }
});

module.exports = router;
