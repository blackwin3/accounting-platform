/**
 * capital_management.js — a coordination/reporting layer over funds.js,
 * investments.js, and rentalInvestments.js. Deliberately does NOT post
 * anything itself, and does not replace any of those three modules —
 * each keeps posting independently through its own proven functions.
 * This file only reads what they've already posted and assembles one
 * coherent picture of where the business's capital actually sits: cash
 * on hand, Owner Capital injected vs withdrawn, outstanding loans,
 * Money-market investments, and rental property carrying value.
 *
 * Built to feed Money > Funds' "Unit Income" performance view and any
 * future capital-approval surface on the Staff/Users page — the reason
 * this exists as its own file rather than another dashboard route is so
 * the same aggregation logic can be reused by both without duplicating
 * the underlying account/Money/Assets queries.
 */

const { prisma, round2, computeAccountBalance } = require("./core");

/**
 * getCapitalPosition — the actual current state of the business's
 * capital, genuinely computed from Journal/Money/Assets each time, not
 * a cached or stored figure — matching the "never trust a running
 * total" discipline the rest of this system already follows.
 */
async function getCapitalPosition({ entrepriseId }) {
  if (!entrepriseId) throw new Error("entrepriseId is required");

  return prisma.$transaction(async (tx) => {
    // Cash on hand — Cash/Till, Mobile Money, Bank, whatever exists.
    const cashCodes = ["1000", "1010", "1020"];
    let cashOnHand = 0;
    const cashByAccount = {};
    for (const code of cashCodes) {
      const codeRow = await tx.Account_codes.findFirst({ where: { Code: code, Entreprise_id: entrepriseId } });
      if (!codeRow) continue;
      const account = await tx.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
      if (!account) continue;
      const balance = await computeAccountBalance(tx, account.Account_id, "DEBIT");
      cashByAccount[account.Account_Name] = balance;
      cashOnHand += balance;
    }

    // Owner Capital — net of every injection and withdrawal, genuinely
    // summed from the Equity table itself (postFunding writes positive
    // rows, postCapitalWithdrawal writes negative ones), not re-derived
    // from Journal, since Equity is the authoritative source per this
    // schema's own Account.Authoritative_Source convention.
    // Equity rows for this business — query via Account_id linkage since
    // Entreprise_id may not exist on the Equity table yet (migration 22).
    const businessAccounts = await tx.Account.findMany({
      where: { Entreprise_id: entrepriseId },
      select: { Account_id: true },
    });
    const accountIds = businessAccounts.map(a => a.Account_id);

    let equityRows;
    try {
      equityRows = await tx.Equity.findMany({ where: { Equity_type: { in: ["Owner Capital", "Owner Capital Withdrawal"] }, Entreprise_id: entrepriseId } });
    } catch {
      // Fallback: Entreprise_id column doesn't exist yet — filter by account
      equityRows = await tx.Equity.findMany({ where: { Equity_type: { in: ["Owner Capital", "Owner Capital Withdrawal"] }, Account_id: { in: accountIds } } });
    }
    const ownerCapitalNet = round2(equityRows.reduce((sum, e) => sum + Number(e.Net_Amount || 0), 0));
    const ownerCapitalInjected = round2(equityRows.filter((e) => Number(e.Net_Amount) > 0).reduce((sum, e) => sum + Number(e.Net_Amount), 0));
    const ownerCapitalWithdrawn = round2(Math.abs(equityRows.filter((e) => Number(e.Net_Amount) < 0).reduce((sum, e) => sum + Number(e.Net_Amount), 0)));

    // Outstanding loans — live Liability rows, Loan type, still owed.
    const loanRows = await tx.Liability.findMany({ where: { Liability_Type: "Loan", Net_Amount: { gt: 0 }, Entreprise_id: entrepriseId } });
    const loansOutstanding = round2(loanRows.reduce((sum, l) => sum + Number(l.Net_Amount || 0), 0));

    // Money-market investments — active MONEY_MARKET Money rows.
    const investmentRows = await tx.Money.findMany({ where: { Instrument_type: "MONEY_MARKET", Money_Status: "ACTIVE", Entreprise_id: entrepriseId } });
    const investmentsHeld = round2(investmentRows.reduce((sum, m) => sum + Number(m.Principal_amount || 0), 0));

    // Rental property — carrying value (cost minus accumulated
    // depreciation) of Assets marked Is_Rental_Property.
    const rentalAssets = await tx.Assets.findMany({ where: { Is_Rental_Property: 1, Entreprise_id: entrepriseId } });
    const rentalPropertyCarryingValue = round2(
      rentalAssets.reduce((sum, a) => sum + (Number(a.Cost_Amount || 0) - Number(a.Accumulated_Depreciation || 0)), 0)
    );
    const rentalPropertyCount = rentalAssets.length;
    const rentalPropertiesWithTenant = rentalAssets.filter((a) => a.Tenant_Stakeholder_id).length;

    const totalCapitalDeployed = round2(cashOnHand + investmentsHeld + rentalPropertyCarryingValue);

    return {
      cashOnHand: round2(cashOnHand),
      cashByAccount,
      ownerCapitalNet,
      ownerCapitalInjected,
      ownerCapitalWithdrawn,
      loansOutstanding,
      investmentsHeld,
      investmentCount: investmentRows.length,
      rentalPropertyCarryingValue,
      rentalPropertyCount,
      rentalPropertiesWithTenant,
      totalCapitalDeployed,
    };
  });
}

module.exports = { getCapitalPosition };
