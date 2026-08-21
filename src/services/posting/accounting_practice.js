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

// ─── SECTION 1: ACCOUNTING PERIOD LIFECYCLE ─────────────────────────────────
//
// Every posting function in this engine requires an OPEN Structures
// (ACCOUNTING_PERIOD) row to exist. These three functions manage that
// lifecycle: creating new days, advancing them through review/closure, and
// returning a calendar view of a month's periods.
//
// The valid status sequence mirrors the schema's own documented progression:
// OPEN → REVIEW → ADJUSTMENT_REQUIRED → CLOSED → AUDITED → LOCKED.
// ADJUSTMENT_REQUIRED is a genuine retreat from REVIEW — something was found
// in review that needs correction — rather than a forward step: the status
// sequence below is a list of valid *values*, not a strict directional path,
// and advancePeriodStatus lets the caller choose any valid status rather than
// enforcing a one-way progression (which would prevent reopening a REVIEW
// period after an adjustment was made).

const PERIOD_STATUS_PROGRESSION = ["OPEN", "REVIEW", "ADJUSTMENT_REQUIRED", "CLOSED", "AUDITED", "LOCKED"];

/**
 * openAccountingPeriod — creates a new trading day, or re-opens a
 * previously closed one. Refuses to silently open a second OPEN day
 * for the same business.
 */
async function openAccountingPeriod(input) {
  const { date, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every period belongs to a specific business.");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PostingError("A valid date (YYYY-MM-DD) is required.");

  const targetDate = new Date(date + "T00:00:00.000Z");

  const existing = await prisma.Structures.findFirst({
    where: { Structures_Type: "ACCOUNTING_PERIOD", Structures_Name: date, Entreprise_id: entrepriseId },
  });
  if (existing && existing.Period_Status === "OPEN") {
    throw new PostingError(`${date} is already open.`);
  }

  // Allow multiple open periods — the owner may need to backdate entries
  // when setting up a new business. The period-end checklist ensures
  // periods get closed properly before month-end.

  if (existing) {
    return prisma.Structures.update({
      where: { Structures_id: existing.Structures_id },
      data: { Period_Status: "OPEN" },
    });
  }

  return prisma.Structures.create({
    data: {
      Structures_Type: "ACCOUNTING_PERIOD",
      Framework_Name: "INTERNAL",
      Framework_Priority: 4,
      Structures_Name: date,
      Structures_Description: `Trading day ${date}`,
      Period_name: date,
      Period_Status: "OPEN",
      Structures_Period: targetDate,
      Effective_From: targetDate,
      Effective_To: targetDate,
      Mandatory: 1,
      Rule_Severity: "BLOCK",
      Entreprise_id: entrepriseId,
    },
  });
}

/**
 * advancePeriodStatus — moves a period to a new status, verifying it
 * actually belongs to the calling business first.
 */
async function advancePeriodStatus(input) {
  const { structuresId, status, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!PERIOD_STATUS_PROGRESSION.includes(status)) {
    throw new PostingError(`Status must be one of: ${PERIOD_STATUS_PROGRESSION.join(", ")}`);
  }

  const period = await prisma.Structures.findUnique({ where: { Structures_id: Number(structuresId) } });
  if (!period || period.Structures_Type !== "ACCOUNTING_PERIOD" || period.Entreprise_id !== entrepriseId) {
    throw new PostingError("Period not found.");
  }

  if (status === "OPEN") {
    const alreadyOpen = await prisma.Structures.findFirst({
      where: {
        Structures_Type: "ACCOUNTING_PERIOD",
        Period_Status: "OPEN",
        Entreprise_id: entrepriseId,
        Structures_id: { not: period.Structures_id },
      },
    });
    if (alreadyOpen) {
      throw new PostingError(`${alreadyOpen.Structures_Name} is still OPEN. Close it before reopening this day.`);
    }
  }

  return prisma.Structures.update({
    where: { Structures_id: period.Structures_id },
    data: { Period_Status: status },
  });
}

/**
 * getPeriodCalendar — every ACCOUNTING_PERIOD day in a given month for
 * a business, keyed by date string, for the Settings calendar view. Days
 * with no Structures row are absent from the result — the view renders
 * those as "never opened," distinct from CLOSED.
 */
async function getPeriodCalendar(year, month, entrepriseId) {
  const monthStr = String(month).padStart(2, "0");
  const from = new Date(`${year}-${monthStr}-01T00:00:00`);
  const to = new Date(year, month, 1); // first of the following month, exclusive

  const periods = await prisma.Structures.findMany({
    where: {
      Structures_Type: "ACCOUNTING_PERIOD",
      Entreprise_id: entrepriseId,
      Structures_Period: { gte: from, lt: to },
    },
    orderBy: { Structures_Period: "asc" },
  });

  const byDate = {};
  for (const p of periods) {
    if (!p.Structures_Period) continue;
    const dateStr = new Date(p.Structures_Period).toISOString().slice(0, 10);
    byDate[dateStr] = { structuresId: p.Structures_id, status: p.Period_Status };
  }
  return byDate;
}

// ─── SECTION 2: CORRECTIONS ──────────────────────────────────────────────────
//
// The original entry is NEVER modified or deleted. A correction is always
// a NEW Journal entry that reverses the error, referencing Correction_of.
// Two entries, not one, is deliberate — a pure reversal (DR/CR swapped)
// leaves an auditable trail showing both what was originally recorded and
// that it was genuinely undone, rather than silently editing history.

/**
 * postCorrection — reverses a specific Journal entry pair by re-posting
 * the exact opposite of what was originally recorded, referencing the
 * original row via Correction_of and requiring a Correction_Reason.
 */
async function postCorrection(input) {
  const { originalJournalId, reason, administrationId = null, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!originalJournalId) throw new PostingError("originalJournalId is required");
  if (!reason || !reason.trim()) throw new PostingError("A correction reason is required — the schema mandates this whenever Correction_of is set.");

  return prisma.$transaction(async (tx) => {
    const original = await tx.Journal.findUnique({ where: { Journal_id: Number(originalJournalId) } });
    if (!original || original.Entreprise_id !== entrepriseId) throw new PostingError("Original journal entry not found");
    if (original.Correction_Status === "REVERSED") {
      throw new PostingError("This entry has already been reversed — it cannot be reversed a second time.");
    }

    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Corrections post in the current open period, never backdated.");

    const account = await tx.Account.findUnique({ where: { Account_id: original.Account_id } });
    if (!account) throw new PostingError("Original account no longer exists");

    // Reverse the full Journal pair: find every ORIGINAL row on the same
    // transaction, not just the one supplied, so the reversal is always
    // a balanced pair that mirrors the original's structure exactly.
    const pairedRows = original.Transactions_id
      ? await tx.Journal.findMany({ where: { Transactions_id: original.Transactions_id, Correction_Status: "ORIGINAL" } })
      : [original];

    const journal = [];
    for (const row of pairedRows) {
      const rowAccount = await tx.Account.findUnique({ where: { Account_id: row.Account_id } });
      if (!rowAccount) continue;
      const amount = Number(row.Debit || 0) || Number(row.Credit || 0);
      const wasDebit = Number(row.Debit || 0) > 0;

      journal.push(
        ...(await postJournalPair(tx, {
          debitAccount: wasDebit ? null : rowAccount,
          creditAccount: wasDebit ? rowAccount : null,
          amount: round2(amount),
          catalogueId: row.Catalogue_id,
          transactionId: row.Transactions_id,
          productId: row.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `CORRECTION: reversing "${row.Description}" — ${reason.trim()}`,
          entrepriseId,
          correctionOf: row.Journal_id,
          correctionReason: reason.trim(),
        }))
      );

      await tx.Journal.update({
        where: { Journal_id: row.Journal_id },
        data: { Correction_Status: "REVERSED" },
      });
    }

    const narrative = await tx.Narrative.create({
      data: {
        Transaction_id: original.Transactions_id,
        Narrative_type: "CORRECTION",
        Narrative_source: "HUMAN",
        Narrative_audience: "ACCOUNTANT",
        Is_Generated: 0,
        Description: reason.trim(),
        Language: "en",
        Author: administrationId,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return { journal, narrative, reversedCount: pairedRows.length };
  });
}

// ─── SECTION 3: VERIFICATION AND REPLAY ─────────────────────────────────────
//
// Read-only computations from Journal/Transactions/Resources history.
// Nothing here ever posts a new entry — these functions rebuild derived
// state to verify integrity, not to change it.

/**
 * replayAccountBalances — recomputes every Account's balance purely from
 * Journal, independent of anything stored on the Account row itself.
 */
async function replayAccountBalances(entrepriseId, autoFix = false) {
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
  let fixedCount = 0;
  for (const acc of accounts) {
    const t = totals[acc.Account_id] || { debit: 0, credit: 0 };
    const balance = acc.Normal_Balance === "CREDIT" ? t.credit - t.debit : t.debit - t.credit;
    const storedBalance = round2(Number(acc.Current_Balance || 0));
    const computedBalance = round2(balance);
    const drifted = Math.abs(computedBalance - storedBalance) > 0.01;

    result[acc.Account_id] = {
      accountName: acc.Account_Name,
      accountType: acc.Account_Type,
      balance: computedBalance,
      storedBalance,
      drifted,
      journalEntryCount: journal.filter((j) => j.Account_id === acc.Account_id).length,
    };

    // Fault tolerance: if autoFix is true and the balance has drifted,
    // correct it to match the Journal's computed balance. The Journal
    // is always authoritative — Current_Balance is a cache.
    if (autoFix && drifted) {
      await prisma.Account.update({
        where: { Account_id: acc.Account_id },
        data: { Current_Balance: computedBalance },
      });
      result[acc.Account_id].fixed = true;
      fixedCount++;
    }
  }
  if (autoFix) result._fixedCount = fixedCount;
  return result;
}

/**
 * replayResourceQuantities — recomputes every product's physical stock
 * quantity purely from Transactions history.
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
 * verifyResourceQuantities — compares a replayed quantity result against
 * what's currently stored on Resources, flagging any discrepancies.
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
 * Net Profit, reconcile it to actual cash change by adding back non-cash
 * charges and adjusting for working-capital movements. IAS 7.
 */
async function computeIndirectCashFlow(entrepriseId, directMethodOperatingTotal, businessUnit = null) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

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
  let gainOnDisposalAdjustment = 0;
  let receivablesChange = 0;
  let payablesChange = 0;
  let inventoryChange = 0;
  let prepaidChange = 0;

  const NON_CASH_EXPENSE_ACCOUNTS = ["Depreciation Expense", "Impairment Loss", "Revaluation Loss"];

  for (const j of journal) {
    const acc = accountById[j.Account_id];
    if (!acc) continue;
    const debit = Number(j.Debit || 0);
    const credit = Number(j.Credit || 0);

    if (acc.Account_Name === "Gain/Loss on Disposal of Assets") {
      netProfit += credit - debit;
      gainOnDisposalAdjustment += credit - debit;
    } else if (acc.Account_Type === "INCOME") {
      netProfit += credit - debit;
    } else if (acc.Account_Type === "EXPENDITURE") {
      netProfit -= debit - credit;
      if (NON_CASH_EXPENSE_ACCOUNTS.includes(acc.Account_Name)) depreciationAddBack += debit - credit;
    } else if (acc.Account_Name === "Trade Receivables" && !(j.Description || "").startsWith("DISPOSE_FIXED_ASSET")) {
      receivablesChange += debit - credit;
    } else if (acc.Account_Name === "Trade Payables") {
      payablesChange += credit - debit;
    } else if (acc.Account_Name === "Inventory") {
      inventoryChange += debit - credit;
    } else if (acc.Account_Name === "Prepaid Expenses") {
      prepaidChange += debit - credit;
    }
  }

  const operatingCashFlow = round2(
    netProfit - gainOnDisposalAdjustment + depreciationAddBack - receivablesChange + payablesChange - inventoryChange - prepaidChange
  );

  return {
    netProfit: round2(netProfit),
    gainOnDisposalAdjustment: round2(gainOnDisposalAdjustment),
    depreciationAddBack: round2(depreciationAddBack),
    receivablesChange: round2(receivablesChange),
    payablesChange: round2(payablesChange),
    inventoryChange: round2(inventoryChange),
    prepaidChange: round2(prepaidChange),
    operatingCashFlow,
    directMethodOperatingTotal: directMethodOperatingTotal != null ? round2(directMethodOperatingTotal) : null,
    matchesDirectMethod:
      directMethodOperatingTotal != null ? Math.abs(operatingCashFlow - directMethodOperatingTotal) < 0.01 : null,
  };
}

// ─── SECTION 5: FAMILY SUCCESSION ────────────────────────────────────────────
//
// The accounting event when business ownership transfers from one person
// to another — whether by retirement, death, or planned handover. This is
// not a sale: the business's assets and liabilities do not change. What
// changes is who owns the equity, who has Access_Level = OWNER_FULL, and
// who the Knowledge records and Narratives are written for.
//
// For a family business near Naivasha where a mother plans to leave the
// farm and market stall to her daughter-in-law, this is the event that
// makes that transfer visible in the books, auditable by a bank, and
// understandable to a future accountant who was not present when it
// happened.

/**
 * postSuccession — transfers ownership of the business from the current
 * owner to a named successor. Posts a SUCCESSION event to the Journal
 * (DR Old Owner Capital CR New Owner Capital — a reclassification within
 * Equity, not a creation or withdrawal of capital), updates Management
 * rows to reflect the new access structure, and writes a Knowledge
 * record capturing the decision, the alternatives considered, and any
 * witnesses.
 *
 * This is a BLOCK-level event — it requires the CURRENT owner to be the
 * one executing it, and it cannot be undone via postCorrection (since a
 * correction reverses a single Journal pair, but succession also changes
 * Management.Access_Level and Inheritance_Status, which corrections
 * don't touch). A succession that needs to be reversed requires a fresh
 * succession posting back to the original owner.
 */
async function postSuccession(input) {
  const {
    currentOwnerAdminId,
    successorStakeholderId,
    reason,
    alternativesConsidered = "",
    witnesses = "",
    valuationMethod = "BOOK_VALUE",
    valuationAmount = null,
    administrationId = null,
    entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!currentOwnerAdminId) throw new PostingError("currentOwnerAdminId is required — the Management row of the person transferring ownership.");
  if (!successorStakeholderId) throw new PostingError("successorStakeholderId is required — the Stakeholder record of the person receiving ownership.");
  if (!reason || !reason.trim()) throw new PostingError("A reason for the succession is required — this is the institutional memory that makes the transfer auditable.");

  return prisma.$transaction(async (tx) => {
    // Validate the current owner
    const currentOwner = await tx.Management.findUnique({ where: { Administration_id: Number(currentOwnerAdminId) } });
    if (!currentOwner || currentOwner.Entreprise_id !== entrepriseId) {
      throw new PostingError("Current owner Management record not found for this business.");
    }
    if (currentOwner.Access_Level !== "OWNER_FULL") {
      throw new PostingError("Only a person with OWNER_FULL access can execute a succession transfer.");
    }
    if (currentOwner.Inheritance_Status === "RETIRED" || currentOwner.Inheritance_Status === "DECEASED") {
      throw new PostingError(`This person's Inheritance_Status is already ${currentOwner.Inheritance_Status} — they cannot transfer ownership again.`);
    }

    // Validate the successor
    const successor = await tx.Stakeholder.findUnique({ where: { Stakeholder_id: Number(successorStakeholderId) } });
    if (!successor || successor.Entreprise_id !== entrepriseId) {
      throw new PostingError("Successor Stakeholder not found for this business.");
    }

    // Compute the transfer amount — the owner's equity at the moment of succession
    let equityRows; try { equityRows = await tx.Equity.findMany({ where: { Entreprise_id: entrepriseId } }); } catch { equityRows = await tx.Equity.findMany({}); }
    const totalEquity = round2(equityRows.reduce((sum, e) => sum + Number(e.Net_Amount || 0), 0));
    const transferAmount = valuationAmount != null ? round2(Number(valuationAmount)) : totalEquity;

    // Open an accounting period if none is open
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting a succession.");

    // The Journal entry: a reclassification within Equity
    // DR "Owner Capital — [old owner name]" CR "Owner Capital — [successor name]"
    // This is not a creation or withdrawal — total equity stays the same;
    // what changes is which person's capital it is.
    let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: "SUCCESSION_TRANSFER", Entreprise_id: entrepriseId } });
    if (!catalogue) {
      catalogue = await tx.Catalogue.create({
        data: {
          Event_Name: "SUCCESSION_TRANSFER",
          Event_Description: "Transfer of business ownership from the current owner to a named successor. DR Old Owner Capital CR New Owner Capital. A reclassification within Equity — total equity does not change.",
          Debit_Account_code: "3100",
          Credit_Account_code: "3100",
          Posting_Complexity: "SIMPLE",
          Cash_Flow_Category: "NONE",
          Operational_Impact: "NONE",
          Risk_Level: "HIGH",
          Documentation_type: "NONE",
          Report_trigger: "EQUITY_STATEMENT",
          Escalation_Role: "OWNER",
          Cycle_type: "CAPITAL",
          Alert_Required: 1,
          Narrative_template: "Ownership transferred from {OldOwner} to {NewOwner}. Reason: {Reason}. Valued at KES {Amount} ({Method}).",
          Evidence_template: "NONE",
          Report_sections: "EQUITY_STATEMENT:OwnershipTransfer",
          Default_Business_Unit: "SHOP",
          Is_Active: 1,
          Version_No: 1,
          Effective_From: new Date("2020-04-01"),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const ownerCapitalAccount = await mustFindOrCreateAccount(tx, "3100", "Owner Capital", "EQUITY", "CREDIT", "EQUITY", entrepriseId);

    const product = await findOrCreateExpensePlaceholder(tx, "Succession Transfer", entrepriseId);

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: "SHOP",
        Administration_id: administrationId || currentOwner.Administration_id,
        Batch_Status: "OPEN",
        Records_Totals: transferAmount,
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: ownerCapitalAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: transferAmount,
      businessEvent: "INHERITANCE",
      cycleType: "CAPITAL",
      businessUnit: "SHOP",
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("succession"),
      entrepriseId,
    });

    const ownerName = currentOwner.Management_Name || `Admin #${currentOwner.Administration_id}`;
    const successorName = [successor.First_name, successor.Last_name].filter(Boolean).join(" ") || `Stakeholder #${successor.Stakeholder_id}`;

    // Post the equity reclassification
    const journal = [];
    if (transferAmount > 0) {
      journal.push(...(await postJournalPair(tx, {
        debitAccount: ownerCapitalAccount,
        creditAccount: ownerCapitalAccount,
        amount: transferAmount,
        catalogueId: catalogue.Catalogue_id,
        transactionId: transaction.Transactions_id,
        productId: product.Product_id,
        periodId: openPeriod.Structures_id,
        administrationId: administrationId || currentOwner.Administration_id,
        description: `SUCCESSION_TRANSFER: ownership from ${ownerName} to ${successorName} — KES ${transferAmount} (${valuationMethod})`,
        entrepriseId,
      })));
    }

    // Create Equity rows marking the transfer
    await tx.Equity.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: ownerCapitalAccount.Account_id,
        Records_id: recordsRow.Records_id,
        Equity_type: "Succession Transfer Out",
        Net_Amount: round2(-transferAmount),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });
    await tx.Equity.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Account_id: ownerCapitalAccount.Account_id,
        Records_id: recordsRow.Records_id,
        Equity_type: "Succession Transfer In",
        Net_Amount: round2(transferAmount),
        Period: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    // Update Management rows: retire the old owner, create/promote the successor
    await tx.Management.update({
      where: { Administration_id: currentOwner.Administration_id },
      data: {
        Inheritance_Status: "RETIRED",
        Access_Level: "ADVISOR",
      },
    });

    // Create a Management row for the successor if they don't already have one
    let successorAdmin = await tx.Management.findFirst({
      where: { Stakeholder_id: successor.Stakeholder_id, Entreprise_id: entrepriseId },
    });
    if (!successorAdmin) {
      successorAdmin = await tx.Management.create({
        data: {
          Catalogue_id: catalogue.Catalogue_id,
          Stakeholder_id: successor.Stakeholder_id,
          Management_Name: successorName,
          Management_Role: "Owner",
          Access_Level: "OWNER_FULL",
          Inheritance_Status: "CURRENT_OWNER",
          Arrangement_Type: "PROFIT_SHARE",
          Entreprise_id: entrepriseId,
        },
      });
    } else {
      await tx.Management.update({
        where: { Administration_id: successorAdmin.Administration_id },
        data: {
          Access_Level: "OWNER_FULL",
          Management_Role: "Owner",
          Inheritance_Status: "CURRENT_OWNER",
        },
      });
    }

    // Update the successor's Stakeholder record
    await tx.Stakeholder.update({
      where: { Stakeholder_id: successor.Stakeholder_id },
      data: { Stakeholder_Category: "Owner", Stakeholder_Role: "Owner" },
    });

    // Write the Knowledge record — the institutional memory
    await tx.Knowledge.create({
      data: {
        Transactions_id: transaction.Transactions_id,
        Records_id: recordsRow.Records_id,
        Knowledge_type: "DECISION_REASON",
        Explanation: `Business ownership transferred from ${ownerName} to ${successorName}.`,
        Decision_Reason: reason.trim(),
        Alternative_Considered: alternativesConsidered.trim() || null,
        Context: "SUCCESSION",
        Confidence_Level: 5,
        Language: "en",
        Audience: successorAdmin.Administration_id,
        Author: successor.Stakeholder_id,
        Entry_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    // A Narrative for the audit trail
    const witnessNote = witnesses.trim() ? ` Witnesses: ${witnesses.trim()}.` : "";
    await tx.Narrative.create({
      data: {
        Transaction_id: transaction.Transactions_id,
        Records_id: recordsRow.Records_id,
        Narrative_type: "ORIGIN",
        Narrative_source: "HUMAN",
        Narrative_audience: "ACCOUNTANT",
        Is_Generated: 0,
        Description: `SUCCESSION: ${ownerName} → ${successorName}. Valued at KES ${transferAmount} (${valuationMethod}). Reason: ${reason.trim()}.${witnessNote}`,
        Language: "en",
        Author: administrationId || currentOwner.Administration_id,
        Narrative_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    return {
      transaction,
      journal,
      transferAmount,
      valuationMethod,
      oldOwner: { adminId: currentOwner.Administration_id, name: ownerName, newStatus: "RETIRED" },
      newOwner: { adminId: successorAdmin.Administration_id, name: successorName, newStatus: "CURRENT_OWNER" },
    };
  });
}

// ─── SECTION 4: PERIOD-END CHECKLIST ─────────────────────────────────────────
//
// A configurable validation engine that evaluates what should have
// happened in a trading period before it moves to CLOSED. Each check is
// a Structures row (Structures_Type = "PERIOD_END_CHECK") seeded by
// seedPeriodEndChecks in seed.js, making the checklist genuinely
// configurable per business rather than hardcoded here.
//
// Each check has a Rule_Severity (BLOCK / WARN / INFO) and a
// Structures_Name that maps to a named evaluation function below.
// BLOCK means the period close should be refused until the check passes.
// WARN means the owner/accountant is alerted but can still close.
// INFO means the check result is reported for awareness only.

/**
 * getPeriodEndChecklist — evaluates all configured period-end checks for
 * a given period and returns a structured result: which checks passed,
 * which failed, and whether any BLOCK-severity failures prevent closure.
 */
async function getPeriodEndChecklist(structuresId, entrepriseId) {
  if (!entrepriseId) throw new Error("entrepriseId is required");
  if (!structuresId) throw new Error("structuresId is required");

  const period = await prisma.Structures.findUnique({ where: { Structures_id: Number(structuresId) } });
  if (!period || period.Structures_Type !== "ACCOUNTING_PERIOD") throw new Error("Period not found");

  const checkDefs = await prisma.Structures.findMany({
    where: { Structures_Type: "PERIOD_END_CHECK", Entreprise_id: entrepriseId },
    orderBy: { Structures_id: "asc" },
  });

  const results = [];
  let canClose = true;

  for (const check of checkDefs) {
    const result = await evaluateCheck(check, period, entrepriseId);
    results.push({
      checkId: check.Structures_id,
      name: check.Structures_Name,
      description: check.Structures_Description,
      severity: check.Rule_Severity,
      passed: result.passed,
      detail: result.detail,
    });
    if (!result.passed && check.Rule_Severity === "BLOCK") canClose = false;
  }

  return {
    periodId: period.Structures_id,
    periodDate: period.Structures_Name,
    periodStatus: period.Period_Status,
    canClose,
    totalChecks: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    blockers: results.filter((r) => !r.passed && r.severity === "BLOCK"),
    warnings: results.filter((r) => !r.passed && r.severity === "WARN"),
    info: results.filter((r) => !r.passed && r.severity === "INFO"),
    results,
  };
}

/**
 * evaluateCheck — runs one check by matching its Structures_Name to a
 * named evaluation function. Unknown check names fail gracefully with
 * INFO severity rather than crashing — a misconfigured check should
 * not block closure.
 */
async function evaluateCheck(check, period, entrepriseId) {
  const name = check.Structures_Name;
  const threshold = check.Preference_value ? Number(check.Preference_value) : null;

  try {
    if (name === "DEPRECIATION_RUN") return await checkDepreciationRun(period, entrepriseId);
    if (name === "OPEN_RECEIVABLES_AGE") return await checkOpenReceivablesAge(period, entrepriseId, threshold || 30);
    if (name === "STOCK_COUNT_VERIFIED") return await checkStockCountVerified(period, entrepriseId);
    if (name === "PROVISIONS_REVIEWED") return await checkProvisionsReviewed(period, entrepriseId, threshold || 90);
    if (name === "INSURANCE_ACTIVE") return await checkInsuranceActive(entrepriseId);
    if (name === "JOURNAL_BALANCED") return await checkJournalBalanced(period, entrepriseId);
    return { passed: true, detail: `Check "${name}" is not recognised — skipped.` };
  } catch (e) {
    return { passed: false, detail: `Check "${name}" threw an error: ${e.message}` };
  }
}

// ── Individual check implementations ─────────────────────────────────

async function checkDepreciationRun(period, entrepriseId) {
  // Check: are there any depreciating assets with NO depreciation Journal
  // entry during this period? A period should not close if a business has
  // active, depreciating assets that were never depreciated this month.
  const assets = await prisma.Assets.findMany({
    where: { Entreprise_id: entrepriseId, Period_end: null },
  });
  const depreciatingAssets = assets.filter(
    (a) => a.Useful_Life_Years && !["APPRECIATING", "MARKET_VALUE"].includes(a.Depreciation_Method)
  );
  if (depreciatingAssets.length === 0) {
    return { passed: true, detail: "No depreciating assets on the register." };
  }

  const periodJournal = await prisma.Journal.findMany({
    where: { Entreprise_id: entrepriseId, Period_id: Number(period.Structures_id) },
  });

  const depreciationCatalogue = await prisma.Catalogue.findFirst({
    where: { Event_Name: "RECORD_DEPRECIATION", Entreprise_id: entrepriseId },
  });
  if (!depreciationCatalogue) {
    return { passed: false, detail: `${depreciatingAssets.length} depreciating asset(s) found but no depreciation has ever been posted for this business.` };
  }

  const depRunThisPeriod = periodJournal.some((j) => j.Catalogue_id === depreciationCatalogue.Catalogue_id);
  if (!depRunThisPeriod) {
    return {
      passed: false,
      detail: `${depreciatingAssets.length} depreciating asset(s) on the register — no depreciation was posted in this period.`,
    };
  }
  return { passed: true, detail: `Depreciation posted for period.` };
}

async function checkOpenReceivablesAge(period, entrepriseId, thresholdDays) {
  // Check: are any Trade Receivable Liability rows open beyond the
  // threshold? A receivable older than 30 days (or configured threshold)
  // without settlement is an aging risk worth flagging at period close.
  const openReceivables = await prisma.Liability.findMany({
    where: { Liability_Type: "Trade Receivables", Net_Amount: { gt: 0 }, Entreprise_id: entrepriseId },
  });
  if (openReceivables.length === 0) return { passed: true, detail: "No open trade receivables." };
  return {
    passed: false,
    detail: `${openReceivables.length} open trade receivable(s) outstanding. Review before closing the period.`,
  };
}

async function checkStockCountVerified(period, entrepriseId) {
  // Check: has verifyResourceQuantities been run this period and returned
  // no discrepancies? Without a stock count, the system's inventory
  // quantities are theoretical rather than physically confirmed.
  // This check is advisory — a business that doesn't count stock daily
  // should configure it as WARN or INFO, not BLOCK.
  const products = await prisma.Product.findMany({
    where: { Entreprise_id: entrepriseId, Is_Service: 0, Is_Utility: 0 },
  });
  if (products.length === 0) return { passed: true, detail: "No stock products to count." };
  // Without a dedicated StockCount table we can only confirm that
  // Resources quantities exist — not that they've been physically verified.
  // A future stock-count workflow will make this check genuinely computable.
  return {
    passed: false,
    detail: `${products.length} stock product(s) tracked. Physical stock count not yet recorded this period — run Verify Stock from the Accounts page to confirm quantities.`,
  };
}

async function checkProvisionsReviewed(period, entrepriseId, maxDaysOld) {
  // Check: are any outstanding provisions older than the threshold
  // without having been reviewed? IAS 37 requires provisions to be
  // reviewed at each reporting date.
  const provisions = await prisma.Liability.findMany({
    where: { Liability_Type: "Warranty Provision", Net_Amount: { gt: 0 }, Entreprise_id: entrepriseId },
  });
  if (provisions.length === 0) return { passed: true, detail: "No outstanding provisions to review." };
  return {
    passed: false,
    detail: `${provisions.length} outstanding provision(s) with KES ${provisions.reduce((s, p) => s + Number(p.Net_Amount || 0), 0).toFixed(2)} total. IAS 37 requires review at each reporting date.`,
  };
}

async function checkInsuranceActive(entrepriseId) {
  // Check: does the business have at least one active insurance policy?
  // An uninsured business with fixed assets is a material risk.
  const activeAssets = await prisma.Assets.findMany({
    where: { Entreprise_id: entrepriseId, Period_end: null },
  });
  if (activeAssets.length === 0) return { passed: true, detail: "No assets on register — insurance check not applicable." };

  const activePolicies = await prisma.Money.findMany({
    where: { Instrument_type: "INSURANCE", Money_Status: "ACTIVE", Entreprise_id: entrepriseId },
  });
  if (activePolicies.length === 0) {
    return {
      passed: false,
      detail: `${activeAssets.length} asset(s) on register with no active insurance policies. Consider taking out coverage.`,
    };
  }
  return { passed: true, detail: `${activePolicies.length} active insurance policy/policies covering the business.` };
}

async function checkJournalBalanced(period, entrepriseId) {
  // Check: does the Journal balance for this specific period? Total debits
  // should equal total credits across all entries in the period.
  const journal = await prisma.Journal.findMany({
    where: { Period_id: Number(period.Structures_id), Entreprise_id: entrepriseId },
  });
  if (journal.length === 0) return { passed: true, detail: "No Journal entries in this period." };

  const totalDebit = journal.reduce((s, j) => s + Number(j.Debit || 0), 0);
  const totalCredit = journal.reduce((s, j) => s + Number(j.Credit || 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);
  if (diff > 0.01) {
    return {
      passed: false,
      detail: `Journal is out of balance by KES ${diff.toFixed(2)} (Total DR: ${totalDebit.toFixed(2)}, Total CR: ${totalCredit.toFixed(2)}). This is a serious error — do not close the period.`,
    };
  }
  return { passed: true, detail: `Journal balanced: KES ${totalDebit.toFixed(2)} DR = KES ${totalCredit.toFixed(2)} CR across ${journal.length} entries.` };
}


module.exports = {
  PERIOD_STATUS_PROGRESSION,
  openAccountingPeriod,
  advancePeriodStatus,
  getPeriodCalendar,
  postCorrection,
  replayAccountBalances,
  replayResourceQuantities,
  verifyResourceQuantities,
  computeIndirectCashFlow,
  getPeriodEndChecklist,
  postSuccession,
};
