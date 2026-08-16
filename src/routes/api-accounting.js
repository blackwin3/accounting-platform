/**
 * api-accounting.js — Core accounting routes: expenses, settlements,
 * fund movements, leases, provisions, and rent arrears.
 * Asset/investment/insurance routes moved to api-assets.js.
 * Diagnostics/corrections/succession moved to api-administration.js.
 */

const express = require("express");
const router = express.Router();
const {
  postLeaseCommencement, postLeasePayment, postLeaseTermination,
  postProvision, postProvisionUtilisation,
  postExpense, postReceivableSettlement, postPayableSettlement,
  postFunding, postFundTransfer, postUnitIncome,
  postCapitalWithdrawal, postLoanRepayment, postLoanClosure,
  postRentArrears, postSettleRentArrears,
  PostingError, prisma,
} = require("../services/postingEngine");

function requireCapitalApproval(req, res) {
  if (!["OWNER_FULL", "MANAGER", "ACCOUNTANT"].includes(req.currentUser.Access_Level)) {
    res.status(403).json({ error: "Insufficient access — this action requires Owner, Manager, or Accountant level." });
    return false;
  }
  return true;
}

// ── LEASES ───────────────────────────────────────────────────────────

router.post("/lease-commencement", async (req, res) => {
  try {
    const b = req.body;
    const result = await postLeaseCommencement({
      name: b.name, totalPayments: Number(b.totalPayments),
      leaseTerm: Number(b.leaseTerm), discountRate: b.discountRate ? Number(b.discountRate) : 10,
      paymentMethod: b.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording lease" });
  }
});

router.post("/lease-payment", async (req, res) => {
  try {
    const b = req.body;
    const result = await postLeasePayment({
      liabilityId: Number(b.liabilityId), amount: Number(b.amount),
      paymentMethod: b.paymentMethod,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording lease payment" });
  }
});

router.post("/lease-termination", async (req, res) => {
  try {
    const b = req.body;
    const result = await postLeaseTermination({
      assetsId: Number(b.assetsId),
      terminationReason: b.terminationReason || "EARLY_EXIT",
      paymentMethod: b.paymentMethod || "BANK",
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error terminating lease" });
  }
});

// ── PROVISIONS ───────────────────────────────────────────────────────

router.post("/provision", async (req, res) => {
  try {
    const result = await postProvision({
      amount: Number(req.body.amount), description: req.body.description,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording provision" });
  }
});

router.post("/provision-utilisation", async (req, res) => {
  try {
    const result = await postProvisionUtilisation({
      liabilityId: Number(req.body.liabilityId), amount: Number(req.body.amount),
      paymentMethod: req.body.paymentMethod,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error utilising provision" });
  }
});

// ── EXPENSES ─────────────────────────────────────────────────────────

router.post("/expense", async (req, res) => {
  try {
    const { category, amount, dueAmount, paymentMethod, notes, moneyId, nextDueDate } = req.body;
    const result = await postExpense({
      category, amount: Number(amount),
      dueAmount: dueAmount != null ? Number(dueAmount) : null,
      paymentMethod, notes,
      moneyId: moneyId || null,
      nextDueDate: nextDueDate || null,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({
      ok: true, transactionId: result.transaction.Transactions_id,
      expenseAmount: result.expenseAmount, prepaidAmount: result.prepaidAmount, totalPaid: result.totalPaid,
    });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording expense" });
  }
});

// ── SETTLEMENTS ──────────────────────────────────────────────────────

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

router.post("/liability/:id/pay", async (req, res) => {
  try {
    const { amount, paymentMethod, notes } = req.body;
    const liabilityId = Number(req.params.id);
    const entrepriseId = req.currentUser.Entreprise_id;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Amount must be positive" });

    const liability = await prisma.Liability.findUnique({ where: { Liability_id: liabilityId } });
    if (!liability || liability.Entreprise_id !== entrepriseId) return res.status(404).json({ error: "Liability not found" });
    const outstanding = Number(liability.Net_Amount || 0);
    if (outstanding <= 0) return res.status(400).json({ error: "This liability has already been fully paid." });
    if (Number(amount) > outstanding) return res.status(400).json({ error: `Payment (${amount}) exceeds outstanding amount (${outstanding}).` });

    if (liability.Liability_Type === "Loan") {
      const result = await postLoanRepayment({ amount: Number(amount), paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId });
      return res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingOutstanding: result.remainingOutstanding });
    }
    if (liability.Liability_Type === "Lease") {
      const { postLeasePayment } = require("../services/postingEngine");
      const result = await postLeasePayment({ liabilityId, amount: Number(amount), paymentMethod, entrepriseId });
      return res.json({ ok: true, transactionId: result.transaction.Transactions_id });
    }
    const result = await postPayableSettlement({ amount: Number(amount), paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingPayable: result.remainingPayable });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error paying liability" });
  }
});

// ── FUNDS ────────────────────────────────────────────────────────────

router.post("/funding", async (req, res) => {
  try {
    const b = req.body;
    const result = await postFunding({
      amount: Number(b.amount), fundType: b.fundType,
      paymentMethod: b.paymentMethod, notes: b.notes,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording funding" });
  }
});

router.post("/capital-withdrawal", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const result = await postCapitalWithdrawal({
      amount: Number(req.body.amount), paymentMethod: req.body.paymentMethod,
      notes: req.body.notes, businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording withdrawal" });
  }
});

router.post("/loan-repayment", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const { amount, interestAmount, paymentMethod, notes } = req.body;
    const result = await postLoanRepayment({
      amount: Number(amount), interestAmount: interestAmount ? Number(interestAmount) : 0,
      paymentMethod, notes, businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, principalPaid: result.principalPaid, interestPaid: result.interestPaid, remainingOutstanding: result.remainingOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording loan repayment" });
  }
});

router.post("/loan-closure", async (req, res) => {
  try {
    if (!requireCapitalApproval(req, res)) return;
    const result = await postLoanClosure({ moneyId: Number(req.body.moneyId), entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error closing loan" });
  }
});

router.post("/fund-transfer", async (req, res) => {
  try {
    const result = await postFundTransfer({
      amount: Number(req.body.amount), fromMethod: req.body.fromMethod, toMethod: req.body.toMethod,
      notes: req.body.notes, businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording fund transfer" });
  }
});

router.post("/unit-income", async (req, res) => {
  try {
    const b = req.body;
    const result = await postUnitIncome({
      incomeType: b.incomeType, amount: Number(b.amount),
      paymentMethod: b.paymentMethod, notes: b.notes,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording unit income" });
  }
});

// ── RENTAL ARREARS ───────────────────────────────────────────────────

router.post("/rent-arrears", async (req, res) => {
  try {
    const { assetsId, stakeholderId, amount, period, notes } = req.body;
    const result = await postRentArrears({
      assetsId: Number(assetsId), stakeholderId: Number(stakeholderId),
      amount: Number(amount), period, notes,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, arrearsId: result.arrears.Money_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording rent arrears" });
  }
});

router.post("/rent-arrears/:id/settle", async (req, res) => {
  try {
    const { amount, paymentMethod } = req.body;
    const result = await postSettleRentArrears({
      moneyId: req.params.id, amount: Number(amount), paymentMethod,
      businessUnit: req.currentBusinessUnit,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newOutstanding: result.newOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error settling rent arrears" });
  }
});

module.exports = router;
