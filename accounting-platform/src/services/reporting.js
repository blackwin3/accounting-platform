const { prisma } = require("./postingEngine");

/**
 * generateUnadjustedTrialBalance — snapshots current Journal totals per
 * account into a Reports row with Report_Stage=TRIAL_BALANCE_UNADJUSTED,
 * Is_Adjusted=0. This is always safe to generate — it's just a read of
 * the current ledger state.
 */
async function generateUnadjustedTrialBalance({ periodId = null, administrationId = null, entrepriseId } = {}) {
  if (!entrepriseId) throw new ReportingError("entrepriseId is required — every report belongs to a specific business.");
  const journalWhere = periodId ? { Period_id: periodId, Entreprise_id: entrepriseId } : { Entreprise_id: entrepriseId };
  const journal = await prisma.Journal.findMany({ where: journalWhere });

  const totalDebit = journal.reduce((sum, j) => sum + Number(j.Debit || 0), 0);
  const totalCredit = journal.reduce((sum, j) => sum + Number(j.Credit || 0), 0);

  const report = await prisma.Reports.create({
    data: {
      Reports_type: "Trial Balance",
      Report_category: "ACCOUNTING",
      Reports_period: new Date(),
      Reports_NetValue: round2(totalDebit - totalCredit),
      Report_Stage: "TRIAL_BALANCE_UNADJUSTED",
      Report_Status: "DRAFT",
      Is_Adjusted: 0,
      Report_basis: "CASH",
      Parent_Report_id: null,
      Adjustment_count: 0,
      Entreprise_id: entrepriseId,
    },
  });

  return { report, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) };
}

/**
 * generateAdjustedTrialBalance — marks a given unadjusted TB report as the
 * parent of a new adjusted TB. adjustmentCount defaults to 0 (no adjusting
 * entries posted yet, which is honest for a fresh system) — the accountant
 * is expected to post real adjusting Journal entries (depreciation, accruals,
 * prepayments) before calling this once those exist.
 */
async function generateAdjustedTrialBalance({ parentReportId, adjustmentCount = 0, entrepriseId }) {
  if (!entrepriseId) throw new ReportingError("entrepriseId is required — every report belongs to a specific business.");
  const parent = await prisma.Reports.findUnique({ where: { Reports_id: parentReportId } });
  if (!parent || parent.Entreprise_id !== entrepriseId) throw new ReportingError("Parent unadjusted trial balance not found.");
  if (parent.Report_Stage !== "TRIAL_BALANCE_UNADJUSTED") {
    throw new ReportingError("Parent report must be an unadjusted trial balance.");
  }

  const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
  const totalDebit = journal.reduce((sum, j) => sum + Number(j.Debit || 0), 0);
  const totalCredit = journal.reduce((sum, j) => sum + Number(j.Credit || 0), 0);

  const report = await prisma.Reports.create({
    data: {
      Reports_type: "Trial Balance",
      Report_category: "ACCOUNTING",
      Reports_period: new Date(),
      Reports_NetValue: round2(totalDebit - totalCredit),
      Report_Stage: "TRIAL_BALANCE_ADJUSTED",
      Report_Status: "DRAFT",
      Is_Adjusted: 1,
      Report_basis: "CASH",
      Parent_Report_id: parent.Reports_id,
      Adjustment_count: adjustmentCount,
      Entreprise_id: entrepriseId,
    },
  });

  return { report, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) };
}

/**
 * generateIncomeStatement — Profit & Loss. Requires an adjusted trial
 * balance as parent.
 */
async function generateIncomeStatement({ adjustedTrialBalanceReportId, entrepriseId }) {
  if (!entrepriseId) throw new ReportingError("entrepriseId is required — every report belongs to a specific business.");
  const parent = await requireAdjustedParent(adjustedTrialBalanceReportId, entrepriseId);

  const { income, expenditure, cogs, netProfit } = await computeIncomeStatementFigures(entrepriseId);

  const report = await prisma.Reports.create({
    data: {
      Reports_type: "Income Statement",
      Report_category: "ACCOUNTING",
      Reports_period: new Date(),
      Net_Profit: round2(netProfit),
      Report_Stage: "INCOME_STATEMENT",
      Report_Status: "DRAFT",
      Is_Adjusted: 1,
      Report_basis: "CASH",
      Parent_Report_id: parent.Reports_id,
      Entreprise_id: entrepriseId,
    },
  });

  return { report, income, expenditure, cogs, netProfit: round2(netProfit) };
}

/**
 * generateBalanceSheet — Assets = Liabilities + Equity, as of now.
 */
async function generateBalanceSheet({ adjustedTrialBalanceReportId, entrepriseId }) {
  if (!entrepriseId) throw new ReportingError("entrepriseId is required — every report belongs to a specific business.");
  const parent = await requireAdjustedParent(adjustedTrialBalanceReportId, entrepriseId);

  const figures = await computeBalanceSheetFigures(entrepriseId);

  const report = await prisma.Reports.create({
    data: {
      Reports_type: "Balance Sheet",
      Report_category: "ACCOUNTING",
      Reports_period: new Date(),
      Reports_NetValue: round2(figures.totalAssets),
      Report_Stage: "BALANCE_SHEET",
      Report_Status: "DRAFT",
      Is_Adjusted: 1,
      Report_basis: "CASH",
      Parent_Report_id: parent.Reports_id,
      Entreprise_id: entrepriseId,
    },
  });

  return { report, ...figures };
}

async function requireAdjustedParent(reportId, entrepriseId) {
  const parent = await prisma.Reports.findUnique({ where: { Reports_id: reportId } });
  if (!parent || parent.Entreprise_id !== entrepriseId) throw new ReportingError("Referenced trial balance report not found.");
  if (!parent.Is_Adjusted || parent.Report_Stage !== "TRIAL_BALANCE_ADJUSTED") {
    throw new ReportingError(
      "Financial statements can only be generated from an ADJUSTED trial balance. Generate and adjust the trial balance first."
    );
  }
  return parent;
}

async function computeIncomeStatementFigures(entrepriseId) {
  const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
  const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
  const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));

  let income = 0;
  let expenditure = 0;
  let cogs = 0;

  for (const j of journal) {
    const acc = accountById[j.Account_id];
    if (!acc) continue;
    if (acc.Account_Type === "INCOME") {
      income += Number(j.Credit || 0) - Number(j.Debit || 0);
    } else if (acc.Account_Type === "EXPENDITURE") {
      const amount = Number(j.Debit || 0) - Number(j.Credit || 0);
      if (acc.Account_Name === "Cost of Goods Sold") {
        cogs += amount;
      } else {
        expenditure += amount;
      }
    }
  }

  const netProfit = income - cogs - expenditure;
  return { income: round2(income), expenditure: round2(expenditure), cogs: round2(cogs), netProfit: round2(netProfit) };
}

async function computeBalanceSheetFigures(entrepriseId) {
  const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
  const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
  const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));

  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  const assetLines = [];
  const liabilityLines = [];
  const equityLines = [];

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
    if (acc.Account_Type === "ASSET") {
      totalAssets += netDebit;
      assetLines.push({ name: acc.Account_Name, amount: round2(netDebit) });
    } else if (acc.Account_Type === "LIABILITY") {
      const netCredit = totals.credit - totals.debit;
      totalLiabilities += netCredit;
      liabilityLines.push({ name: acc.Account_Name, amount: round2(netCredit) });
    } else if (acc.Account_Type === "EQUITY") {
      const netCredit = totals.credit - totals.debit;
      totalEquity += netCredit;
      equityLines.push({ name: acc.Account_Name, amount: round2(netCredit) });
    }
  }

  const { netProfit } = await computeIncomeStatementFigures(entrepriseId);
  equityLines.push({ name: "Retained Earnings (current period)", amount: round2(netProfit) });
  totalEquity += netProfit;

  return {
    totalAssets: round2(totalAssets),
    totalLiabilities: round2(totalLiabilities),
    totalEquity: round2(totalEquity),
    assetLines,
    liabilityLines,
    equityLines,
    balances: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

class ReportingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportingError";
  }
}

module.exports = {
  generateUnadjustedTrialBalance,
  generateAdjustedTrialBalance,
  generateIncomeStatement,
  generateBalanceSheet,
  ReportingError,
};
