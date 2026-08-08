/**
 * rentalInvestments.js — Rental Property as one of two real "Investment"
 * paths, alongside Money Market (bonds/shares, already handled by
 * investments.js). A rental property is a tangible physical asset that
 * generates recurring income, genuinely different in kind from an
 * intangible financial instrument — treating both as "Investments" is
 * economically correct (both are money put into something expecting a
 * return), but the accounting shape underneath them is not the same,
 * so this deliberately reuses postAssetPurchase (real depreciation,
 * disposal, the whole Assets lifecycle already proven correct
 * elsewhere) rather than forcing a rental property through the Money
 * Market's Instrument-row shape, which has no concept of depreciation
 * at all.
 *
 * Rent collection itself is NOT duplicated here — postUnitIncome
 * already accepts stakeholderId, so a tenant is correctly attributed
 * the moment rent is actually collected, through the existing Funds
 * flow. This file's only real job is connecting a purchased Asset to
 * its Tenant and agreed rent, so that collection has a real record to
 * point back to.
 */

const { prisma, PostingError, round2 } = require("./core");
const { postAssetPurchase } = require("./assets");

/**
 * postRentalPropertyPurchase — acquires a rental property as a genuine
 * Asset (cost, useful life, depreciation — reusing postAssetPurchase
 * exactly as any other asset purchase would work), then attaches the
 * Tenant and agreed monthly rent to the resulting Assets row. The
 * tenant/rent attachment is a record of the agreement, not a posting —
 * collecting rent is still its own separate, real event each time
 * (see collectRent below), the same discipline this system applies to
 * every recurring arrangement (a Provision is not the same as paying
 * the bill; an agreed rent is not the same as a receipt).
 */
async function postRentalPropertyPurchase(input) {
  const { name, cost, usefulLifeYears, residualValue = 0, depreciationMethod = "STRAIGHT_LINE", paymentMethod = "CASH", tenantStakeholderId = null, monthlyRent = null, administrationId = null, businessUnit = "RENTAL", entrepriseId } = input;

  if (tenantStakeholderId) {
    const tenant = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(tenantStakeholderId) } });
    if (!tenant || tenant.Entreprise_id !== entrepriseId) throw new PostingError("Tenant not found for this business");
    if (tenant.Stakeholder_Role !== "Tenant") throw new PostingError('The selected Stakeholder must have Stakeholder_Role = "Tenant"');
  }
  if (monthlyRent != null && Number(monthlyRent) < 0) throw new PostingError("Monthly rent cannot be negative");

  // The real acquisition — genuinely the same accounting event as
  // buying any other fixed asset (a vehicle, a till), just for a
  // property instead. No duplicated posting logic; this IS the posting.
  const result = await postAssetPurchase({
    name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, administrationId, businessUnit, entrepriseId,
  });

  // Attach the rental-specific facts to the Assets row postAssetPurchase
  // already created and returned directly — no need to re-query for it.
  // Not itself a Journal-affecting change — the schema simply had no
  // field to record "this asset is a rental property with this tenant"
  // before migration 16, and postAssetPurchase correctly knows nothing
  // about tenants (an ordinary vehicle purchase shouldn't need to reason
  // about rental concepts at all).
  await prisma.Assets.update({
    where: { Assets_id: result.asset.Assets_id },
    data: {
      Is_Rental_Property: 1,
      Tenant_Stakeholder_id: tenantStakeholderId ? Number(tenantStakeholderId) : null,
      Monthly_Rent: monthlyRent != null ? round2(Number(monthlyRent)) : null,
    },
  });

  return result;
}

/**
 * assignTenant — links (or re-links, e.g. a new tenant moving in) an
 * existing rental property to a Tenant and its agreed rent, without
 * requiring a fresh purchase. Genuinely no posting — this is a change
 * to the agreement on record, not a financial event.
 */
async function assignTenant(input) {
  const { assetsId, tenantStakeholderId, monthlyRent, entrepriseId } = input;
  if (!entrepriseId) throw new PostingError("entrepriseId is required");
  if (!assetsId) throw new PostingError("assetsId is required");

  const assetRow = await prisma.Assets.findUnique({ where: { Assets_id: Number(assetsId) } });
  if (!assetRow) throw new PostingError("Asset not found");
  if (!assetRow.Is_Rental_Property) throw new PostingError("This asset isn't marked as a rental property");

  if (tenantStakeholderId) {
    const tenant = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(tenantStakeholderId) } });
    if (!tenant || tenant.Entreprise_id !== entrepriseId) throw new PostingError("Tenant not found for this business");
    if (tenant.Stakeholder_Role !== "Tenant") throw new PostingError('The selected Stakeholder must have Stakeholder_Role = "Tenant"');
  }
  if (monthlyRent != null && Number(monthlyRent) < 0) throw new PostingError("Monthly rent cannot be negative");

  return prisma.Assets.update({
    where: { Assets_id: assetRow.Assets_id },
    data: {
      Tenant_Stakeholder_id: tenantStakeholderId ? Number(tenantStakeholderId) : null,
      Monthly_Rent: monthlyRent != null ? round2(Number(monthlyRent)) : assetRow.Monthly_Rent,
    },
  });
}

module.exports = { postRentalPropertyPurchase, assignTenant };
