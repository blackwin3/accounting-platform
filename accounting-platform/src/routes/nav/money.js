const express = require("express");
const router = express.Router();
const { prisma, computeIndirectCashFlow } = require("../../services/postingEngine");

function round2(n) {
  return Math.round(n * 100) / 100;
}

// GET /money — the Money group dashboard (the accounting equation at work)
router.get("/money", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
    const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));

    const CASH_EQUIVALENT_NAMES = ["Cash / Till", "Mobile Money", "Bank"];

    let cashBalance = 0;
    let fixedAssetsBalance = 0;
    let capitalBalance = 0;
    let retainedEarnings = 0;
    let loanBalance = 0;
    let otherLiabilitiesBalance = 0;
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
      const netCredit = totals.credit - totals.debit;

      if (CASH_EQUIVALENT_NAMES.includes(acc.Account_Name)) {
        cashBalance += netDebit;
      } else if (acc.Account_Type === "ASSET") {
        fixedAssetsBalance += netDebit;
      } else if (acc.Account_Type === "EQUITY") {
        if (acc.Account_Name === "Owner Capital") capitalBalance += netCredit;
        else retainedEarnings += netCredit;
      } else if (acc.Account_Type === "LIABILITY") {
        if (acc.Account_Name === "Loan Payable") loanBalance += netCredit;
        else otherLiabilitiesBalance += netCredit;
      } else if (acc.Account_Type === "INCOME") {
        retainedEarnings += netCredit;
      } else if (acc.Account_Type === "EXPENDITURE") {
        retainedEarnings -= netDebit;
      }
    }

    const totalAssets = cashBalance + fixedAssetsBalance;
    const totalEquity = capitalBalance + retainedEarnings;
    const totalLiabilities = loanBalance + otherLiabilitiesBalance;

    res.render("money", {
      title: "Money",
      active: "money",
      currentBusinessUnit: req.currentBusinessUnit,
      cashBalance,
      fixedAssetsBalance,
      capitalBalance,
      retainedEarnings,
      loanBalance,
      otherLiabilitiesBalance,
      totalAssets,
      totalEquity,
      totalLiabilities,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading money dashboard: " + err.message);
  }
});

// GET /money/cash-flow
router.get("/money/cash-flow", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    // Fixed: this route was pulling every Journal row for the whole
    // business regardless of which unit was currently selected, silently
    // aggregating every business unit together — while the page itself
    // displayed a single unit's context. Journal has no Business_Unit
    // column of its own; scoped through Transactions.Business_Unit, the
    // same pattern already used correctly on /transactions and /expense.
    const unitTransactions = await prisma.Transactions.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Transactions_id: true },
    });
    const unitTxnIds = unitTransactions.map((t) => t.Transactions_id);
    const journal = await prisma.Journal.findMany({ where: { Transactions_id: { in: unitTxnIds } } });
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
    const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));

    const METHOD_BY_ACCOUNT_NAME = { "Cash / Till": "CASH", "Mobile Money": "MOBILE", "Bank": "BANK" };

    const byMethod = { CASH: 0, MOBILE: 0, BANK: 0 };
    let cashIn = 0;
    let cashOut = 0;
    let receivables = 0;
    let payables = 0;

    // Direct Method line items — genuinely distinct cash flows, not a
    // single lumped "expenses" figure. Salaries is split out as "paid to
    // employees" specifically; Tax gets its own line since it's a real,
    // separately-categorised expense in this system. Interest paid is
    // deliberately not shown as its own line: no posting function in this
    // engine currently records loan interest as a distinct expense (see
    // the honestly-documented "Loan Amortization Discipline" gap on the
    // Rules page) — showing a line that's always zero would misrepresent
    // that as a real, checked figure rather than an unbuilt one.
    let customersIn = 0, receivableSettlementsIn = 0, unitIncomeIn = 0;
    let suppliersOut = 0, payableSettlementsOut = 0, employeesOut = 0, otherOperatingOut = 0, taxOut = 0;
    let discountAllowedOut = 0, discountReceivedIn = 0; // shown as their own lines, not just folded silently into customer/supplier totals

    // Investing and Financing — identical under both methods, computed
    // once here and shown once on the page, exactly as real cash flow
    // statements present them.
    let assetPurchasesOut = 0, assetDisposalsIn = 0, investmentPurchasesOut = 0, investmentSalesIn = 0;
    let capitalIn = 0, loansIn = 0;

    for (const j of journal) {
      const acc = accountById[j.Account_id];
      if (!acc) continue;

      if (acc.Account_Name === "Trade Receivables") receivables += Number(j.Debit || 0) - Number(j.Credit || 0);
      if (acc.Account_Name === "Trade Payables") payables += Number(j.Credit || 0) - Number(j.Debit || 0);

      const method = METHOD_BY_ACCOUNT_NAME[acc.Account_Name];
      if (!method) continue;

      const debit = Number(j.Debit || 0);
      const credit = Number(j.Credit || 0);
      const net = debit - credit;

      byMethod[method] += net;
      if (net > 0) cashIn += net; else cashOut += -net;

      const desc = j.Description || "";
      // Operating — cash received from customers (a direct cash sale, or
      // a customer paying down an earlier credit sale — both are real
      // cash received from customers, just at different moments).
      if (desc.startsWith("SELL GOODS") || desc.startsWith("SELL SERVICE") || desc.startsWith("SELL UTILITY")) customersIn += debit;
      else if (desc.startsWith("SETTLE_RECEIVABLE")) receivableSettlementsIn += debit;
      else if (desc.startsWith("RECEIVE_")) unitIncomeIn += debit;
      // Operating — cash paid to suppliers (inventory, or settling an
      // earlier credit purchase) and to employees (salaries, tracked
      // separately per the requested line-item structure).
      else if (desc.startsWith("BUY INVENTORY")) suppliersOut += credit;
      else if (desc.startsWith("SETTLE_PAYABLE")) payableSettlementsOut += credit;
      else if (desc.startsWith("PAY_EXPENSE_SALARIES")) employeesOut += credit;
      else if (desc.startsWith("PAY_EXPENSE_TAX")) taxOut += credit;
      else if (desc.startsWith("PAY_EXPENSE_") || desc.startsWith("PAY UTILITY") || desc.startsWith("PAY SERVICE")) otherOperatingOut += credit;
      // A discount touches a cash-equivalent account directly (DR Discount
      // Allowed CR Cash/Mobile/Bank/Receivable for a sale-side discount,
      // reversed for a purchase-side one) — genuinely reduces what's
      // collected from or paid to the counterparty, not a separate line
      // in the requested structure, so it's folded into the customer/
      // supplier cash figures it actually affects rather than silently
      // uncaptured (which is what was causing Direct and Indirect to
      // disagree — Indirect's Net Income already reflected the discount
      // via the Discount Allowed/Received expense account; Direct simply
      // never counted its matching cash-equivalent leg at all before this
      // fix).
      else if (desc.startsWith("DISCOUNT ALLOWED")) { customersIn -= credit; discountAllowedOut += credit; }
      else if (desc.startsWith("DISCOUNT RECEIVED")) { suppliersOut -= debit; discountReceivedIn += debit; }
      // A partial-credit split moves part of an already-recorded sale
      // into Trade Receivable/Payable — less cash was actually retained
      // than the basket's face value, so it reduces the customer/supplier
      // cash figure the same way a discount does, for the same reason
      // (both are corrections to how much of a sale was genuinely cash).
      else if (desc.startsWith("PARTIAL_CREDIT_SALE")) customersIn -= credit;
      else if (desc.startsWith("PARTIAL_CREDIT_PURCHASE")) suppliersOut -= debit;
      // Investing — identical under both methods.
      else if (desc.startsWith("PURCHASE_FIXED_ASSET")) assetPurchasesOut += credit;
      else if (desc.startsWith("DISPOSE_FIXED_ASSET")) assetDisposalsIn += debit;
      else if (desc.startsWith("PURCHASE INVESTMENT")) investmentPurchasesOut += credit;
      else if (desc.startsWith("SELL INVESTMENT")) investmentSalesIn += debit;
      // Financing — identical under both methods.
      else if (desc.startsWith("OWNER_CAPITAL_INJECTION")) capitalIn += debit;
      else if (desc.startsWith("LOAN_DRAWDOWN")) loansIn += debit;
      // A pure internal transfer between the business's own cash-
      // equivalent accounts (Cash/Mobile/Bank) — genuinely nets to zero
      // for the business as a whole and belongs in none of the three
      // activity sections, the same way it was already correctly excluded
      // from Net Profit (it never touches an INCOME/EXPENDITURE account).
      // Deliberately matched last and does nothing, purely so it doesn't
      // fall through to the "else" branch below and appear as a genuine
      // classification gap in server logs.
      else if (desc.startsWith("FUND_TRANSFER")) { /* intentionally excluded from all three activities */ }
    }

    const totalAvailable = byMethod.CASH + byMethod.MOBILE + byMethod.BANK;

    // Direct Method — Operating section, the exact line items requested.
    const directOperatingIn = {
      customers: customersIn,
      receivableSettlements: receivableSettlementsIn,
      unitIncome: unitIncomeIn,
      discountAllowed: discountAllowedOut,
      total: customersIn + receivableSettlementsIn + unitIncomeIn,
    };
    const directOperatingOut = {
      suppliers: suppliersOut,
      payableSettlements: payableSettlementsOut,
      employees: employeesOut,
      otherOperating: otherOperatingOut,
      tax: taxOut,
      discountReceived: discountReceivedIn,
      total: suppliersOut + payableSettlementsOut + employeesOut + otherOperatingOut + taxOut,
    };
    const directOperatingNet = round2(directOperatingIn.total - directOperatingOut.total);

    // Investing and Financing — identical under both methods, shown once.
    const investingDetail = {
      assetPurchases: assetPurchasesOut,
      assetDisposals: assetDisposalsIn,
      investmentPurchases: investmentPurchasesOut,
      investmentSales: investmentSalesIn,
      net: round2(assetDisposalsIn + investmentSalesIn - assetPurchasesOut - investmentPurchasesOut),
    };
    const financingDetail = {
      capital: capitalIn,
      loans: loansIn,
      net: round2(capitalIn + loansIn),
    };

    // Indirect method: a genuinely separate replay of the same Journal
    // history, starting from accrual Net Profit and reconciling to cash
    // via non-cash add-backs and working-capital changes, rather than
    // summing cash-equivalent Journal rows directly the way the direct
    // method above does. Handed the direct method's own operating total
    // (directOperatingNet, built from the exact line items now shown) so
    // the two can be shown to agree — or flagged if they don't, which
    // would mean a real data problem rather than either method being
    // wrong on its own terms.
    const indirect = await computeIndirectCashFlow(entrepriseId, directOperatingNet, req.currentBusinessUnit);

    // Bottom of the statement — the same close-out every real cash flow
    // statement ends with. This system doesn't track discrete reporting
    // periods for cash flow (it's a to-date view, not month-by-month), so
    // "Beginning Cash" is derived as Ending Cash minus the Net Change
    // rather than read from a stored prior-period balance — Ending Cash
    // is the one figure genuinely independently known (today's real
    // Cash/Mobile/Bank total), so it anchors the other end of the
    // equation rather than the other way around.
    const endingCash = round2(totalAvailable);
    const netChangeInCash = round2(directOperatingNet + investingDetail.net + financingDetail.net);
    const beginningCash = round2(endingCash - netChangeInCash);

    res.render("cash-flow", {
      title: "Cash Flow",
      active: "money-cash-flow",
      currentBusinessUnit: req.currentBusinessUnit,
      byMethod,
      totalAvailable,
      cashIn,
      cashOut,
      receivables,
      payables,
      indirect,
      directOperatingIn,
      directOperatingOut,
      directOperatingNet,
      investingDetail,
      financingDetail,
      beginningCash,
      netChangeInCash,
      endingCash,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading cash flow: " + err.message);
  }
});

// GET /money/funds
router.get("/money/funds", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    let tenants = [];
    let instruments = [];

    if (req.currentBusinessUnit === "RENTAL") {
      const rows = await prisma.Stakeholder.findMany({
        where: { Stakeholder_Role: "Tenant", Entreprise_id: entrepriseId },
        orderBy: { Business_name: "asc" },
      });
      tenants = rows.map((s) => ({ id: s.Stakeholder_id, name: s.Business_name }));
    } else if (req.currentBusinessUnit === "INVESTMENTS") {
      const rows = await prisma.Money.findMany({
        where: { Instrument_type: "MONEY_MARKET", Entreprise_id: entrepriseId },
        orderBy: { Money_id: "asc" },
      });
      instruments = rows.map((m) => ({
        id: m.Money_id,
        name: m.Money_Name,
        type: m.Instrument_Class,
        rate: m.Interest_rate ? Number(m.Interest_rate) : null,
        principal: Number(m.Principal_amount || 0),
      }));
    }

    const cashCodes = await prisma.Account_codes.findMany({
      where: { Code: { in: ["1000", "1010", "1020"] }, Entreprise_id: entrepriseId },
    });
    const cashAccounts = await prisma.Account.findMany({
      where: { Account_Code_id: { in: cashCodes.map((c) => c.Account_codes_id) }, Entreprise_id: entrepriseId },
    });
    const codeByAccountCodeId = Object.fromEntries(cashCodes.map((c) => [c.Account_codes_id, c.Code]));
    const cashAccountIds = cashAccounts.map((a) => a.Account_id);
    const cashJournal = await prisma.Journal.findMany({ where: { Account_id: { in: cashAccountIds } } });
    const journalTotalsByAccount = {};
    for (const j of cashJournal) {
      if (!journalTotalsByAccount[j.Account_id]) journalTotalsByAccount[j.Account_id] = { debit: 0, credit: 0 };
      journalTotalsByAccount[j.Account_id].debit += Number(j.Debit || 0);
      journalTotalsByAccount[j.Account_id].credit += Number(j.Credit || 0);
    }
    const cashBalances = { CASH: 0, MOBILE: 0, BANK: 0 };
    const methodByCode = { "1000": "CASH", "1010": "MOBILE", "1020": "BANK" };
    for (const acc of cashAccounts) {
      const code = codeByAccountCodeId[acc.Account_Code_id];
      const method = methodByCode[code];
      if (!method) continue;
      const totals = journalTotalsByAccount[acc.Account_id] || { debit: 0, credit: 0 };
      cashBalances[method] = totals.debit - totals.credit;
    }

    res.render("funds", {
      title: "Funds",
      active: "money-funds",
      currentBusinessUnit: req.currentBusinessUnit,
      tenants,
      instruments,
      cashBalances,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading funds page: " + err.message);
  }
});

// GET /money/investments
router.get("/money/investments", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;

    const activeHoldings = await prisma.Money.findMany({
      where: { Instrument_type: "MONEY_MARKET", Money_Status: "ACTIVE", Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
    });
    const closedHoldings = await prisma.Money.findMany({
      where: { Instrument_type: "MONEY_MARKET", Money_Status: { not: "ACTIVE" }, Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
      take: 20,
    });

    const investmentProducts = await prisma.Product.findMany({
      where: { Product_type: "Investment", Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });

    const totalHeld = activeHoldings.reduce((sum, m) => sum + Number(m.Principal_amount || 0), 0);

    res.render("investments", {
      title: "Investments",
      active: "money-investments",
      currentBusinessUnit: req.currentBusinessUnit,
      activeHoldings: activeHoldings.map((m) => ({
        id: m.Money_id,
        name: m.Money_Name,
        instrumentClass: m.Instrument_Class,
        principal: Number(m.Principal_amount || 0),
        interestRate: m.Interest_rate ? Number(m.Interest_rate) : null,
        startDate: m.Start_date ? new Date(m.Start_date).toLocaleDateString("en-GB") : "—",
        maturityDate: m.Maturity_date ? new Date(m.Maturity_date).toLocaleDateString("en-GB") : "—",
      })),
      closedHoldings: closedHoldings.map((m) => ({
        id: m.Money_id,
        name: m.Money_Name,
        principal: Number(m.Principal_amount || 0),
        status: m.Money_Status,
      })),
      investmentProducts: investmentProducts.map((p) => ({ id: p.Product_id, name: p.Product_Name, rate: p.Product_Rate ? Number(p.Product_Rate) : null })),
      totalHeld,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading investments page: " + err.message);
  }
});

module.exports = router;
