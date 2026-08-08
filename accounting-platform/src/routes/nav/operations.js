const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");
const { getAlerts } = require("../../services/alerts");
const { BUSINESS_NAME, todayLabel, startOfToday } = require("./navShared");

function round2(n) {
  return Math.round(n * 100) / 100;
}

// POST /switch-unit — change the active Business Unit for this session
router.post("/switch-unit", async (req, res) => {
  const { unit } = req.body;
  const entrepriseId = req.currentUser.Entreprise_id;
  const valid = await prisma.Structures.findFirst({ where: { Structures_Type: "BUSINESS_UNIT", Structures_Name: unit, Entreprise_id: entrepriseId } });
  if (valid) {
    req.session.businessUnit = unit;
  }
  res.redirect(req.get("Referer") || "/dashboard");
});

// GET /dashboard — homepage with today's snapshot + navigation
router.get("/dashboard", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const since = startOfToday();

    const [salesToday, purchasesToday, cashJournalRows, openPeriod, productCount, accountCount] = await Promise.all([
      prisma.Journal.aggregate({
        _sum: { Debit: true },
        where: { Created_at: { gte: since }, Description: { startsWith: "SELL_GOODS_CASH" }, Entreprise_id: entrepriseId },
      }),
      prisma.Journal.aggregate({
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
      }),
      // Cash balance is computed live from Journal, the same correct
      // pattern already used on the Money page — Account.Current_Balance
      // is set to 0 when an account is first created and never updated by
      // any posting function, so reading it directly would always show 0
      // regardless of real Till activity.
      resolveCashJournalRows(entrepriseId),
      prisma.Structures.findFirst({ where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId } }),
      prisma.Product.count({ where: { Entreprise_id: entrepriseId } }),
      prisma.Account.count({ where: { Entreprise_id: entrepriseId } }),
    ]);

    const saleCount = await prisma.Journal.count({
      where: { Created_at: { gte: since }, Description: { startsWith: "SELL_GOODS_CASH" }, Entreprise_id: entrepriseId },
    });
    const purchaseCount = await prisma.Journal.count({
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

    const cashBalance = cashJournalRows.reduce((sum, j) => sum + (Number(j.Debit || 0) - Number(j.Credit || 0)), 0);
    const alerts = await getAlerts(entrepriseId);

    res.render("home", {
      title: "Home",
      active: "home",
      businessName: BUSINESS_NAME,
      todayLabel: todayLabel(),
      alertCount: alerts.length,
      snapshot: {
        salesToday: Number(salesToday._sum.Debit || 0),
        purchasesToday: Number(purchasesToday._sum.Debit || 0),
        saleCount,
        purchaseCount,
        cashBalance,
        openPeriodName: openPeriod ? openPeriod.Period_name || openPeriod.Structures_Name : null,
        productCount,
        accountCount,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading dashboard: " + err.message);
  }
});

// GET /products
router.get("/products", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });
    const productIds = products.map((p) => p.Product_id);
    const resources = await prisma.Resources.findMany({ where: { Product_id: { in: productIds } } });
    const stockByProduct = Object.fromEntries(resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)]));

    res.render("products", {
      title: "Products",
      active: "products",
      currentBusinessUnit: req.currentBusinessUnit,
      products: products.map((p) => ({
        name: p.Product_Name,
        type: p.Product_type,
        isUtility: !!p.Is_Utility,
        billingCycle: p.Billing_Cycle,
        stock: stockByProduct[p.Product_id] ?? 0,
        price: Number(p.Product_Price || 0),
        cost: Number(p.Product_Cost || 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading products: " + err.message);
  }
});

// GET /journal — company-wide chronological book of original entry
router.get("/journal", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const journal = await prisma.Journal.findMany({
      where: { Entreprise_id: entrepriseId },
      orderBy: { Journal_id: "desc" },
      take: 150,
    });
    const txnIds = [...new Set(journal.map((j) => j.Transactions_id).filter(Boolean))];
    const transactions = await prisma.Transactions.findMany({ where: { Transactions_id: { in: txnIds } } });
    const unitByTxnId = Object.fromEntries(transactions.map((t) => [t.Transactions_id, t.Business_Unit]));

    const accountIds = [...new Set(journal.map((j) => j.Account_id))];
    const accounts = await prisma.Account.findMany({ where: { Account_id: { in: accountIds } } });
    const accountNameById = Object.fromEntries(accounts.map((a) => [a.Account_id, a.Account_Name]));

    const entries = journal.map((j) => ({
      date: j.Created_at ? new Date(j.Created_at).toLocaleString("en-GB") : "",
      unit: j.Transactions_id ? unitByTxnId[j.Transactions_id] : null,
      accountName: accountNameById[j.Account_id] || `Account #${j.Account_id}`,
      description: j.Description || "",
      debit: Number(j.Debit || 0),
      credit: Number(j.Credit || 0),
    }));

    const totals = entries.reduce(
      (acc, e) => ({ debit: acc.debit + e.debit, credit: acc.credit + e.credit }),
      { debit: 0, credit: 0 }
    );

    res.render("journal", { title: "Journal", active: "journal", entries, totals });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading journal: " + err.message);
  }
});

// GET /ledger — journal entries regrouped by account with running balances
router.get("/ledger", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Journal_id: "asc" } }); // oldest first, to compute running balance in order
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Account_id: "asc" } });
    const codes = await prisma.Account_codes.findMany({ where: { Entreprise_id: entrepriseId } });
    const codeById = Object.fromEntries(codes.map((c) => [c.Account_codes_id, c.Code]));

    const entriesByAccount = {};
    for (const j of journal) {
      if (!entriesByAccount[j.Account_id]) entriesByAccount[j.Account_id] = [];
      entriesByAccount[j.Account_id].push(j);
    }

    const accountsWithLedger = accounts
      .filter((a) => entriesByAccount[a.Account_id])
      .map((a) => {
        const normalDebit = a.Normal_Balance === "DEBIT";
        let running = 0;
        const entries = entriesByAccount[a.Account_id].map((j) => {
          const debit = Number(j.Debit || 0);
          const credit = Number(j.Credit || 0);
          running += normalDebit ? debit - credit : credit - debit;
          return {
            date: j.Created_at ? new Date(j.Created_at).toLocaleDateString("en-GB") : "",
            description: j.Description || "",
            debit,
            credit,
            runningBalance: running,
          };
        });
        return {
          name: a.Account_Name,
          code: a.Account_Code_id ? codeById[a.Account_Code_id] : null,
          type: a.Account_Type,
          balance: running,
          entries: entries.reverse(), // show most recent first, running balance already computed chronologically
        };
      });

    res.render("ledger", { title: "Ledger", active: "ledger", accounts: accountsWithLedger });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading ledger: " + err.message);
  }
});

// GET /transactions
router.get("/transactions", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitTransactions = await prisma.Transactions.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Transactions_id: true },
    });
    const unitTxnIds = unitTransactions.map((t) => t.Transactions_id);

    const journal = await prisma.Journal.findMany({
      where: { Transactions_id: { in: unitTxnIds } },
      orderBy: { Journal_id: "desc" },
      take: 100,
    });
    const accountIds = [...new Set(journal.map((j) => j.Account_id))];
    const accounts = await prisma.Account.findMany({ where: { Account_id: { in: accountIds } } });
    const accountNameById = Object.fromEntries(accounts.map((a) => [a.Account_id, a.Account_Name]));

    const unitTransactionRows = await prisma.Transactions.findMany({ where: { Transactions_id: { in: unitTxnIds } } });
    const recordsIdByTxnId = Object.fromEntries(unitTransactionRows.map((t) => [t.Transactions_id, t.Records_id]));

    const entries = journal.map((j) => ({
      journalId: j.Journal_id,
      transactionId: j.Transactions_id,
      recordsId: j.Transactions_id ? recordsIdByTxnId[j.Transactions_id] : null,
      date: j.Created_at ? new Date(j.Created_at).toLocaleString("en-GB") : "",
      accountName: accountNameById[j.Account_id] || `Account #${j.Account_id}`,
      description: j.Description || "",
      debit: Number(j.Debit || 0),
      credit: Number(j.Credit || 0),
      correctionStatus: j.Correction_Status || "ORIGINAL",
    }));

    const totals = entries.reduce(
      (acc, e) => ({ debit: acc.debit + e.debit, credit: acc.credit + e.credit }),
      { debit: 0, credit: 0 }
    );

    // Chart data: daily Fixed vs Variable expense, and daily net cash
    // movement — "the effects of transactions over time" the diagram is
    // meant to show. Classified directly from Journal account names, not
    // from Expenditure.Expenditure_Behaviour — the real reason the chart
    // showed 0.0 for everything: only the standalone Expenses page
    // (postExpense) ever creates an Expenditure row, but Utilities,
    // Services/Labour, and Discounts posted through the Till never touch
    // that table at all, so for a business whose costs mostly flow
    // through the Till, Expenditure was always empty. Journal is the one
    // source every posting function actually writes to.
    const FIXED_COST_ACCOUNTS = ["Rent Expense", "Salaries and Wages", "Insurance Premium", "Depreciation Expense"];
    const VARIABLE_COST_ACCOUNTS = [
      "Cost of Goods Sold", "Utilities", "Transport and Maintenance", "Tax Expense",
      "Service Expense", "Discount Allowed", "Discount Received", "Spoilage and Wastage Expense",
    ];
    const dailyCostByDate = {};
    for (const j of journal) {
      const accName = accountNameById[j.Account_id];
      const debit = Number(j.Debit || 0);
      if (debit <= 0) continue; // only the debit (expense-incurred) leg counts as a cost, never the credit leg
      if (!FIXED_COST_ACCOUNTS.includes(accName) && !VARIABLE_COST_ACCOUNTS.includes(accName)) continue;
      if (!j.Created_at) continue;
      const dateKey = new Date(j.Created_at).toISOString().slice(0, 10);
      if (!dailyCostByDate[dateKey]) dailyCostByDate[dateKey] = { fixed: 0, variable: 0, mixed: 0 };
      if (FIXED_COST_ACCOUNTS.includes(accName)) dailyCostByDate[dateKey].fixed += debit;
      else dailyCostByDate[dateKey].variable += debit;
    }

    const CASH_ACCOUNT_NAMES = ["Cash / Till", "Mobile Money", "Bank"];
    const dailyNetCashByDate = {};
    for (const j of journal) {
      const accName = accountNameById[j.Account_id];
      if (!CASH_ACCOUNT_NAMES.includes(accName)) continue;
      if (!j.Created_at) continue;
      const dateKey = new Date(j.Created_at).toISOString().slice(0, 10);
      dailyNetCashByDate[dateKey] = (dailyNetCashByDate[dateKey] || 0) + Number(j.Debit || 0) - Number(j.Credit || 0);
    }

    const allDates = [...new Set([...Object.keys(dailyCostByDate), ...Object.keys(dailyNetCashByDate)])].sort();
    const chartData = allDates.map((date) => ({
      date,
      fixed: round2(dailyCostByDate[date]?.fixed || 0),
      variable: round2(dailyCostByDate[date]?.variable || 0),
      mixed: round2(dailyCostByDate[date]?.mixed || 0),
      netCash: round2(dailyNetCashByDate[date] || 0),
    }));

    res.render("transactions", { title: "Transactions", active: "transactions", entries, totals, currentBusinessUnit: req.currentBusinessUnit, chartData });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading transactions: " + err.message);
  }
});

// GET /accounts
router.get("/accounts", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Account_id: "asc" } });
    const codes = await prisma.Account_codes.findMany({ where: { Entreprise_id: entrepriseId } });
    const codeById = Object.fromEntries(codes.map((c) => [c.Account_codes_id, c]));

    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
    const totalsByAccount = {};
    for (const j of journal) {
      if (!totalsByAccount[j.Account_id]) totalsByAccount[j.Account_id] = { debit: 0, credit: 0 };
      totalsByAccount[j.Account_id].debit += Number(j.Debit || 0);
      totalsByAccount[j.Account_id].credit += Number(j.Credit || 0);
    }

    res.render("accounts", {
      title: "Accounts",
      active: "accounts",
      accounts: accounts.map((a) => {
        const codeRow = a.Account_Code_id ? codeById[a.Account_Code_id] : null;
        const totals = totalsByAccount[a.Account_id] || { debit: 0, credit: 0 };
        const balance = a.Normal_Balance === "CREDIT" ? totals.credit - totals.debit : totals.debit - totals.credit;
        return {
          code: codeRow ? codeRow.Code : null,
          name: a.Account_Name,
          type: a.Account_Type,
          statementSection: codeRow ? codeRow.Statement_Section : null,
          balance,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading accounts: " + err.message);
  }
});

// resolveCashJournalRows — every Journal row posted against a cash-
// equivalent account (Cash/Till, Mobile Money, Bank) for this business.
// Summing Debit-Credit across these rows gives the true current cash
// balance, computed live rather than trusted from a stored field.
async function resolveCashJournalRows(entrepriseId) {
  const cashAccounts = await prisma.Account.findMany({
    where: { Account_Name: { in: ["Cash / Till", "Mobile Money", "Bank"] }, Entreprise_id: entrepriseId },
  });
  const accountIds = cashAccounts.map((a) => a.Account_id);
  if (accountIds.length === 0) return [];
  return prisma.Journal.findMany({ where: { Account_id: { in: accountIds }, Entreprise_id: entrepriseId } });
}

module.exports = router;
