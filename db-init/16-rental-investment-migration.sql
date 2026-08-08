-- Additive migration: links a purchased Asset to a Tenant, so a rental
-- property genuinely has a home for its recurring rent-income stream to
-- point at — the real gap behind treating "Rental" as an Investment
-- type: this system already had postAssetPurchase (real Asset with
-- depreciation) and postUnitIncome's RENT income type, but nothing
-- connected a specific asset to the specific tenant paying for it.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/16-rental-investment-migration.sql

ALTER TABLE "Assets"
  ADD COLUMN IF NOT EXISTS "Tenant_Stakeholder_id" INT NULL,
  ADD COLUMN IF NOT EXISTS "Is_Rental_Property" SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "Monthly_Rent" DECIMAL(15,2) NULL;

COMMENT ON COLUMN "Assets"."Tenant_Stakeholder_id" IS 'The Stakeholder (Stakeholder_Role=Tenant) currently renting this asset, if it is a rental property. Null for every other kind of asset, and null for a rental property between tenants.';
COMMENT ON COLUMN "Assets"."Is_Rental_Property" IS '1 = this asset genuinely generates rental income (a house, a room, equipment let out) — distinct from an ordinary business asset like a till or a vehicle. Drives whether the asset appears on the Investments page''s Rental Property list.';
COMMENT ON COLUMN "Assets"."Monthly_Rent" IS 'The agreed recurring rent for this property, KES/month. A record of the agreement, not a posting — an actual rent receipt is still its own real event through postUnitIncome each time it is genuinely collected, the same discipline this system uses everywhere: an agreed figure is not the same fact as a collected one.';

CREATE INDEX IF NOT EXISTS "idx_assets_tenant" ON "Assets" ("Tenant_Stakeholder_id");
