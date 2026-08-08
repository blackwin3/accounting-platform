-- Additive migration: the business as LESSOR — renting things out from
-- its own inventory or owned equipment, rather than the existing
-- postLeaseCommencement, which is exclusively the business as LESSEE
-- (renting something IN, e.g. shop premises). Genuinely the opposite
-- direction, with its own accounting shape (Operating Lease Income, not
-- a Right-of-Use asset).
--
-- Two distinct paths, matching how a business actually holds the item:
--   A. Inventory temporarily leased (a car dealership's car — a specific
--      Goods unit, checked out instead of sold, returns to stock later)
--   B. Owned equipment repeatedly rented out (a hardware shop's heavy
--      machinery — one Assets row, cycling through many renters over
--      its working life, distinct from a rental property's one
--      long-term tenant)
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/17-lessor-migration.sql

-- Path A: a Goods unit can now genuinely be "leased out" rather than
-- only ever AVAILABLE, RESERVED, DAMAGED, EXPIRED, or SOLD.
COMMENT ON COLUMN "Resources"."Resources_Status" IS 'AVAILABLE/RESERVED/DAMAGED/EXPIRED/SOLD/LEASED_OUT — LEASED_OUT added for inventory temporarily rented out rather than sold (e.g. a car dealership leasing a specific vehicle): the unit stays owned and eventually returns to AVAILABLE, unlike SOLD.';

-- Path B: owned equipment repeatedly rented — genuinely different from
-- rentalInvestments.js's Is_Rental_Property (one property, one
-- long-term tenant at a time). Equipment_For_Hire marks an Asset as
-- available for repeat short-term rental; the CURRENT renter (if any)
-- is tracked the same way a rental property tracks its current tenant,
-- but the history of past renters lives in Money rows (one per rental
-- period), not as a single ongoing relationship.
ALTER TABLE "Assets"
  ADD COLUMN IF NOT EXISTS "Equipment_For_Hire" SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "Current_Renter_Stakeholder_id" INT NULL,
  ADD COLUMN IF NOT EXISTS "Daily_Hire_Rate" DECIMAL(15,2) NULL;

COMMENT ON COLUMN "Assets"."Equipment_For_Hire" IS '1 = this Asset is owned equipment made available for repeat short-term hire (a hardware shop''s heavy machinery) — distinct from Is_Rental_Property (rentalInvestments.js), which is a single property with one long-term tenant. Equipment_For_Hire cycles through many different renters over its life.';
COMMENT ON COLUMN "Assets"."Current_Renter_Stakeholder_id" IS 'The Stakeholder currently hiring this equipment, if any. Null when the equipment is sitting idle/available. Changes with every new hire, unlike a rental property''s tenant, which is expected to stay stable for a long period.';
COMMENT ON COLUMN "Assets"."Daily_Hire_Rate" IS 'KES per day for this specific piece of equipment. Distinct from Monthly_Rent (rentalInvestments.js), which is a property''s monthly figure — hire equipment is naturally priced per day or per job, not per month.';

CREATE INDEX IF NOT EXISTS "idx_assets_renter" ON "Assets" ("Current_Renter_Stakeholder_id");
