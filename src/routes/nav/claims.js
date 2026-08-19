const { getCurrencyConfig, makeFmt } = require("../../services/currency");
const express = require("express");
const router = express.Router();
const { prisma, getRiskPosition } = require("../../services/postingEngine");

// GET /expense — expense wizard + history + liabilities owed
router.get("/expense", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);

    const expenditureRows = await prisma.Expenditure.findMany({
      where: { Records_id: { in: unitRecordIds } },
      orderBy: { Expenditure_id: "desc" },
      take: 50,
    });

    const liabilityRows = await prisma.Liability.findMany({
      where: { Records_id: { in: unitRecordIds } },
      orderBy: { Liability_id: "desc" },
    });
    // Same fix as the standalone Liability page: a settled credit sale/
    // purchase, or a fully repaid loan, now genuinely reduces to 0
    // rather than sitting stale forever, so a 0-balance row here means
    // it's done, not still owed. Loans were added to this check after
    // postLoanRepayment started genuinely reducing Liability rows —
    // before that, a Loan could never reach 0 here, so excluding it from
    // the check was correct at the time; it stopped being correct the
    // moment repayment became a real, working feature.
    const visibleLiabilityRows = liabilityRows.filter((l) => {
      const settlesToZero = l.Liability_Type === "Trade Receivables" || l.Liability_Type === "Trade Payables" || l.Liability_Type === "Loan";
      return settlesToZero ? Number(l.Net_Amount || 0) > 0 : true;
    });
    const liabilitiesTotal = visibleLiabilityRows.reduce((sum, l) => sum + Number(l.Net_Amount || 0), 0);

    // Active insurance policies — so an INSURANCE-category expense can
    // genuinely be linked back to the specific policy it pays, rather
    // than only ever journaling correctly with no way to be recognised
    // against the policy itself.
    const activePolicies = await prisma.Money.findMany({
      where: { Instrument_type: "INSURANCE", Money_Status: "ACTIVE", Entreprise_id: entrepriseId },
      orderBy: { Money_Name: "asc" },
    });

    const currency = await getCurrencyConfig(prisma, req.currentUser.Entreprise_id);
    const fmt = makeFmt(currency);

    res.render("expense", {
      title: "Expenses",
      active: "expense",
      currentBusinessUnit: req.currentBusinessUnit,
      activePolicies: activePolicies.map((p) => ({
        id: p.Money_id,
        name: p.Money_Name,
        premiumDue: p.Outstanding_Amount != null ? Number(p.Outstanding_Amount) : null,
      })),
      expenseHistory: expenditureRows.map((e) => ({
        date: e.Period ? new Date(e.Period).toLocaleDateString("en-GB") : "",
        type: e.Expenditure_type,
        amount: Number(e.Net_Amount || 0),
        outstanding: Number(e.Expenditure_Outstanding || 0),
        isSettled: Number(e.Expenditure_Outstanding || 0) === 0,
      })),
      liabilities: visibleLiabilityRows.map((l) => ({
        type: l.Liability_Type,
        classification: l.Liability_Classification,
        amount: Number(l.Net_Amount || 0),
      })),
      liabilitiesTotal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading expenses: " + err.message);
  }
});

// GET /claims — the Claims group dashboard (expenses, liabilities)
router.get("/claims", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const expenditureRows = await prisma.Expenditure.findMany({ where: { Records_id: { in: unitRecordIds } } });
    const expensesThisMonth = expenditureRows
      .filter((e) => e.Period && new Date(e.Period) >= monthStart)
      .reduce((sum, e) => sum + Number(e.Net_Amount || 0), 0);

    const liabilityRows = await prisma.Liability.findMany({ where: { Records_id: { in: unitRecordIds } } });
    const liabilitiesTotal = liabilityRows.reduce((sum, l) => sum + Number(l.Net_Amount || 0), 0);

    res.render("claims", {
      title: "Claims",
      active: "claims",
      currentBusinessUnit: req.currentBusinessUnit,
      expensesThisMonth,
      expenseCount: expenditureRows.length,
      liabilitiesTotal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading claims dashboard: " + err.message);
  }
});

// GET /payables — outstanding Trade Receivables and Trade Payables, itemized
router.get("/payables", async (req, res) => {
  try {
    // Fixed while extracting: this route had no Entreprise_id filter at
    // all (only Business_Unit on Transactions, and Account.findMany() had
    // no filter whatsoever) — a real cross-business leak, same class as
    // several others found and fixed in earlier sessions, just missed on
    // this specific route until now.
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitTransactions = await prisma.Transactions.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Transactions_id: true },
    });
    const unitTxnIds = unitTransactions.map((t) => t.Transactions_id);

    const journal = await prisma.Journal.findMany({ where: { Transactions_id: { in: unitTxnIds } } });
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
    const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));

    const receivables = [];
    const payables = [];
    let receivablesTotal = 0;
    let payablesTotal = 0;

    for (const j of journal) {
      const acc = accountById[j.Account_id];
      if (!acc) continue;
      const debit = Number(j.Debit || 0);
      const credit = Number(j.Credit || 0);
      const date = j.Created_at ? new Date(j.Created_at).toLocaleDateString("en-GB") : "";

      if (acc.Account_Name === "Trade Receivables") {
        const net = debit - credit;
        receivablesTotal += net;
        if (net !== 0) receivables.push({ date, description: j.Description || "", amount: net });
      }
      if (acc.Account_Name === "Trade Payables") {
        const net = credit - debit;
        payablesTotal += net;
        if (net !== 0) payables.push({ date, description: j.Description || "", amount: net });
      }
    }

    res.render("payables", {
      title: "Payables",
      active: "payables",
      currentBusinessUnit: req.currentBusinessUnit,
      receivables: receivables.reverse(),
      payables: payables.reverse(),
      receivablesTotal,
      payablesTotal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading payables: " + err.message);
  }
});

// GET /liability — Liability rows (loans and other formal liabilities), current business unit
router.get("/liability", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);

    const liabilityRows = await prisma.Liability.findMany({
      where: { Records_id: { in: unitRecordIds } },
      orderBy: { Liability_id: "desc" },
    });
    // Now that settlements genuinely reduce individual Trade Receivables/
    // Payables rows (see postReceivableSettlement / postPayableSettlement)
    // AND repayments genuinely reduce Loan rows (see postLoanRepayment),
    // a row sitting at 0 means it's fully settled or repaid — filtered
    // from the outstanding list here rather than shown as a permanent
    // zero-value row. Discount rows stay visible (they're intentionally
    // zero, handled separately below) and Lease/Provision liability
    // types aren't affected by this filter since nothing yet reduces
    // them the same way.
    const visibleLiabilityRows = liabilityRows.filter((l) => {
      const isDiscount = l.Liability_Type === "Discount Allowed" || l.Liability_Type === "Discount Received";
      const settlesToZero = l.Liability_Type === "Trade Receivables" || l.Liability_Type === "Trade Payables" || l.Liability_Type === "Loan";
      if (settlesToZero) return Number(l.Net_Amount || 0) > 0;
      return true; // discounts and every other liability type unaffected
    });
    const liabilitiesTotal = visibleLiabilityRows.reduce((sum, l) => sum + Number(l.Net_Amount || 0), 0);

    const discountRecordsIds = visibleLiabilityRows
      .filter((l) => l.Liability_Type === "Discount Allowed" || l.Liability_Type === "Discount Received")
      .map((l) => l.Records_id);
    const discountJournalRows = discountRecordsIds.length
      ? await prisma.Journal.findMany({ where: { Description: { contains: "DISCOUNT_" }, Entreprise_id: entrepriseId } })
      : [];
    const discountAmountByRecordsId = {};
    for (const j of discountJournalRows) {
      const amt = Number(j.Debit || 0) || Number(j.Credit || 0);
      if (amt > 0) discountAmountByRecordsId[j.Records_id] = amt;
    }

    res.render("liability", {
      title: "Liability",
      active: "liability",
      currentBusinessUnit: req.currentBusinessUnit,
      liabilities: visibleLiabilityRows.map((l) => {
        const isDiscount = l.Liability_Type === "Discount Allowed" || l.Liability_Type === "Discount Received";
        return {
          type: l.Liability_Type,
          classification: l.Liability_Classification,
          amount: isDiscount ? (discountAmountByRecordsId[l.Records_id] || 0) : Number(l.Net_Amount || 0),
          isSettled: isDiscount,
        };
      }),
      liabilitiesTotal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading liability: " + err.message);
  }
});

// GET /claims/leases-provisions — commence/pay leases, record/utilise provisions
router.get("/claims/leases-provisions", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);

    const leaseRows = await prisma.Liability.findMany({
      where: { Records_id: { in: unitRecordIds }, Liability_Type: "Lease", Net_Amount: { gt: 0 } },
      orderBy: { Liability_id: "desc" },
    });
    const leaseRecordIds = leaseRows.map((l) => l.Records_id);
    const rouAssets = await prisma.Assets.findMany({ where: { Records_id: { in: leaseRecordIds } } });
    const descriptionByRecordsId = Object.fromEntries(rouAssets.map((a) => [a.Records_id, a.Assets_Type]));

    const provisionRows = await prisma.Liability.findMany({
      where: { Records_id: { in: unitRecordIds }, Liability_Type: "Warranty Provision", Net_Amount: { gt: 0 } },
      orderBy: { Liability_id: "desc" },
    });

    res.render("leases-provisions", {
      title: "Leases & Provisions",
      active: "leases-provisions",
      currentBusinessUnit: req.currentBusinessUnit,
      leases: leaseRows.map((l) => ({
        id: l.Liability_id,
        description: (descriptionByRecordsId[l.Records_id] || "Lease").replace(/^ROU:\s*/, ""),
        amount: Number(l.Net_Amount || 0),
      })),
      provisions: provisionRows.map((p) => ({
        id: p.Liability_id,
        amount: Number(p.Net_Amount || 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading leases and provisions: " + err.message);
  }
});

// GET /claims/risks-insurance — monitors existing Provisions alongside Insurance policies
router.get("/claims/risks-insurance", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;

    // getRiskPosition replaces the bespoke Money/Liability queries that
    // used to live here — it adds coverage ratio, expiry detection, and
    // high-risk flagging that the old route did not compute at all.
    const riskPosition = await getRiskPosition({ entrepriseId });

    res.render("risks-insurance", {
      title: "Risks & Insurance",
      active: "risks-insurance",
      currentBusinessUnit: req.currentBusinessUnit,
      riskPosition,
      fmt: makeFmt(await getCurrencyConfig(prisma, req.currentUser.Entreprise_id)),
      // Kept flat for backward compatibility with the EJS template's
      // existing loops — the template still iterates `policies` and
      // `provisions` directly; riskPosition supplies the management panel.
      provisions: (riskPosition.provisionsByType["Warranty Provision"]?.rows || []).map((r) => ({
        id: r.id,
        amount: r.outstanding,
      })),
      totalProvisions: riskPosition.totalProvisions,
      policies: riskPosition.activePolicies.map((p) => ({
        id: p.id,
        name: p.name,
        coverage: p.coverageAmount,
        premium: p.premiumDue,
        riskLevel: p.riskLevel,
        riskNote: p.riskNote,
        startDate: p.startDate ? new Date(p.startDate).toLocaleDateString("en-GB") : "—",
        maturityDate: p.expiryDate ? new Date(p.expiryDate).toLocaleDateString("en-GB") : "—",
        expiringWithin30Days: p.expiringWithin30Days,
        daysUntilExpiry: p.daysUntilExpiry,
      })),
      closedPolicies: [], // historical closed policies available via riskPosition.closedPoliciesCount
      totalCoverage: riskPosition.totalCoverageAmount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading risks and insurance: " + err.message);
  }
});

module.exports = router;
