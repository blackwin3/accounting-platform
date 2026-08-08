/**
 * replay.js — event replay: rebuilding derived state purely from the
 * transactional record, rather than trusting any stored running total.
 *
 * The review's claim is largely true but needs one honest correction:
 * Account balances genuinely are fully derivable from Journal alone —
 * this system already relies on that (computeAccountBalance in core.js,
 * and every balance shown on the Ledger/Accounts/Money pages, are all
 * computed live from Journal, never from a stored total). But physical
 * stock quantities (Resources.Resources_Quantity) are NOT derivable from
 * Journal — Journal only carries Debit/Credit amounts against an
 * Account_id, it has no per-product quantity field. Quantity instead
 * lives on Transactions (via openTransactionCycle), one level up from
 * Journal. So a full rebuild replays two different tables for two
 * different kinds of state, not one table for everything:
 *   Account balances    <- replayed from Journal
 *   Resource quantities <- replayed from Transactions
 *
 * This module doesn't change how the app currently works — every
 * balance shown anywhere is already computed live, not stored-and-
 * trusted, so there's no existing "stale total" this replaces. What this
 * adds is the ability to verify that live computation against an
 * independent full replay, and a real recovery path if Resources or
 * Account rows were ever directly corrupted without touching the
 * underlying Transactions/Journal history.
 */

const { prisma, round2 } = require("./core");

/**
 * replayAccountBalances — recomputes every Account's balance for a
 * business purely from Journal, independent of anything currently stored
 * on the Account row itself (which is always 0 and never trusted — see
 * core.js's own comments on Current_Balance). Returns a map keyed by
 * Account_id, each entry the balance on that account's own normal side.
 */
async function replayAccountBalances(entrepriseId) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
  const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });

  const totals = {};
  for (const j of journal) {
    if (!totals[j.Account_id]) totals[j.Account_id] = { debit: 0, credit: 0 };
    totals[j.Account_id].debit += Number(j.Debit || 0);
    totals[j.Account_id].credit += Number(j.Credit || 0);
  }

  const result = {};
  for (const acc of accounts) {
    const t = totals[acc.Account_id] || { debit: 0, credit: 0 };
    const balance = acc.Normal_Balance === "CREDIT" ? t.credit - t.debit : t.debit - t.credit;
    result[acc.Account_id] = {
      accountName: acc.Account_Name,
      accountType: acc.Account_Type,
      balance: round2(balance),
      journalEntryCount: journal.filter((j) => j.Account_id === acc.Account_id).length,
    };
  }
  return result;
}

/**
 * replayResourceQuantities — recomputes every product's physical stock
 * quantity purely from Transactions history (Business_Event +
 * Quantity), independent of whatever Resources.Resources_Quantity
 * currently holds. INVENTORY_INCREASE-shaped events (PURCHASE) add;
 * INVENTORY_DECREASE-shaped events (SALE, LOSS) subtract. Only products
 * that are real Goods (not Services/Utilities/Investments) carry a
 * meaningful quantity at all.
 */
async function replayResourceQuantities(entrepriseId) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const products = await prisma.Product.findMany({ where: { Entreprise_id: entrepriseId, Is_Service: 0, Is_Utility: 0 } });
  const productIds = products.map((p) => p.Product_id);

  const transactions = await prisma.Transactions.findMany({
    where: { Product_id: { in: productIds }, Entreprise_id: entrepriseId },
  });

  const result = {};
  for (const product of products) {
    result[product.Product_id] = { productName: product.Product_Name, replayedQuantity: 0, transactionCount: 0 };
  }

  for (const t of transactions) {
    const entry = result[t.Product_id];
    if (!entry) continue;
    const quantity = Number(t.Quantity || 0);
    if (t.Business_Event === "PURCHASE") entry.replayedQuantity += quantity;
    else if (t.Business_Event === "SALE" || t.Business_Event === "LOSS") entry.replayedQuantity -= quantity;
    entry.transactionCount += 1;
  }

  for (const key of Object.keys(result)) {
    result[key].replayedQuantity = round2(result[key].replayedQuantity);
  }
  return result;
}

/**
 * verifyAgainstStored — compares a replayed result against what's
 * currently stored (live-computed for accounts, since nothing is
 * actually stored-and-trusted there; directly stored for Resources,
 * which is the one place in this system that keeps a running total
 * rather than always computing live). A real discrepancy here would mean
 * either a bug in a posting function, or that a Resources row was
 * manually edited outside the posting engine.
 */
async function verifyResourceQuantities(entrepriseId) {
  const replayed = await replayResourceQuantities(entrepriseId);
  const products = await prisma.Product.findMany({ where: { Entreprise_id: entrepriseId, Is_Service: 0, Is_Utility: 0 } });
  const productIds = products.map((p) => p.Product_id);
  const resources = await prisma.Resources.findMany({ where: { Product_id: { in: productIds } } });
  const storedByProduct = Object.fromEntries(resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)]));

  const discrepancies = [];
  for (const [productId, entry] of Object.entries(replayed)) {
    const stored = storedByProduct[productId] ?? 0;
    if (Math.abs(stored - entry.replayedQuantity) > 0.001) {
      discrepancies.push({
        productId: Number(productId),
        productName: entry.productName,
        stored,
        replayed: entry.replayedQuantity,
        difference: round2(stored - entry.replayedQuantity),
      });
    }
  }
  return { checked: Object.keys(replayed).length, discrepancies };
}

/**
 * computeIndirectCashFlow — the indirect method: start from accrual-basis
 * Net Profit, then reconcile it to the actual change in cash by adding
 * back non-cash expenses (Depreciation) and adjusting for the change in
 * working-capital accounts (Trade Receivables, Trade Payables, Inventory)
 * over the period. Genuinely a replay: every figure here is recomputed
 * from Journal, the same source the direct method (Money > Cash Flow's
 * byActivity breakdown) already uses — this just walks it from the
 * opposite direction, the way IAS 7 permits either method to be shown.
 *
 * The two methods computing to the same net cash movement is itself a
 * real integrity check — if they disagree, something in one of the two
 * computations (or in the underlying Journal data) is wrong. This
 * function returns both its own total and the caller's direct-method
 * total for that comparison, rather than silently trusting either one.
 */
async function computeIndirectCashFlow(entrepriseId, directMethodOperatingTotal, businessUnit = null) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  // Fixed: this was pulling every Journal row for the whole business
  // regardless of which unit the Direct Method (computed by the caller)
  // was actually scoped to, so Net Income here silently included every
  // business unit while directMethodOperatingTotal reflected only one —
  // the two were never computing over the same data in the first place,
  // which alone was enough to make them disagree regardless of any
  // classification logic. Scoped through Transactions.Business_Unit, the
  // same pattern already used everywhere else in this app.
  let journal;
  if (businessUnit) {
    const unitTransactions = await prisma.Transactions.findMany({
      where: { Business_Unit: businessUnit, Entreprise_id: entrepriseId },
      select: { Transactions_id: true },
    });
    const unitTxnIds = unitTransactions.map((t) => t.Transactions_id);
    journal = await prisma.Journal.findMany({ where: { Transactions_id: { in: unitTxnIds } } });
  } else {
    journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
  }
  const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId } });
  const accountById = Object.fromEntries(accounts.map((a) => [a.Account_id, a]));

  let netProfit = 0;
  let depreciationAddBack = 0;
  let gainOnDisposalAdjustment = 0; // subtracted back out — see below
  let receivablesChange = 0; // increase = cash NOT yet collected, a use of cash
  let payablesChange = 0; // increase = cash NOT yet paid, a source of cash
  let inventoryChange = 0; // increase = cash spent building stock, a use of cash

  // Every one of these three genuinely never touches a cash-equivalent
  // account — confirmed against their actual Catalogue definitions in
  // assets.js (Depreciation: 5700/1410, Impairment: 5921/1400,
  // Revaluation Loss: 1400/5922) — so each reduces Net Profit with no
  // cash counterpart at all, the same shape as Depreciation, and needs
  // the same add-back treatment.
  const NON_CASH_EXPENSE_ACCOUNTS = ["Depreciation Expense", "Impairment Loss", "Revaluation Loss"];

  for (const j of journal) {
    const acc = accountById[j.Account_id];
    if (!acc) continue;
    const debit = Number(j.Debit || 0);
    const credit = Number(j.Credit || 0);

    if (acc.Account_Name === "Gain/Loss on Disposal of Assets") {
      // A gain (or loss) on disposal is real profit, but it belongs to
      // Investing activities, not Operating — the actual cash from a
      // disposal already appears in the Investing section (as proceeds),
      // so counting the gain again here via Net Income would double it.
      // A CREDIT balance here is a gain (increases Net Income, needs
      // backing out); a DEBIT balance is a loss (decreases Net Income,
      // needs adding back) — the same subtraction handles both since
      // it's already signed correctly.
      netProfit += credit - debit;
      gainOnDisposalAdjustment += credit - debit;
    } else if (acc.Account_Type === "INCOME") netProfit += credit - debit;
    else if (acc.Account_Type === "EXPENDITURE") {
      netProfit -= debit - credit;
      if (NON_CASH_EXPENSE_ACCOUNTS.includes(acc.Account_Name)) depreciationAddBack += debit - credit;
    } else if (acc.Account_Name === "Trade Receivables" && !(j.Description || "").startsWith("DISPOSE_FIXED_ASSET")) {
      // A receivable from disposing of a fixed asset on credit is
      // genuinely an Investing item, not Operating working capital — the
      // Direct method never counts it as Operating cash either (it's
      // excluded entirely until settled), so including it here would
      // double-subtract something Direct never added in the first place.
      // This was the real cause of a real Direct/Indirect mismatch,
      // found by tracing the exact discrepancy amount back to a specific
      // disposed asset in a real test business's data.
      receivablesChange += debit - credit;
    } else if (acc.Account_Name === "Trade Payables") payablesChange += credit - debit;
    else if (acc.Account_Name === "Inventory") inventoryChange += debit - credit;
  }

  const operatingCashFlow = round2(netProfit - gainOnDisposalAdjustment + depreciationAddBack - receivablesChange + payablesChange - inventoryChange);

  return {
    netProfit: round2(netProfit),
    gainOnDisposalAdjustment: round2(gainOnDisposalAdjustment),
    depreciationAddBack: round2(depreciationAddBack),
    receivablesChange: round2(receivablesChange),
    payablesChange: round2(payablesChange),
    inventoryChange: round2(inventoryChange),
    operatingCashFlow,
    // Only operating activity is genuinely reconciled by the indirect
    // method — investing and financing are identical under both methods
    // (a fixed asset purchase or a loan drawdown is already a single,
    // unambiguous cash event with nothing to reconcile), so this compares
    // against the direct method's OPERATING total specifically, not its
    // whole net movement across all three activities.
    directMethodOperatingTotal: directMethodOperatingTotal != null ? round2(directMethodOperatingTotal) : null,
    matchesDirectMethod:
      directMethodOperatingTotal != null ? Math.abs(operatingCashFlow - directMethodOperatingTotal) < 0.01 : null,
  };
}

module.exports = { replayAccountBalances, replayResourceQuantities, verifyResourceQuantities, computeIndirectCashFlow };
