/**
 * navShared.js — small helpers shared by more than one nav route module.
 * Not a barrel, not domain logic — the date utilities used by dashboard
 * and reports.
 */

const BUSINESS_NAME = "Nzovu";

function todayLabel() {
  return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = { BUSINESS_NAME, todayLabel, startOfToday };
