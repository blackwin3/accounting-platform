/**
 * api-assets.js — Asset management, investments, insurance, and rental
 * property routes. Extracted from api-accounting.js to reduce file size
 * and isolate failure surfaces.
 */

const express = require("express");
const router = express.Router();
const {
  postAssetPurchase, postAssetDisposal, postDepreciationRun,
  postAssetImpairment, postAssetRevaluation,
  postInvestmentPurchase, postInvestmentSale,
  postInterestAccrual, postCouponReceipt,
  postInsurancePolicy, closeInsurancePolicy, postInsuranceClaim,
  postRentalPropertyPurchase, assignTenant,
  postBiologicalAssetRevaluation,
  PostingError, prisma,
} = require("../services/postingEngine");

function requireCapitalApproval(req, res) {
  if (!["OWNER_FULL", "MANAGER", "ACCOUNTANT"].includes(req.currentUser.Access_Level)) {
    res.status(403).json({ error: "Insufficient access — this action requires Owner, Manager, or Accountant level." });
    return false;
  }
  return true;
}

// ── FIXED ASSETS ─────────────────────────────────────────────────────

router.post("/asset-purchase", async (req, res) => {
  try {
    const b = req.body;
    const result = await postAssetPurchase({
      name: b.name, cost: Number(b.cost),
      usefulLifeYears: Number(b.usefulLifeYears || 5),
      residualValue: Number(b.residualValue || 0),
      depreciationMethod: b.depreciationMethod || "STRAIGHT_LINE",
      paymentMethod: b.paymentMethod,
      ownershipType: b.ownershipType || "BUSINESS",
      confirmDuplicate: b.confirmDuplicate || false,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, assetId: result.asset.Assets_id, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording asset purchase" });
  }
});

router.post("/asset-disposal", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const b = req.body;
    const result = await postAssetDisposal({
      assetsId: Number(b.assetsId), proceeds: Number(b.proceeds || 0),
      paymentMethod: b.paymentMethod || "CASH",
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording asset disposal" });
  }
});

router.post("/depreciation-run", async (req, res) => {
  try {
    const result = await postDepreciationRun({
      assetsId: Number(req.body.assetsId),
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error running depreciation" });
  }
});

router.post("/asset-impairment", async (req, res) => {
  try {
    const result = await postAssetImpairment({
      assetsId: Number(req.body.assetsId),
      impairmentAmount: Number(req.body.impairmentAmount),
      reason: req.body.reason,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording impairment" });
  }
});

router.post("/asset-revaluation", async (req, res) => {
  try {
    const result = await postAssetRevaluation({
      assetsId: Number(req.body.assetsId),
      newValue: Number(req.body.newValue),
      reason: req.body.reason,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording revaluation" });
  }
});

// ── INVESTMENTS ──────────────────────────────────────────────────────

router.post("/investment-purchase", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const b = req.body;
    const result = await postInvestmentPurchase({
      name: b.name, amount: Number(b.amount),
      interestRate: b.interestRate ? Number(b.interestRate) : null,
      maturityDate: b.maturityDate || null,
      paymentMethod: b.paymentMethod,
      productId: b.productId ? Number(b.productId) : null,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, moneyId: result.money.Money_id, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording investment purchase" });
  }
});

router.post("/investment-sale", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const b = req.body;
    const result = await postInvestmentSale({
      moneyId: Number(b.moneyId), proceeds: Number(b.proceeds),
      paymentMethod: b.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording investment sale" });
  }
});

router.post("/investment/:id/accrue-interest", async (req, res) => {
  try {
    const result = await postInterestAccrual({
      moneyId: req.params.id, amount: Number(req.body.amount),
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error accruing interest" });
  }
});

router.post("/investment/:id/receive-coupon", async (req, res) => {
  try {
    const result = await postCouponReceipt({
      moneyId: req.params.id, amount: Number(req.body.amount),
      paymentMethod: req.body.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error receiving coupon" });
  }
});

// ── INSURANCE ────────────────────────────────────────────────────────

router.post("/insurance-policy", async (req, res) => {
  try {
    const b = req.body;
    const result = await postInsurancePolicy({
      name: b.name, coverageAmount: Number(b.coverageAmount),
      premiumAmount: b.premiumAmount ? Number(b.premiumAmount) : null,
      startDate: b.startDate, maturityDate: b.maturityDate,
      riskLevel: b.riskLevel || "MEDIUM", riskNote: b.riskNote,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, moneyId: result.Money_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording insurance policy" });
  }
});

router.post("/insurance-policy/:id/close", async (req, res) => {
  try {
    const result = await closeInsurancePolicy({
      moneyId: Number(req.params.id),
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error closing insurance policy" });
  }
});

router.post("/insurance-policy/:id/claim", async (req, res) => {
  try {
    const b = req.body;
    const result = await postInsuranceClaim({
      moneyId: Number(req.params.id), amount: Number(b.amount),
      paymentMethod: b.paymentMethod, description: b.description,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording insurance claim" });
  }
});

// ── RENTAL PROPERTY ──────────────────────────────────────────────────

router.post("/investments/rental-property", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const b = req.body;
    const result = await postRentalPropertyPurchase({
      name: b.name, cost: Number(b.cost),
      usefulLifeYears: Number(b.usefulLifeYears || 20),
      monthlyRent: b.monthlyRent ? Number(b.monthlyRent) : null,
      paymentMethod: b.paymentMethod,
      businessUnit: req.currentBusinessUnit || "RENTAL",
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, assetId: result.asset.Assets_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording rental property" });
  }
});

router.post("/investments/rental-property/:id/assign-tenant", async (req, res) => {
  try {
    const b = req.body;
    const result = await assignTenant({
      assetsId: Number(req.params.id),
      stakeholderId: Number(b.stakeholderId),
      monthlyRent: b.monthlyRent ? Number(b.monthlyRent) : null,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error assigning tenant" });
  }
});

// ── BIOLOGICAL ASSET REVALUATION ─────────────────────────────────────

router.post("/livestock/:id/revalue", async (req, res) => {
  try {
    const result = await postBiologicalAssetRevaluation({
      resourcesId: req.params.id,
      newFairValue: Number(req.body.newFairValue),
      reason: req.body.reason,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, oldValue: result.oldValue, newValue: result.newValue, change: result.change });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error revaluing biological asset" });
  }
});

module.exports = router;
