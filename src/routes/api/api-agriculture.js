/**
 * api-agriculture.js — Agriculture, livestock, and production routes.
 * Extracted from api-operational.js to reduce failure surface.
 */

const express = require("express");
const router = express.Router();
const {
  registerAnimal, recordMonthlyReview, recordAnimalLoss,
  recordBirth, recordHarvest, bulkPlanting,
  postSeasonalLabour, postRepackaging,
  PostingError, prisma,
} = require("../../services/postingEngine");

// ── LIVESTOCK ────────────────────────────────────────────────────────

router.post("/livestock/register", async (req, res) => {
  try {
    const b = req.body;
    const result = await registerAnimal({
      productId: Number(b.productId), tag: b.tag, category: b.category || "LIVESTOCK",
      sex: b.sex, growthStage: b.growthStage, condition: b.condition,
      birthDate: b.birthDate, fairValue: b.fairValue ? Number(b.fairValue) : null,
      parentResourcesId: b.parentResourcesId ? Number(b.parentResourcesId) : null,
    });
    res.json({ ok: true, resourcesId: result.Resources_id, tag: result.Animal_Tag });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error registering animal" });
  }
});

router.post("/livestock/:id/review", async (req, res) => {
  try {
    const result = await recordMonthlyReview({
      resourcesId: Number(req.params.id),
      growthStage: req.body.growthStage, condition: req.body.condition,
      fairValue: req.body.fairValue ? Number(req.body.fairValue) : null,
    });
    res.json({ ok: true, resourcesId: result.Resources_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording review" });
  }
});

router.post("/livestock/:id/loss", async (req, res) => {
  try {
    const result = await recordAnimalLoss({
      resourcesId: Number(req.params.id),
      reason: req.body.reason || "DEATH",
      notes: req.body.notes,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording loss" });
  }
});

router.post("/livestock/:id/birth", async (req, res) => {
  try {
    const b = req.body;
    const result = await recordBirth({
      parentResourcesId: Number(req.params.id),
      tag: b.tag, sex: b.sex,
      fairValue: b.fairValue ? Number(b.fairValue) : null,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, resourcesId: result.offspring.Resources_id, tag: result.offspring.Animal_Tag });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording birth" });
  }
});

router.post("/livestock/:id/harvest", async (req, res) => {
  try {
    const b = req.body;
    const result = await recordHarvest({
      resourcesId: Number(req.params.id),
      productId: b.productId ? Number(b.productId) : null,
      quantity: Number(b.quantity), unitCost: b.unitCost ? Number(b.unitCost) : null,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording harvest" });
  }
});

router.post("/livestock/bulk-planting", async (req, res) => {
  try {
    const b = req.body;
    const result = await bulkPlanting({
      productId: Number(b.productId), count: Number(b.count),
      tagPrefix: b.tagPrefix, category: b.category || "CROP",
      growthStage: b.growthStage || "SEEDLING",
      fairValue: b.fairValue ? Number(b.fairValue) : null,
    });
    res.json({ ok: true, count: result.length, tags: result.map(r => r.Animal_Tag) });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording bulk planting" });
  }
});

router.post("/seasonal-labour", async (req, res) => {
  try {
    const b = req.body;
    const result = await postSeasonalLabour({
      labourType: b.labourType || "FARM_LABOUR",
      days: Number(b.days), dailyRate: Number(b.dailyRate),
      workerName: b.workerName, description: b.description,
      paymentMethod: b.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording seasonal labour" });
  }
});

// ── REPACKAGING ──────────────────────────────────────────────────────

router.post("/repackaging", async (req, res) => {
  try {
    const b = req.body;
    const result = await postRepackaging({
      sourceProductId: Number(b.sourceProductId), targetProductId: Number(b.targetProductId),
      sourceQuantity: Number(b.sourceQuantity), targetQuantity: Number(b.targetQuantity),
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording repackaging" });
  }
});

module.exports = router;
