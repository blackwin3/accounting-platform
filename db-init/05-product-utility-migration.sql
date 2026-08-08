-- Additive migration: utility and billing-cycle awareness on Product.
-- Distinguishes a can of sugar (Goods, inventory+COGS) from a plumber
-- visit (Services, one-time expense) from electricity tokens (Utility,
-- prepaid, consumed over time) from water (Utility, recurring monthly)
-- from garbage collection (Utility, reducing-balance prepaid lump sum).
-- Safe to run on the existing seeded database.
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/05-product-utility-migration.sql

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "Is_Utility" SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "Billing_Cycle" VARCHAR(20);

COMMENT ON COLUMN "Product"."Is_Utility" IS '1 = this product/service is a utility (electricity, water, garbage, internet) with its own consumption cycle rather than simple inventory or a one-time expense';
COMMENT ON COLUMN "Product"."Billing_Cycle" IS 'ONE_TIME / PREPAID_TOKEN / MONTHLY / PREPAID_REDUCING — governs how the expense wizard treats this item: ONE_TIME expenses immediately, PREPAID_TOKEN and PREPAID_REDUCING create a prepaid asset consumed over time, MONTHLY is a straightforward recurring bill';
