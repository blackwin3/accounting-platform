-- Multi-tenancy foundation: adds Entreprise_id (FK to Organisation) to
-- every business-owned table, so more than one business can safely share
-- this database without their data mixing. Existing data is backfilled
-- under the current Organisation row — nothing is lost or orphaned.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/06-multi-tenancy-migration.sql
--
-- IMPORTANT: run this only after confirming exactly one row exists in
-- "Organisation" (docker exec -i accounting_db psql -U autarch -d family_accounting -c 'SELECT * FROM "Organisation";').
-- The backfill assumes a single existing business.

DO $$
DECLARE
  org_id INT;
BEGIN
  SELECT "Entreprise_id" INTO org_id FROM "Organisation" ORDER BY "Entreprise_id" ASC LIMIT 1;

  IF org_id IS NULL THEN
    RAISE NOTICE 'No Organisation row found — skipping backfill. New Entreprise_id columns will be added but left NULL; the next Sign Up will create the first scoped business.';
  END IF;

  -- Management: login accounts. This is the most important one — every
  -- session's req.currentUser.Entreprise_id comes from here.
  ALTER TABLE "Management" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Management" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Stakeholder" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Stakeholder" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Product" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Structures" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Structures" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Catalogue" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Catalogue" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Account" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Account_codes" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Account_codes" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Transactions" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Transactions" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Journal" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Journal" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Records" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Records" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Resources" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Resources" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Assets" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Assets" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Money" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Money" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Liability" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Liability" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Income" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Income" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Expenditure" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Expenditure" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Documents" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Documents" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Evidence" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Evidence" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Narrative" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Narrative" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Knowledge" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Knowledge" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

  ALTER TABLE "Reports" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT;
  IF org_id IS NOT NULL THEN
    UPDATE "Reports" SET "Entreprise_id" = org_id WHERE "Entreprise_id" IS NULL;
  END IF;

END $$;

-- Username must be unique per business, not globally — two different
-- businesses each wanting a user named "daniel" is a normal, expected case.
ALTER TABLE "Management" DROP CONSTRAINT IF EXISTS "Management_Username_key";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_management_username_per_org" ON "Management" ("Entreprise_id", "Username") WHERE "Username" IS NOT NULL;

-- Indexes for the new scoping column on the highest-traffic tables
CREATE INDEX IF NOT EXISTS "idx_management_entreprise" ON "Management" ("Entreprise_id");
CREATE INDEX IF NOT EXISTS "idx_product_entreprise" ON "Product" ("Entreprise_id");
CREATE INDEX IF NOT EXISTS "idx_structures_entreprise" ON "Structures" ("Entreprise_id");
CREATE INDEX IF NOT EXISTS "idx_transactions_entreprise" ON "Transactions" ("Entreprise_id");
CREATE INDEX IF NOT EXISTS "idx_journal_entreprise" ON "Journal" ("Entreprise_id");
CREATE INDEX IF NOT EXISTS "idx_records_entreprise" ON "Records" ("Entreprise_id");
