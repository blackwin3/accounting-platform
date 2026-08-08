/**
 * assets_management.js — a coordination/reporting layer over assets.js,
 * matching capital_management.js's exact pattern. Deliberately does NOT
 * post anything itself and does not replace any of assets.js's five
 * posting functions (postAssetPurchase, postAssetDisposal,
 * postDepreciationRun, postAssetImpairment, postAssetRevaluation) —
 * each keeps posting independently. This file only reads what they've
 * already posted and assembles one coherent picture of the fixed-asset
 * register: total carrying value, accumulated depreciation/impairment,
 * a depreciation schedule overview, and disposal history.
 */

const { prisma, round2 } = require("./core");

/**
 * getAssetsSummary — the current state of every asset still on the
 * register (not yet disposed), genuinely computed from the Assets table
 * each time — cost, accumulated depreciation, accumulated impairment,
 * and the resulting carrying value, both per-asset and totalled.
 */
async function getAssetsSummary({ entrepriseId }) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const activeAssets = await prisma.Assets.findMany({
    where: { Entreprise_id: entrepriseId, Period_end: null },
    orderBy: { Assets_id: "desc" },
  });

  const assets = activeAssets.map((a) => {
    const cost = Number(a.Cost_Amount || 0);
    const accumulatedDepreciation = Number(a.Accumulated_Depreciation || 0);
    const accumulatedImpairment = Number(a.Accumulated_Impairment || 0);
    const carryingAmount = a.Carrying_Amount != null ? Number(a.Carrying_Amount) : round2(cost - accumulatedDepreciation - accumulatedImpairment);
    return {
      id: a.Assets_id,
      type: a.Assets_Type,
      classification: a.Asset_Classification,
      cost: round2(cost),
      accumulatedDepreciation: round2(accumulatedDepreciation),
      accumulatedImpairment: round2(accumulatedImpairment),
      carryingAmount: round2(carryingAmount),
      usefulLifeYears: a.Useful_Life_Years != null ? Number(a.Useful_Life_Years) : null,
      depreciationMethod: a.Depreciation_Method,
      acquisitionDate: a.Acquisition_Date,
    };
  });

  const totals = assets.reduce(
    (acc, a) => ({
      totalCost: round2(acc.totalCost + a.cost),
      totalAccumulatedDepreciation: round2(acc.totalAccumulatedDepreciation + a.accumulatedDepreciation),
      totalAccumulatedImpairment: round2(acc.totalAccumulatedImpairment + a.accumulatedImpairment),
      totalCarryingValue: round2(acc.totalCarryingValue + a.carryingAmount),
    }),
    { totalCost: 0, totalAccumulatedDepreciation: 0, totalAccumulatedImpairment: 0, totalCarryingValue: 0 }
  );

  return { assets, assetCount: assets.length, ...totals };
}

/**
 * getDisposalHistory — every asset that has genuinely left the register
 * (Period_end set), most recent first — what it cost, what it carried
 * at, and when it was disposed. Does not compute gain/loss here (that's
 * a real Journal-derived figure postAssetDisposal already records
 * correctly at the moment of disposal) — this is a register-level
 * summary, not a re-derivation of the accounting.
 */
async function getDisposalHistory({ entrepriseId, limit = 50 }) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const disposedAssets = await prisma.Assets.findMany({
    where: { Entreprise_id: entrepriseId, Period_end: { not: null } },
    orderBy: { Assets_id: "desc" },
    take: limit,
  });

  return disposedAssets.map((a) => ({
    id: a.Assets_id,
    type: a.Assets_Type,
    cost: round2(Number(a.Cost_Amount || 0)),
    carryingAtDisposal: a.Carrying_Amount != null ? round2(Number(a.Carrying_Amount)) : null,
    disposalDate: a.Disposal_Date || a.Period_end,
  }));
}

/**
 * getDepreciationScheduleOverview — for each active, depreciating asset,
 * the straight-line annual charge it implies (Cost - Residual) /
 * UsefulLifeYears, and roughly how far through its useful life it
 * currently sits, based on Accumulated_Depreciation against that annual
 * charge. This is a planning overview, not a substitute for
 * postDepreciationRun — the actual posted depreciation is whatever
 * postDepreciationRun has genuinely recorded, this only estimates what
 * "on schedule" would look like for comparison.
 */
async function getDepreciationScheduleOverview({ entrepriseId }) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const activeAssets = await prisma.Assets.findMany({
    where: { Entreprise_id: entrepriseId, Period_end: null, Useful_Life_Years: { not: null } },
    orderBy: { Assets_id: "desc" },
  });

  return activeAssets
    .filter((a) => a.Depreciation_Method === "STRAIGHT_LINE" || a.Depreciation_Method === "REDUCING_BALANCE")
    .map((a) => {
      const cost = Number(a.Cost_Amount || 0);
      const residual = Number(a.Residual_Value || 0);
      const usefulLifeYears = Number(a.Useful_Life_Years || 0);
      const annualCharge = usefulLifeYears > 0 ? round2((cost - residual) / usefulLifeYears) : 0;
      const accumulatedDepreciation = Number(a.Accumulated_Depreciation || 0);
      const yearsElapsed = annualCharge > 0 ? round2(accumulatedDepreciation / annualCharge) : 0;
      const percentDepreciated = cost > residual ? round2(((cost - residual > 0 ? accumulatedDepreciation / (cost - residual) : 0)) * 100) : 0;
      return {
        id: a.Assets_id,
        type: a.Assets_Type,
        method: a.Depreciation_Method,
        annualCharge,
        usefulLifeYears,
        yearsElapsed,
        percentDepreciated: Math.min(100, percentDepreciated),
      };
    });
}

module.exports = { getAssetsSummary, getDisposalHistory, getDepreciationScheduleOverview };
