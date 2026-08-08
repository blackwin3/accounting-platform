-- Additive migration: Is_Discontinued on Product.
--
-- A product that has already been used in a real Transaction can never be
-- safely edited or deleted — its Product_Cost and Product_Name are baked
-- into historical Journal narratives, COGS calculations, and Resources
-- history. Correcting a genuine data-entry mistake (wrong price typed,
-- wrong name) is only safe for a product that has never actually been
-- posted against. Once used, the only safe action is to discontinue it —
-- hide it from the Till and new purchases, while every past transaction
-- referencing it stays exactly as it was.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/11-product-discontinued-migration.sql

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "Is_Discontinued" SMALLINT DEFAULT 0;

COMMENT ON COLUMN "Product"."Is_Discontinued" IS '1 = no longer sold or purchased — hidden from the Till and Products creation flows, but every past Transaction, Journal entry, and Resources record referencing this product is untouched. The correct action once a product has any transaction history, instead of editing or deleting it.';

CREATE INDEX IF NOT EXISTS "idx_product_discontinued" ON "Product" ("Is_Discontinued");
