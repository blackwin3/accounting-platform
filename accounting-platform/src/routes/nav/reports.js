const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");
const reporting = require("../../services/reporting");
const { todayLabel, startOfToday } = require("./navShared");

// GET /reports
router.get("/reports", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const since = startOfToday();

    const salesAgg = await prisma.Journal.aggregate({
      _sum: { Debit: true },
      where: { Created_at: { gte: since }, Description: { startsWith: "SELL_GOODS_CASH" }, Entreprise_id: entrepriseId },
    });
    const cogsAgg = await prisma.Journal.aggregate({
      _sum: { Debit: true },
      where: { Created_at: { gte: since }, Description: { startsWith: "RECORD_COGS" }, Entreprise_id: entrepriseId },
    });
    const purchasesAgg = await prisma.Journal.aggregate({
      _sum: { Debit: true },
      where: {
        Created_at: { gte: since },
        Entreprise_id: entrepriseId,
        OR: [
          { Description: { startsWith: "BUY_INVENTORY_CASH" } },
          { Description: { startsWith: "PAY_UTILITY" } },
          { Description: { startsWith: "PAY_SERVICE" } },
        ],
      },
    });
    const transactionCount = await prisma.Transactions.count({ where: { Transactions_date: { gte: since }, Entreprise_id: entrepriseId } });

    const sales = Number(salesAgg._sum.Debit || 0);
    const cogs = Number(cogsAgg._sum.Debit || 0);

    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
    const codes = await prisma.Account_codes.findMany({ where: { Entreprise_id: entrepriseId } });
    const codeById = Object.fromEntries(codes.map((c) => [c.Account_codes_id, c.Code]));

    const byAccount = {};
    for (const j of journal) {
      if (!byAccount[j.Account_id]) byAccount[j.Account_id] = { debit: 0, credit: 0 };
      byAccount[j.Account_id].debit += Number(j.Debit || 0);
      byAccount[j.Account_id].credit += Number(j.Credit || 0);
    }
    const trialBalance = accounts
      .filter((a) => byAccount[a.Account_id])
      .map((a) => ({
        code: a.Account_Code_id ? codeById[a.Account_Code_id] : null,
        accountName: a.Account_Name,
        debit: byAccount[a.Account_id].debit,
        credit: byAccount[a.Account_id].credit,
      }))
      .sort((x, y) => (x.code || "").localeCompare(y.code || ""));
    const trialBalanceTotals = trialBalance.reduce(
      (acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }),
      { debit: 0, credit: 0 }
    );

    const latestUnadjusted = await prisma.Reports.findFirst({
      where: { Report_Stage: "TRIAL_BALANCE_UNADJUSTED", Entreprise_id: entrepriseId },
      orderBy: { Reports_id: "desc" },
    });
    const latestAdjusted = await prisma.Reports.findFirst({
      where: { Report_Stage: "TRIAL_BALANCE_ADJUSTED", Entreprise_id: entrepriseId },
      orderBy: { Reports_id: "desc" },
    });
    const latestIncomeStatement = await prisma.Reports.findFirst({
      where: { Report_Stage: "INCOME_STATEMENT", Entreprise_id: entrepriseId },
      orderBy: { Reports_id: "desc" },
    });
    const latestBalanceSheet = await prisma.Reports.findFirst({
      where: { Report_Stage: "BALANCE_SHEET", Entreprise_id: entrepriseId },
      orderBy: { Reports_id: "desc" },
    });

    res.render("reports", {
      title: "Reports",
      active: "reports",
      todayLabel: todayLabel(),
      daily: { sales, cogs, grossProfit: sales - cogs, purchases: Number(purchasesAgg._sum.Debit || 0), transactionCount },
      trialBalance,
      trialBalanceTotals,
      latestUnadjusted,
      latestAdjusted,
      latestIncomeStatement,
      latestBalanceSheet,
      incomeStatementFigures: latestIncomeStatement ? await computeIncomeStatementForDisplay(entrepriseId) : null,
      balanceSheetFigures: latestBalanceSheet ? await computeBalanceSheetForDisplay(entrepriseId) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading reports: " + err.message);
  }
});

// Re-derive display figures for the most recently generated statements
// (kept separate from generation so viewing the page never re-writes Reports rows)
async function computeIncomeStatementForDisplay(entrepriseId) {
  const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
  const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
  const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));
  let income = 0, expenditure = 0, cogs = 0;
  for (const j of journal) {
    const acc = accountById[j.Account_id];
    if (!acc) continue;
    if (acc.Account_Type === "INCOME") income += Number(j.Credit || 0) - Number(j.Debit || 0);
    else if (acc.Account_Type === "EXPENDITURE") {
      const amt = Number(j.Debit || 0) - Number(j.Credit || 0);
      if (acc.Account_Name === "Cost of Goods Sold") cogs += amt; else expenditure += amt;
    }
  }
  return { income, expenditure, cogs, netProfit: income - cogs - expenditure };
}

async function computeBalanceSheetForDisplay(entrepriseId) {
  const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
  const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
  const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;
  const assetLines = [], liabilityLines = [], equityLines = [];
  const byAccount = {};
  for (const j of journal) {
    if (!byAccount[j.Account_id]) byAccount[j.Account_id] = { debit: 0, credit: 0 };
    byAccount[j.Account_id].debit += Number(j.Debit || 0);
    byAccount[j.Account_id].credit += Number(j.Credit || 0);
  }
  for (const [accountId, totals] of Object.entries(byAccount)) {
    const acc = accountById[accountId];
    if (!acc) continue;
    const netDebit = totals.debit - totals.credit;
    if (acc.Account_Type === "ASSET") { totalAssets += netDebit; assetLines.push({ name: acc.Account_Name, amount: netDebit }); }
    else if (acc.Account_Type === "LIABILITY") { const nc = totals.credit - totals.debit; totalLiabilities += nc; liabilityLines.push({ name: acc.Account_Name, amount: nc }); }
    else if (acc.Account_Type === "EQUITY") { const nc = totals.credit - totals.debit; totalEquity += nc; equityLines.push({ name: acc.Account_Name, amount: nc }); }
  }
  const income = await computeIncomeStatementForDisplay(entrepriseId);
  equityLines.push({ name: "Retained Earnings (current period)", amount: income.netProfit });
  totalEquity += income.netProfit;
  return { totalAssets, totalLiabilities, totalEquity, assetLines, liabilityLines, equityLines, balances: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01 };
}

router.post("/reports/generate/unadjusted-tb", async (req, res) => {
  try {
    await reporting.generateUnadjustedTrialBalance({ entrepriseId: req.currentUser.Entreprise_id });
    res.redirect("/reports");
  } catch (err) {
    console.error(err);
    res.status(400).send(err.message);
  }
});

router.post("/reports/generate/adjusted-tb", async (req, res) => {
  try {
    await reporting.generateAdjustedTrialBalance({ parentReportId: Number(req.body.parentReportId), entrepriseId: req.currentUser.Entreprise_id });
    res.redirect("/reports");
  } catch (err) {
    console.error(err);
    res.status(400).send(err.message);
  }
});

router.post("/reports/generate/income-statement", async (req, res) => {
  try {
    await reporting.generateIncomeStatement({ adjustedTrialBalanceReportId: Number(req.body.adjustedTrialBalanceReportId), entrepriseId: req.currentUser.Entreprise_id });
    res.redirect("/reports");
  } catch (err) {
    console.error(err);
    res.status(400).send(err.message);
  }
});

router.post("/reports/generate/balance-sheet", async (req, res) => {
  try {
    await reporting.generateBalanceSheet({ adjustedTrialBalanceReportId: Number(req.body.adjustedTrialBalanceReportId), entrepriseId: req.currentUser.Entreprise_id });
    res.redirect("/reports");
  } catch (err) {
    console.error(err);
    res.status(400).send(err.message);
  }
});

module.exports = router;
