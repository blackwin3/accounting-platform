/**
 * accounting_practice.js — the three administrative domains of accounting
 * practice merged into one file: the accounting-period lifecycle, correction
 * entries, and verification/replay of derived state from the transactional
 * record.
 *
 * These three domains were previously split across periods.js, corrections.js,
 * and replay.js. The split was an organisational accident rather than a
 * genuine structural boundary — each file was short, each addressed a
 * different aspect of the same "accounting discipline" concern (how periods
 * are managed, how errors are corrected, how the integrity of the record is
 * verified), and no one of the three made sense in isolation from the others.
 * Merged here because the accounting practice that governs all three is the
 * same: the original transactional record is never modified after posting, a
 * correction is always a new entry not an edit, and every derived figure is
 * always recomputable from Journal/Transactions history.
 *
 * Catalogue migration status per function:
 *
 *   openAccountingPeriod   — manages Structures rows, not Journal; a
 *                            Catalogue migration would be a category error.
 *   advancePeriodStatus    — same: structural, no Journal posting at all.
 *   getPeriodCalendar      — read-only query; nothing to migrate.
 *   postCorrection         — genuinely and deliberately hand-written: it
 *                            loops over the original Journal pair by
 *                            Transactions_id, reverses each leg individually,
 *                            and writes Correction_of / Correction_Reason
 *                            fields the interpreter has no support for. A
 *                            correction has no fixed DR/CR shape — the
 *                            accounts are dynamic, looked up from the
 *                            original entry. Making the interpreter handle
 *                            this correctly would require the interpreter to
 *                            itself look up an original Journal entry, which
 *                            would make it a worse version of this function,
 *                            not a better one.
 *   replayAccountBalances  — read-only replay from Journal; nothing to migrate.
 *   replayResourceQuantities — read-only replay from Transactions; nothing.
 *   verifyResourceQuantities — read-only comparison; nothing to migrate.
 *   computeIndirectCashFlow  — read-only computation from Journal; nothing.
 */

const { prisma, PostingError, postJournalPair, round2, openTransactionCycle, buildCycleReference, findOrCreateExpensePlaceholder } = require("./core");

// ─── SECTION 6: SYSTEM DIAGNOSTICS ──────────────────────────────────────────
//
// Error detection aimed at catching both:
//   1. Code errors — balance drift, orphaned records, FK inconsistencies,
//      Journal_Entry_Groups that don't balance
//   2. Accounting errors — wrong-side postings, negative balances on
//      accounts that shouldn't go negative, suspicious amounts, duplicate
//      transactions within the same minute
//
// Designed to be run on demand (GET /api/diagnostics) or as part of
// period close. Every check returns { passed, severity, detail } so the
// caller can decide whether to block, warn, or just report.

/**
 * runSystemDiagnostics — runs all diagnostic checks and returns a
 * structured report. Read-only — no side effects, no fixes applied.
 * The caller decides what to do with the results.
 */
async function runSystemDiagnostics(entrepriseId) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const results = [];
  const run = async (name, severity, fn) => {
    try {
      const r = await fn();
      results.push({ name, severity, ...r });
    } catch (e) {
      results.push({ name, severity, passed: false, detail: `Check crashed: ${e.message}` });
    }
  };

  // ── CODE ERROR DETECTION ───────────────────────────────────────────

  await run("JOURNAL_TOTAL_BALANCE", "BLOCK", async () => {
    // The entire Journal for this business must balance: total DR = total CR.
    // If it doesn't, a posting function has a bug.
    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });
    const totalDebit = journal.reduce((s, j) => s + Number(j.Debit || 0), 0);
    const totalCredit = journal.reduce((s, j) => s + Number(j.Credit || 0), 0);
    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.01) {
      return { passed: false, detail: `Journal out of balance by KES ${diff.toFixed(2)} (DR: ${totalDebit.toFixed(2)}, CR: ${totalCredit.toFixed(2)}). This is a code error — a posting function created an unbalanced entry.` };
    }
    return { passed: true, detail: `Journal balanced: ${journal.length} entries, DR = CR = KES ${totalDebit.toFixed(2)}.` };
  });

  await run("JOURNAL_GROUP_BALANCE", "BLOCK", async () => {
    // Every Journal_Entry_Group must individually balance.
    // An unbalanced group means the posting function that created it has a bug.
    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId, Journal_Entry_Group: { not: null } } });
    const groups = {};
    for (const j of journal) {
      const g = j.Journal_Entry_Group;
      if (!groups[g]) groups[g] = { debit: 0, credit: 0 };
      groups[g].debit += Number(j.Debit || 0);
      groups[g].credit += Number(j.Credit || 0);
    }
    const unbalanced = Object.entries(groups).filter(([, v]) => Math.abs(v.debit - v.credit) > 0.01);
    if (unbalanced.length > 0) {
      return { passed: false, detail: `${unbalanced.length} Journal entry group(s) are out of balance. Groups: ${unbalanced.map(([k, v]) => `${k} (DR ${v.debit.toFixed(2)} ≠ CR ${v.credit.toFixed(2)})`).join("; ")}` };
    }
    return { passed: true, detail: `${Object.keys(groups).length} Journal entry groups all balanced.` };
  });

  await run("ACCOUNT_BALANCE_DRIFT", "BLOCK", async () => {
    // The balance stored on Account.Current_Balance should match what
    // the Journal computes. If they differ, something updated the
    // balance outside the normal posting flow.
    const accounts = await prisma.Account.findMany({ where: { Entreprise_id: entrepriseId, Is_Active: 1 } });
    const journal = await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId } });

    const computed = {};
    for (const j of journal) {
      if (!computed[j.Account_id]) computed[j.Account_id] = { debit: 0, credit: 0 };
      computed[j.Account_id].debit += Number(j.Debit || 0);
      computed[j.Account_id].credit += Number(j.Credit || 0);
    }

    const drifted = [];
    for (const a of accounts) {
      const c = computed[a.Account_id] || { debit: 0, credit: 0 };
      const expected = a.Normal_Balance === "CREDIT"
        ? round2(c.credit - c.debit)
        : round2(c.debit - c.credit);
      const stored = round2(Number(a.Current_Balance || 0));
      if (Math.abs(expected - stored) > 0.01) {
        drifted.push({ name: a.Account_Name, stored, expected, diff: round2(expected - stored) });
      }
    }
    if (drifted.length > 0) {
      return { passed: false, detail: `${drifted.length} account(s) have drifted balances: ${drifted.map(d => `${d.name} (stored ${d.stored}, should be ${d.expected})`).join("; ")}` };
    }
    return { passed: true, detail: `${accounts.length} active accounts all match their Journal-computed balances.` };
  });

  await run("ORPHANED_JOURNAL_ENTRIES", "WARN", async () => {
    // Journal entries without a valid Transaction — indicates a code
    // path that posts to the Journal without creating a Transaction first.
    const orphans = await prisma.Journal.findMany({
      where: { Entreprise_id: entrepriseId, Transactions_id: null },
    });
    if (orphans.length > 0) {
      return { passed: false, detail: `${orphans.length} Journal entries have no linked Transaction.` };
    }
    return { passed: true, detail: "All Journal entries have linked Transactions." };
  });

  await run("ORPHANED_TRANSACTIONS", "WARN", async () => {
    // Transactions that exist but have no Journal entries — the posting
    // function created the transaction but failed before writing the journal.
    const transactions = await prisma.Transactions.findMany({ where: { Entreprise_id: entrepriseId } });
    const journalTxIds = new Set(
      (await prisma.Journal.findMany({ where: { Entreprise_id: entrepriseId }, select: { Transactions_id: true } }))
        .map(j => j.Transactions_id).filter(Boolean)
    );
    const orphans = transactions.filter(t => !journalTxIds.has(t.Transactions_id));
    if (orphans.length > 0) {
      return { passed: false, detail: `${orphans.length} Transaction(s) have no Journal entries — possible partial posting.` };
    }
    return { passed: true, detail: `All ${transactions.length} Transactions have corresponding Journal entries.` };
  });

  // ── ACCOUNTING ERROR DETECTION ─────────────────────────────────────

  await run("NEGATIVE_CASH_BALANCE", "WARN", async () => {
    // Cash, Mobile Money, and Bank accounts should never go negative.
    // A negative balance means more money was paid out than existed,
    // which is either a data entry error or a timing issue.
    const cashCodes = ["1000", "1010", "1020"];
    const negatives = [];
    for (const code of cashCodes) {
      const codeRow = await prisma.Account_codes.findFirst({ where: { Code: code, Entreprise_id: entrepriseId } });
      if (!codeRow) continue;
      const account = await prisma.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
      if (!account) continue;
      const balance = Number(account.Current_Balance || 0);
      if (balance < -0.01) {
        negatives.push({ name: account.Account_Name, code, balance: round2(balance) });
      }
    }
    if (negatives.length > 0) {
      return { passed: false, detail: `Cash accounts with negative balances: ${negatives.map(n => `${n.name} (${n.code}): KES ${n.balance}`).join("; ")}. This usually means an expense was posted without sufficient funds.` };
    }
    return { passed: true, detail: "All cash accounts have non-negative balances." };
  });

  await run("SUSPICIOUS_AMOUNTS", "INFO", async () => {
    // Flag transactions with unusually large amounts that might be
    // data entry errors (e.g. KES 100,000 instead of KES 1,000).
    const materialitySetting = await prisma.Settings.findFirst({
      where: { Setting_Name: "MATERIALITY_THRESHOLD", Entreprise_id: entrepriseId },
    });
    const threshold = materialitySetting ? Number(materialitySetting.Setting_Value) * 20 : 100000;

    const large = await prisma.Transactions.findMany({
      where: { Entreprise_id: entrepriseId, Amount: { gt: threshold } },
      orderBy: { Amount: "desc" },
      take: 10,
    });
    if (large.length > 0) {
      return { passed: false, detail: `${large.length} transaction(s) exceed KES ${threshold.toLocaleString()} (20× materiality threshold). Largest: KES ${Number(large[0].Amount).toLocaleString()}. Review for possible data entry errors.` };
    }
    return { passed: true, detail: `No transactions exceed the suspicious-amount threshold (KES ${threshold.toLocaleString()}).` };
  });

  await run("DUPLICATE_TRANSACTIONS", "INFO", async () => {
    // Transactions with the same amount, product, and date within the
    // same minute — possible double-entry from a double-click or
    // network retry.
    const transactions = await prisma.Transactions.findMany({
      where: { Entreprise_id: entrepriseId },
      orderBy: { Created_at: "desc" },
      take: 500,
    });
    const seen = {};
    const duplicates = [];
    for (const t of transactions) {
      const key = `${t.Product_id}-${t.Amount}-${t.Transactions_date?.toISOString?.()?.slice(0, 16) || ""}`;
      if (seen[key]) {
        duplicates.push({ id: t.Transactions_id, matchId: seen[key], amount: t.Amount });
      }
      seen[key] = t.Transactions_id;
    }
    if (duplicates.length > 0) {
      return { passed: false, detail: `${duplicates.length} possible duplicate transaction(s) found (same product, amount, and minute). IDs: ${duplicates.slice(0, 5).map(d => `#${d.id}↔#${d.matchId}`).join(", ")}${duplicates.length > 5 ? "..." : ""}.` };
    }
    return { passed: true, detail: "No duplicate transactions detected in the last 500 entries." };
  });

  await run("LIABILITY_EXCEEDS_ORIGINAL", "WARN", async () => {
    // A Liability row's Net_Amount should never exceed its original
    // Net_Amount at creation — payments should reduce it, not increase it.
    const liabilities = await prisma.Liability.findMany({ where: { Entreprise_id: entrepriseId } });
    // We can't check original vs current without history, but we can
    // check for negative Net_Amount (overpayment).
    const negatives = liabilities.filter(l => Number(l.Net_Amount || 0) < -0.01);
    if (negatives.length > 0) {
      return { passed: false, detail: `${negatives.length} Liability row(s) have negative Net_Amount — overpayment detected.` };
    }
    return { passed: true, detail: `${liabilities.length} Liability rows all have non-negative balances.` };
  });

  await run("ASSET_CARRYING_CONSISTENCY", "WARN", async () => {
    // Carrying_Amount should equal Cost - AccumulatedDepreciation - AccumulatedImpairment.
    const assets = await prisma.Assets.findMany({ where: { Entreprise_id: entrepriseId, Period_end: null } });
    const inconsistent = [];
    for (const a of assets) {
      const cost = Number(a.Cost_Amount || 0);
      const accDep = Number(a.Accumulated_Depreciation || 0);
      const accImp = Number(a.Accumulated_Impairment || 0);
      const expected = round2(cost - accDep - accImp);
      const stored = round2(Number(a.Carrying_Amount || 0));
      if (Math.abs(expected - stored) > 0.01) {
        inconsistent.push({ type: a.Assets_Type, stored, expected });
      }
    }
    if (inconsistent.length > 0) {
      return { passed: false, detail: `${inconsistent.length} asset(s) have inconsistent Carrying_Amount: ${inconsistent.map(a => `${a.type} (stored ${a.stored}, should be ${a.expected})`).join("; ")}` };
    }
    return { passed: true, detail: `${assets.length} active assets all have consistent Carrying_Amount.` };
  });

  // ── SUMMARY ────────────────────────────────────────────────────────

  const blockers = results.filter(r => !r.passed && r.severity === "BLOCK");
  const warnings = results.filter(r => !r.passed && r.severity === "WARN");
  const info = results.filter(r => !r.passed && r.severity === "INFO");

  return {
    healthy: blockers.length === 0,
    totalChecks: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    blockers,
    warnings,
    info,
    results,
  };
}

module.exports = { runSystemDiagnostics };
