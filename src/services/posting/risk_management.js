/**
 * risk_management.js — a coordination/reporting layer over
 * InsuranceAndProvisions.js, matching capital_management.js and
 * assets_management.js's exact architectural pattern.
 *
 * The three management files sit at the same level in the engine:
 *
 *   capital_management.js   — where the business's capital sits
 *                             (cash, loans, investments, rental property)
 *   assets_management.js    — what the business owns and depreciates
 *                             (PPE register, carrying values, disposal history)
 *   risk_management.js      — what the business is exposed to and how
 *                             it's protected (insurance coverage, provisions,
 *                             total risk exposure vs total cover)
 *
 * Deliberately does NOT post anything itself and does not replace any
 * function in InsuranceAndProvisions.js — each keeps posting
 * independently. This file only reads what they've already posted and
 * assembles one coherent picture of the business's risk position: active
 * insurance policies (coverage amount, premium schedule, expiry),
 * outstanding warranty provisions, total risk exposure, and the gap
 * between what is covered and what is not.
 *
 * Built to feed the Risks & Insurance page's management panel, and to
 * make the same aggregation available to any future risk-reporting or
 * banking/loan-application view without duplicating the underlying
 * Money/Liability queries.
 */

const { prisma, round2 } = require("./core");

/**
 * getRiskPosition — the actual current state of the business's risk
 * exposure and cover, genuinely computed from Money (insurance policies)
 * and Liability (warranty provisions) each time, not a cached or stored
 * figure — matching the "never trust a running total" discipline the rest
 * of this system follows.
 *
 * Returns:
 *   activePolicies         — every ACTIVE insurance Money row, with
 *                            coverage amount, premium due, risk level,
 *                            and days until expiry
 *   totalCoverageAmount    — sum of all active policy Principal_amount
 *                            (the sum insured across all policies)
 *   totalPremiumsDue       — sum of all active Outstanding_Amount
 *                            (premiums currently owed but not yet paid)
 *   expiringWithin30Days   — policies whose Maturity_date is within 30
 *                            days of today — a real risk, since a policy
 *                            that lapses silently leaves the business
 *                            uninsured without the owner noticing
 *   provisionsByType       — warranty provisions still outstanding,
 *                            grouped by Liability_Type, with the
 *                            remaining amount on each
 *   totalProvisions        — sum of all outstanding provision balances
 *   highRiskPolicies       — policies marked Risk_Level = HIGH — these
 *                            are the ones a banker or auditor would ask
 *                            about first
 *   closedPoliciesCount    — CLOSED policies, for the historical record
 *                            (a business that let its fire policy lapse
 *                            is a meaningful fact for a bank)
 *   riskCoverageRatio      — totalCoverageAmount as a ratio of the
 *                            business's total asset carrying value
 *                            (from assets_management via Assets table),
 *                            so the owner can see at a glance whether
 *                            the insured amount is still appropriate as
 *                            the business grows or assets are added
 */
async function getRiskPosition({ entrepriseId }) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [allPolicies, provisionRows, activeAssets] = await Promise.all([
    prisma.Money.findMany({
      where: { Instrument_type: "INSURANCE", Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
    }),
    prisma.Liability.findMany({
      where: { Liability_Type: "Warranty Provision", Entreprise_id: entrepriseId, Net_Amount: { gt: 0 } },
      orderBy: { Liability_id: "asc" },
    }),
    prisma.Assets.findMany({
      where: { Entreprise_id: entrepriseId, Period_end: null },
    }),
  ]);

  const active = allPolicies.filter((p) => p.Money_Status === "ACTIVE");
  const closed = allPolicies.filter((p) => p.Money_Status === "CLOSED");

  const activePolicies = active.map((p) => {
    const daysUntilExpiry = p.Maturity_date
      ? Math.ceil((new Date(p.Maturity_date) - now) / (1000 * 60 * 60 * 24))
      : null;
    return {
      id: p.Money_id,
      name: p.Money_Name,
      coverageAmount: round2(Number(p.Principal_amount || 0)),
      premiumDue: p.Outstanding_Amount != null ? round2(Number(p.Outstanding_Amount)) : null,
      riskLevel: p.Risk_Level,
      riskNote: p.Risk_note,
      startDate: p.Start_date,
      expiryDate: p.Maturity_date,
      daysUntilExpiry,
      expiringWithin30Days: daysUntilExpiry !== null && daysUntilExpiry <= 30,
    };
  });

  const totalCoverageAmount = round2(activePolicies.reduce((sum, p) => sum + p.coverageAmount, 0));
  const totalPremiumsDue = round2(activePolicies.reduce((sum, p) => sum + (p.premiumDue || 0), 0));
  const expiringWithin30Days = activePolicies.filter((p) => p.expiringWithin30Days);
  const highRiskPolicies = activePolicies.filter((p) => p.riskLevel === "HIGH");

  // Provisions grouped by type — Warranty Provision is the only type
  // currently, but grouping by Liability_Type future-proofs this for
  // environmental provisions, legal provisions, or any other IAS 37
  // obligation type added later.
  const provisionsByType = {};
  for (const row of provisionRows) {
    const type = row.Liability_Type || "Other";
    if (!provisionsByType[type]) provisionsByType[type] = { count: 0, totalOutstanding: 0, rows: [] };
    provisionsByType[type].count += 1;
    provisionsByType[type].totalOutstanding = round2(provisionsByType[type].totalOutstanding + Number(row.Net_Amount || 0));
    provisionsByType[type].rows.push({ id: row.Liability_id, outstanding: round2(Number(row.Net_Amount || 0)) });
  }
  const totalProvisions = round2(provisionRows.reduce((sum, r) => sum + Number(r.Net_Amount || 0), 0));

  // Total carrying value of active assets — the denominator for the
  // coverage ratio. Computed here rather than calling getAssetsSummary
  // to avoid an extra module dependency in a read-only reporting layer.
  const totalAssetCarryingValue = round2(
    activeAssets.reduce((sum, a) => {
      const carrying = a.Carrying_Amount != null
        ? Number(a.Carrying_Amount)
        : Number(a.Cost_Amount || 0) - Number(a.Accumulated_Depreciation || 0) - Number(a.Accumulated_Impairment || 0);
      return sum + carrying;
    }, 0)
  );

  // riskCoverageRatio: 1.0 means fully covered at carrying value.
  // > 1.0 means over-insured (premiums wasted). < 1.0 means a gap.
  // null if no assets exist yet (avoids divide-by-zero showing as Infinity).
  const riskCoverageRatio = totalAssetCarryingValue > 0
    ? round2(totalCoverageAmount / totalAssetCarryingValue)
    : null;

  return {
    activePolicies,
    activePoliciesCount: activePolicies.length,
    closedPoliciesCount: closed.length,
    totalCoverageAmount,
    totalPremiumsDue,
    expiringWithin30Days,
    expiringCount: expiringWithin30Days.length,
    highRiskPolicies,
    highRiskCount: highRiskPolicies.length,
    provisionsByType,
    totalProvisions,
    totalAssetCarryingValue,
    riskCoverageRatio,
    // A risk position that has no active policies and no provisions is
    // genuinely exposed — the owner should see this clearly, not infer
    // it from zeros.
    isUninsured: activePolicies.length === 0,
    hasUnprovisionedRisk: provisionRows.length === 0 && closed.length > 0,
  };
}

module.exports = { getRiskPosition };
