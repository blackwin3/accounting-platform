/**
 * corrections.js — genuine correction entries, matching the schema's own
 * documented rule exactly: the original entry is NEVER modified or
 * deleted; a correction is a NEW Journal entry that reverses the error,
 * referencing Correction_of. Two entries, not one, is deliberate — a
 * pure reversal (DR/CR swapped from the original) leaves an auditable
 * trail showing both what was originally recorded and that it was
 * genuinely undone, rather than silently editing history.
 *
 * This does not attempt a "correct entry" step (re-posting the right
 * figure) — that's a second, separate posting through whichever normal
 * function the transaction actually belongs to (e.g. postRepackaging),
 * which is exactly the real-world shape: undo the mistake, then post the
 * transaction that should have happened in the first place.
 */

const { prisma, PostingError, postJournalPair, round2 } = require("./core");

/**
 * postCorrection — reverses a specific Journal entry pair by re-posting
 * the exact opposite of what was originally recorded (debit and credit
 * accounts swapped), referencing the original row via Correction_of and
 * requiring a Correction_Reason, matching the schema's mandatory-when-set
 * rule exactly.
 *
 * @param {Object} input
 * @param {number} input.originalJournalId - the Journal row being corrected
 * @param {string} input.reason - mandatory, what was wrong and why
 * @param {number} [input.administrationId]
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

    // The original entry was one leg of a pair (Debit XOR Credit set on
    // this specific row) — the reversal swaps that single leg's side,
    // against the same account, same amount. The matching opposite leg
    // of the original pair gets its own mirrored reversal too, found via
    // the same Transactions_id, so the correction is a genuine balanced
    // pair, not a single dangling entry.
    const account = await tx.Account.findUnique({ where: { Account_id: original.Account_id } });
    if (!account) throw new PostingError("Original account no longer exists");

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
          // Swapped: what was debited is now credited, and vice versa —
          // the exact reversal.
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

    // A human-readable narrative explaining the correction — this is
    // what makes the correction legible later, not just a reversed
    // number with no story attached.
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

module.exports = { postCorrection };
