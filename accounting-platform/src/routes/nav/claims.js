const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

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
    // purchase now genuinely reduces to 0 rather than sitting stale
    // forever, so a 0-balance row here means it's done, not still owed.
    const visibleLiabilityRows = liabilityRows.filter((l) => {
      const isCreditSaleOrPurchase = l.Liability_Type === "Trade Receivables" || l.Liability_Type === "Trade Payables";
      return isCreditSaleOrPurchase ? Number(l.Net_Amount || 0) > 0 : true;
    });
    const liabilitiesTotal = visibleLiabilityRows.reduce((sum, l) => sum + Number(l.Net_Amount || 0), 0);

    res.render("expense", {
      title: "Expenses",
      active: "expense",
      currentBusinessUnit: req.currentBusinessUnit,
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
    // Payables rows (see postReceivableSettlement / postPayableSettlement),
    // a row sitting at 0 means it's fully settled — filtered from the
    // outstanding list here rather than shown as a permanent zero-value
    // row. Discount rows stay visible (they're intentionally zero,
    // handled separately below) and other liability types (Loans, Lease,
    // Provisions) aren't affected by this filter since they were never
    // part of the bug being fixed.
    const visibleLiabilityRows = liabilityRows.filter((l) => {
      const isDiscount = l.Liability_Type === "Discount Allowed" || l.Liability_Type === "Discount Received";
      const isCreditSaleOrPurchase = l.Liability_Type === "Trade Receivables" || l.Liability_Type === "Trade Payables";
      if (isCreditSaleOrPurchase) return Number(l.Net_Amount || 0) > 0;
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
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);

    const provisionRows = await prisma.Liability.findMany({
      where: { Records_id: { in: unitRecordIds }, Liability_Type: "Warranty Provision" },
      orderBy: { Liability_id: "desc" },
    });
    const outstandingProvisions = provisionRows.filter((p) => Number(p.Net_Amount || 0) > 0);
    const totalProvisions = outstandingProvisions.reduce((sum, p) => sum + Number(p.Net_Amount || 0), 0);

    const activePolicies = await prisma.Money.findMany({
      where: { Instrument_type: "INSURANCE", Money_Status: "ACTIVE", Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
    });
    const closedPolicies = await prisma.Money.findMany({
      where: { Instrument_type: "INSURANCE", Money_Status: { not: "ACTIVE" }, Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
      take: 20,
    });
    const totalCoverage = activePolicies.reduce((sum, m) => sum + Number(m.Principal_amount || 0), 0);

    res.render("risks-insurance", {
      title: "Risks & Insurance",
      active: "risks-insurance",
      currentBusinessUnit: req.currentBusinessUnit,
      provisions: outstandingProvisions.map((p) => ({ id: p.Liability_id, amount: Number(p.Net_Amount || 0) })),
      totalProvisions,
      policies: activePolicies.map((m) => ({
        id: m.Money_id,
        name: m.Money_Name,
        coverage: Number(m.Principal_amount || 0),
        premium: m.Outstanding_Amount != null ? Number(m.Outstanding_Amount) : null,
        riskLevel: m.Risk_Level,
        riskNote: m.Risk_note,
        startDate: m.Start_date ? new Date(m.Start_date).toLocaleDateString("en-GB") : "—",
        maturityDate: m.Maturity_date ? new Date(m.Maturity_date).toLocaleDateString("en-GB") : "—",
      })),
      closedPolicies: closedPolicies.map((m) => ({ id: m.Money_id, name: m.Money_Name, status: m.Money_Status })),
      totalCoverage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading risks and insurance: " + err.message);
  }
});

module.exports = router;
