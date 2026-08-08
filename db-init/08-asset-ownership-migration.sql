-- Additive migration: Ownership_Type on Assets.
--
-- Every asset this system has ever recorded (a vehicle, farm equipment,
-- the building a shop trades from) went straight into the register with
-- no boundary between "the business owns this outright," "the owner's
-- personal property that happens to also be used for the business," and
-- "jointly owned by more than one family member." For a family enterprise
-- specifically — the whole reason this system exists — that distinction
-- is not a nice-to-have. A vehicle used for both errands and deliveries,
-- a plot of land the family lives on and also farms, a laptop the owner
-- uses for both the shop's books and personal email: none of these are
-- unambiguously "business" or "personal," and treating them as if they
-- were is exactly the kind of category error that makes succession and
-- tax situations worse later, not simpler.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/08-asset-ownership-migration.sql

ALTER TABLE "Assets"
  ADD COLUMN IF NOT EXISTS "Ownership_Type" VARCHAR(20) DEFAULT 'BUSINESS';

COMMENT ON COLUMN "Assets"."Ownership_Type" IS 'BUSINESS = owned outright by the business, no personal claim. PERSONAL = the owner''s personal property recorded here only because it is used for the business (e.g. a personal vehicle also used for deliveries) — its inclusion on the business balance sheet should be reviewed by an accountant, not assumed correct by default. JOINT = owned jointly by more than one family member, business status undetermined. FAMILY = owned by the family as a whole rather than the business entity or one individual (e.g. ancestral land). Defaults to BUSINESS for backward compatibility with assets already recorded before this column existed — that default is a convenience, not a verified fact, and should be reviewed per asset rather than trusted.';

CREATE INDEX IF NOT EXISTS "idx_assets_ownership_type" ON "Assets" ("Ownership_Type");
