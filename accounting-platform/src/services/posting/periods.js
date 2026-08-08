/**
 * periods.js — the accounting-period lifecycle domain: opening a new
 * trading day, and advancing an existing period through its lifecycle
 * (OPEN -> REVIEW -> ADJUSTMENT_REQUIRED -> CLOSED -> AUDITED -> LOCKED).
 *
 * This is the piece that was actually missing before: every posting
 * function in this system requires an OPEN Structures(ACCOUNTING_PERIOD)
 * row to exist, but until now nothing in the UI could create one — only
 * seed.js ever created the very first day.
 */

const { prisma, PostingError } = require("./core");

const PERIOD_STATUS_PROGRESSION = ["OPEN", "REVIEW", "ADJUSTMENT_REQUIRED", "CLOSED", "AUDITED", "LOCKED"];

/**
 * openAccountingPeriod — creates a new day (or reopens an existing one).
 * Mirrors the exact shape seed.js uses for the very first period. Refuses
 * to silently open a second OPEN day for the same business.
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

  const alreadyOpen = await prisma.Structures.findFirst({
    where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
  });
  if (alreadyOpen && alreadyOpen.Structures_Name !== date) {
    throw new PostingError(
      `${alreadyOpen.Structures_Name} is still OPEN. Close or advance it before opening a new day — only one day should be open at a time.`
    );
  }

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
 * actually belongs to the calling business first (the previous version
 * of this action had no ownership check at all).
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
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId, Structures_id: { not: period.Structures_id } },
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
 * getPeriodCalendar — returns every ACCOUNTING_PERIOD day in a given
 * month for a business, keyed by date, for the Settings calendar view.
 * Days with no Structures row at all are simply absent from the result —
 * the view renders those as "never opened," distinct from CLOSED.
 */
async function getPeriodCalendar(year, month, entrepriseId) {
  const monthStr = String(month).padStart(2, "0");
  const from = new Date(`${year}-${monthStr}-01T00:00:00`);
  const to = new Date(year, month, 1); // first day of the following month, exclusive upper bound

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

module.exports = { openAccountingPeriod, advancePeriodStatus, getPeriodCalendar, PERIOD_STATUS_PROGRESSION };
