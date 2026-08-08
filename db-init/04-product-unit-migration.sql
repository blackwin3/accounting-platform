-- Additive migration: Business_Unit on Product, enabling per-unit catalog
-- filtering (Shop sugar vs Farm milk vs Rental "product" vs Investment
-- instruments). Safe to run on the existing seeded database.
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/04-product-unit-migration.sql

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "Business_Unit" VARCHAR(20);

CREATE INDEX IF NOT EXISTS "idx_product_business_unit" ON "Product" ("Business_Unit");

-- Backfill: every existing product defaults to SHOP, since that's the only
-- unit that existed before this migration.
UPDATE "Product" SET "Business_Unit" = 'SHOP' WHERE "Business_Unit" IS NULL;
