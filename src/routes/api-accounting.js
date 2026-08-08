/**
 * api-accounting.js — the Accounting Layer: Journal, Ledger, Account,
 * Income, Expenditure, Assets, Liability, Equity. Every route here
 * genuinely posts a real, balanced Journal entry — Assets, Leases &
 * Provisions, Expenses, Fund movements, Investments, Insurance, Rental
 * Property, and Corrections. Extracted from the original single api.js
 * as part of a 5-layer split matching this system's own architectural
 * documentation.
 */

const express = require("express");
const router = express.Router();
const { postAssetPurchase, postAssetDisposal, postDepreciationRun, postAssetImpairment, postAssetRevaluation, postLeaseCommencement, postLeasePayment, postLeaseTermination, postProvision, postProvisionUtilisation, postExpense, postReceivableSettlement, postPayableSettlement, postFunding, postFundTransfer, postUnitIncome, postCapitalWithdrawal, postLoanRepayment, postLoanClosure, postInvestmentPurchase, postInvestmentSale, postInsurancePolicy, closeInsurancePolicy, postInsuranceClaim, postRentalPropertyPurchase, assignTenant, postCorrection, postSuccession, PostingError, prisma } = require("../services/postingEngine");

// requireCapitalApproval — genuinely restricts capital-moving actions
// (withdrawing capital, repaying a loan, buying/selling an investment,
// acquiring a rental property) to Owner or Accountant, matching the
// exact precedent /corrections already set. Before this, these 5
// endpoints had zero access restriction at all — any logged-in user
// could technically call them; this closes that gap rather than only
// documenting who "should" be able to approve them.
const CAPITAL_APPROVAL_ROLES = ["OWNER_FULL", "ACCOUNTANT"];
function requireCapitalApproval(req, res) {
  if (!CAPITAL_APPROVAL_ROLES.includes(req.currentUser.Access_Level)) {
    res.status(403).json({ error: "Only the Owner or Accountant can approve this capital action." });
    return false;
  }
  return true;
}

// POST /api/asset-purchase { name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, ownershipType }
router.post("/asset-purchase", async (req, res) => {
  try {
    const { name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, ownershipType } = req.body;
    const result = await postAssetPurchase({ name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, ownershipType, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    const monthlyDepreciation = (cost - (residualValue || 0)) / usefulLifeYears / 12;
    res.json({
      ok: true,
      assetId: result.asset.Assets_id,
      transactionId: result.transaction.Transactions_id,
      monthlyDepreciation,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error recording asset purchase" });
  }
});

// POST /api/asset-disposal { assetId, proceeds, paymentMethod }
router.post("/asset-disposal", async (req, res) => {
  try {
    const { assetId, proceeds, paymentMethod } = req.body;
    const result = await postAssetDisposal({ assetId, proceeds, paymentMethod, entrepriseId: req.currentUser.Entreprise_id });
    res.json({
      ok: true,
      transactionId: result.transaction.Transactions_id,
      gainLoss: result.gainLoss,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error recording asset disposal" });
  }
});

// POST /api/depreciation-run { assetId, amount? } — amount is optional, defaults to one month straight-line
router.post("/depreciation-run", async (req, res) => {
  try {
    const { assetId, amount } = req.body;
    const result = await postDepreciationRun({ assetId, amount: amount ? Number(amount) : undefined, entrepriseId: req.currentUser.Entreprise_id });
    res.json({
      ok: true,
      transactionId: result.transaction.Transactions_id,
      amount: result.amount,
      newAccumulated: result.newAccumulated,
      newCarrying: result.newCarrying,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error posting depreciation" });
  }
});

// POST /api/asset-impairment { assetId, writeDownAmount, reason }
router.post("/asset-impairment", async (req, res) => {
  try {
    const { assetId, writeDownAmount, reason } = req.body;
    const result = await postAssetImpairment({ assetId, writeDownAmount: Number(writeDownAmount), reason, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newCarrying: result.newCarrying });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error recording impairment" });
  }
});

// POST /api/asset-revaluation { assetId, newValue, reason }
router.post("/asset-revaluation", async (req, res) => {
  try {
    const { assetId, newValue, reason } = req.body;
    const result = await postAssetRevaluation({ assetId, newValue: Number(newValue), reason, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newCarrying: result.newCarrying, change: result.change });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error revaluing asset" });
  }
});

// POST /api/lease-commencement { description, totalLeasePayments, leaseTermYears }
router.post("/lease-commencement", async (req, res) => {
  try {
    const { description, totalLeasePayments, leaseTermYears } = req.body;
    const result = await postLeaseCommencement({
      description,
      totalLeasePayments,
      leaseTermYears,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, liabilityId: result.liability.Liability_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error commencing lease" });
  }
});

// POST /api/lease-payment { liabilityId, amount, paymentMethod }
router.post("/lease-payment", async (req, res) => {
  try {
    const { liabilityId, amount, paymentMethod } = req.body;
    const result = await postLeasePayment({ liabilityId, amount, paymentMethod, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newOutstanding: result.newOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording lease payment" });
  }
});

// POST /api/lease-termination { assetId, liabilityId, earlyExit, notes }
// Derecognises the ROU asset and Lease Liability simultaneously.
// earlyExit=true means the lease ends before the contracted end date —
// the accounting logic is identical either way, but the Narrative and
// audit trail distinguish natural expiry from early termination.
router.post("/lease-termination", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { assetId, liabilityId, earlyExit, notes } = req.body;
    const result = await postLeaseTermination({
      assetId, liabilityId,
      earlyExit: !!earlyExit,
      notes,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({
      ok: true,
      transactionId: result.transaction.Transactions_id,
      carryingAmount: result.carryingAmount,
      liabilityRemaining: result.liabilityRemaining,
      variance: result.variance,
    });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error terminating lease" });
  }
});

// POST /api/provision { amount, description }
router.post("/provision", async (req, res) => {
  try {
    const { amount, description } = req.body;
    const result = await postProvision({ amount, description, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, liabilityId: result.liability.Liability_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording provision" });
  }
});

// POST /api/provision-utilisation { liabilityId, amount, paymentMethod }
router.post("/provision-utilisation", async (req, res) => {
  try {
    const { liabilityId, amount, paymentMethod } = req.body;
    const result = await postProvisionUtilisation({ liabilityId, amount, paymentMethod, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newOutstanding: result.newOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error honouring claim" });
  }
});

// POST /api/expense { category, amount, paymentMethod, notes }
router.post("/expense", async (req, res) => {
  try {
    const { category, amount, paymentMethod, notes, moneyId, nextDueDate } = req.body;
    const result = await postExpense({
      category, amount, paymentMethod, notes,
      moneyId: moneyId || null,
      nextDueDate: nextDueDate || null,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording expense" });
  }
});

// POST /api/settle-receivable { amount, paymentMethod, notes } — a customer pays down an outstanding credit sale
router.post("/settle-receivable", async (req, res) => {
  try {
    const { amount, paymentMethod, notes } = req.body;
    const result = await postReceivableSettlement({ amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingReceivable: result.remainingReceivable });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error settling receivable" });
  }
});

// POST /api/settle-payable { amount, paymentMethod, notes } — the business pays down an outstanding credit purchase/expense
router.post("/settle-payable", async (req, res) => {
  try {
    const { amount, paymentMethod, notes } = req.body;
    const result = await postPayableSettlement({ amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingPayable: result.remainingPayable });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error settling payable" });
  }
});

// POST /api/funding { source: "CAPITAL"|"LOAN", amount, paymentMethod, notes }
router.post("/funding", async (req, res) => {
  try {
    const { source, amount, paymentMethod, notes } = req.body;
    const result = await postFunding({ source, amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording funds" });
  }
});

// POST /api/capital-withdrawal { amount, paymentMethod, notes } — the
// owner takes capital back out. Refused if it would exceed what's
// genuinely still injected and not yet withdrawn.
router.post("/capital-withdrawal", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { amount, paymentMethod, notes } = req.body;
    const result = await postCapitalWithdrawal({ amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording capital withdrawal" });
  }
});

// POST /api/loan-repayment { amount, paymentMethod, notes } — pay down
// an outstanding loan. Refused if it would exceed what's genuinely still
// outstanding.
router.post("/loan-repayment", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { amount, paymentMethod, notes } = req.body;
    const result = await postLoanRepayment({ amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingOutstanding: result.remainingOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording loan repayment" });
  }
});

// POST /api/loan-closure { liabilityId, notes } — formally closes a
// fully-repaid loan. Confirms the outstanding balance is genuinely zero
// before allowing it. No Journal posting — closure is an administrative
// act confirming what the repayments have already achieved, not a
// financial event.
router.post("/loan-closure", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { liabilityId, notes } = req.body;
    const result = await postLoanClosure({ liabilityId, notes, administrationId: req.currentUser.Administration_id, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, liabilityId: result.liabilityId });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error closing loan" });
  }
});

// POST /api/fund-transfer { from, to, amount, notes } — move money between
// the business's own Cash/Mobile/Bank accounts, e.g. topping up a low
// account to cover an upcoming purchase or bill.
router.post("/fund-transfer", async (req, res) => {
  try {
    const { from, to, amount, notes } = req.body;
    const result = await postFundTransfer({ from, to, amount, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error transferring funds" });
  }
});

// POST /api/investment-purchase { name, amount, paymentMethod, interestRate, maturityDate, productId }
router.post("/investment-purchase", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { name, amount, paymentMethod, interestRate, maturityDate, productId } = req.body;
    const result = await postInvestmentPurchase({
      name,
      amount,
      paymentMethod,
      interestRate: interestRate ? Number(interestRate) : null,
      maturityDate,
      productId: productId ? Number(productId) : null,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, moneyId: result.money.Money_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error purchasing investment" });
  }
});

// POST /api/investment-sale { moneyId, proceeds, paymentMethod }
router.post("/investment-sale", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { moneyId, proceeds, paymentMethod } = req.body;
    const result = await postInvestmentSale({
      moneyId,
      proceeds,
      paymentMethod,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, gainLoss: result.gainLoss });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error selling investment" });
  }
});

// POST /api/insurance-policy { name, coverageAmount, premiumAmount, startDate, maturityDate, riskLevel, riskNote }
router.post("/insurance-policy", async (req, res) => {
  try {
    const { name, coverageAmount, premiumAmount, startDate, maturityDate, riskLevel, riskNote } = req.body;
    const result = await postInsurancePolicy({
      name,
      coverageAmount: Number(coverageAmount),
      premiumAmount: premiumAmount ? Number(premiumAmount) : null,
      startDate,
      maturityDate,
      riskLevel,
      riskNote,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, moneyId: result.policy.Money_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording insurance policy" });
  }
});

// POST /api/insurance-policy/:id/close — mark a policy as lapsed/cancelled
router.post("/insurance-policy/:id/close", async (req, res) => {
  try {
    await closeInsurancePolicy({ moneyId: req.params.id, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error closing policy" });
  }
});

// POST /api/insurance-policy/:id/claim { amount, paymentMethod, closePolicy, notes }
// Records an insurer paying a claim against a specific policy. DR the
// payment account CR Insurance Claim Income (4800). Closes the Tier 2
// gap: previously the claim direction of the insurance cycle had no
// posting route — only the premium payment (postExpense/moneyId) was
// wired. closePolicy=true marks the policy as SETTLED if this claim
// fully settles it; leave false if the policy continues after a partial
// claim.
router.post("/insurance-policy/:id/claim", async (req, res) => {
  try {
    const { amount, paymentMethod, closePolicy, notes } = req.body;
    const result = await postInsuranceClaim({
      moneyId: req.params.id,
      amount,
      paymentMethod,
      closePolicy: !!closePolicy,
      notes,
      administrationId: req.currentUser.Administration_id,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, policyClosed: result.policyClosed });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording insurance claim" });
  }
});

// POST /api/corrections { originalJournalId, reason } — reverses a
// specific Journal entry pair, matching the schema's documented rule:
// original never touched, a new entry reverses it. Restricted to
// Owner/Accountant — undoing a posted entry is a genuinely high-trust
// action, deliberately not available to Cashier or Manager.
router.post("/corrections", async (req, res) => {
  try {
    const accessLevel = req.currentUser.Access_Level;
    if (accessLevel !== "OWNER_FULL" && accessLevel !== "ACCOUNTANT") {
      return res.status(403).json({ error: "Only the Owner or Accountant can correct a posted entry." });
    }
    const { originalJournalId, reason } = req.body;
    const result = await postCorrection({
      originalJournalId: Number(originalJournalId),
      reason,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, reversedCount: result.reversedCount });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error posting correction" });
  }
});

// POST /api/investments/rental-property { name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, tenantStakeholderId, monthlyRent }
router.post("/investments/rental-property", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, tenantStakeholderId, monthlyRent } = req.body;
    const result = await postRentalPropertyPurchase({
      name,
      cost: Number(cost),
      usefulLifeYears: Number(usefulLifeYears),
      residualValue: residualValue ? Number(residualValue) : 0,
      depreciationMethod: depreciationMethod || "STRAIGHT_LINE",
      paymentMethod: paymentMethod || "CASH",
      tenantStakeholderId: tenantStakeholderId || null,
      monthlyRent: monthlyRent ? Number(monthlyRent) : null,
      administrationId: req.currentUser.Administration_id,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, assetsId: result.asset.Assets_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error purchasing rental property" });
  }
});

// POST /api/investments/rental-property/:id/assign-tenant { tenantStakeholderId, monthlyRent }
router.post("/investments/rental-property/:id/assign-tenant", async (req, res) => {
  try {
    const { tenantStakeholderId, monthlyRent } = req.body;
    await assignTenant({
      assetsId: Number(req.params.id),
      tenantStakeholderId: tenantStakeholderId || null,
      monthlyRent: monthlyRent != null && monthlyRent !== "" ? Number(monthlyRent) : null,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error assigning tenant" });
  }
});

// POST /api/unit-income { incomeType, amount, paymentMethod, notes, stakeholderId, moneyId }
router.post("/unit-income", async (req, res) => {
  try {
    const { incomeType, amount, paymentMethod, notes, stakeholderId, moneyId } = req.body;
    const result = await postUnitIncome({
      incomeType,
      amount,
      paymentMethod,
      notes,
      stakeholderId,
      moneyId,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording income" });
  }
});

// POST /api/succession { outgoingManagementId, incomingManagementId, reason, transferAmount }
// The formal transfer of ownership from one person to another. Posts a
// balanced equity transfer entry and updates Management inheritance
// statuses. Requires capital-level approval. The Tier 3 gap being closed:
// "no accounting event for succession."
router.post("/succession", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { outgoingManagementId, incomingManagementId, reason, transferAmount } = req.body;
    const result = await postSuccession({
      outgoingManagementId: Number(outgoingManagementId),
      incomingManagementId: Number(incomingManagementId),
      reason,
      transferAmount: transferAmount != null ? Number(transferAmount) : null,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({
      ok: true,
      transferAmount: result.transferAmount,
      outgoingName: result.outgoingName,
      incomingName: result.incomingName,
    });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording succession" });
  }
});

module.exports = router;
