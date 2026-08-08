/**
 * risks.js — the Risks & Insurance domain: recording insurance policies
 * held by the business. Matches the Claims > Risks & Insurance page,
 * which also monitors existing Provisions (built in
 * leasesAndProvisions.js) alongside insurance — both are ways the
 * business manages exposure to future loss, just through different
 * mechanisms (self-provisioning vs. transferring the risk to an insurer).
 */

const { prisma, PostingError, round2 } = require("./core");

/**
 * postInsurancePolicy — records a new insurance policy as a Money
 * instrument (Instrument_type=INSURANCE), for tracking coverage and
 * premium schedule. This function only records the policy's existence —
 * it does not itself move any money. Paying the first or any subsequent
 * premium is a separate action via postExpense(category: "INSURANCE"),
 * matching how every other recurring cost in this system is paid — a
 * policy and a premium payment are different events, not the same one.
 *
 * @param {Object} input
 * @param {string} input.name           - e.g. "Fire & Theft — Shop Premises"
 * @param {number} input.coverageAmount - the sum insured
 * @param {number} [input.premiumAmount] - typical premium, for reference only
 * @param {string} [input.startDate]
 * @param {string} [input.maturityDate] - policy renewal/expiry date
 * @param {string} [input.riskLevel]    - LOW/MEDIUM/HIGH, defaults to MEDIUM
 * @param {string} [input.riskNote]
 */
async function postInsurancePolicy(input) {
  const { name, coverageAmount, premiumAmount = null, startDate = null, maturityDate = null, riskLevel = "MEDIUM", riskNote = "", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!name || !name.trim()) throw new PostingError("Policy name is required");
  if (!coverageAmount || coverageAmount <= 0) throw new PostingError("Coverage amount must be positive");
  if (!["LOW", "MEDIUM", "HIGH"].includes(riskLevel)) throw new PostingError('riskLevel must be "LOW", "MEDIUM", or "HIGH"');

  // Anchor to the Cash account the same way other non-cash-moving Money
  // rows do (e.g. the seeded bonds) — the policy itself isn't tied to one
  // specific account, this just satisfies the NOT NULL Account_id.
  const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
  const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;
  if (!cashAccount) throw new PostingError("Cash account is not seeded for this business yet.");

  const policy = await prisma.Money.create({
    data: {
      Account_id: cashAccount.Account_id,
      Instrument_type: "INSURANCE",
      Money_Status: "ACTIVE",
      Risk_Level: riskLevel,
      Risk_note: riskNote || null,
      Money_Name: name.trim(),
      Principal_amount: round2(coverageAmount),
      Outstanding_Amount: premiumAmount ? round2(premiumAmount) : null,
      Start_date: startDate ? new Date(startDate) : new Date(),
      Maturity_date: maturityDate ? new Date(maturityDate) : null,
      Entreprise_id: entrepriseId,
    },
  });

  return { policy };
}

/**
 * closeInsurancePolicy — marks a policy as no longer active (lapsed,
 * cancelled, or not renewed). Does not move money — cancellation itself
 * has no cash effect in this simplified model; any refund would be
 * recorded separately via the existing income-recording functions.
 */
async function closeInsurancePolicy({ moneyId, entrepriseId }) {
  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  const policy = await prisma.Money.findUnique({ where: { Money_id: Number(moneyId) } });
  if (!policy || policy.Entreprise_id !== entrepriseId || policy.Instrument_type !== "INSURANCE") {
    throw new PostingError("Insurance policy not found");
  }
  return prisma.Money.update({ where: { Money_id: policy.Money_id }, data: { Money_Status: "CLOSED" } });
}

module.exports = { postInsurancePolicy, closeInsurancePolicy };
