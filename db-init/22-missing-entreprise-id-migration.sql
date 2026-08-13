-- Migration 22: Add Entreprise_id to tables that were missed in migration 06
-- These tables are referenced with Entreprise_id filters in the code but
-- the column was never added to the schema.

ALTER TABLE "Equity" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT NULL;
CREATE INDEX IF NOT EXISTS "idx_equity_entreprise" ON "Equity" ("Entreprise_id");

ALTER TABLE "Equity" ADD COLUMN IF NOT EXISTS "Equity_type" VARCHAR(45) NULL;

ALTER TABLE "Ledger" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT NULL;
CREATE INDEX IF NOT EXISTS "idx_ledger_entreprise" ON "Ledger" ("Entreprise_id");

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT NULL;
CREATE INDEX IF NOT EXISTS "idx_payment_entreprise" ON "Payment" ("Entreprise_id");

ALTER TABLE "Account_History" ADD COLUMN IF NOT EXISTS "Entreprise_id" INT NULL;
CREATE INDEX IF NOT EXISTS "idx_account_history_entreprise" ON "Account_History" ("Entreprise_id");

-- Backfill existing rows: derive Entreprise_id from linked tables
UPDATE "Equity" e SET "Entreprise_id" = (
  SELECT a."Entreprise_id" FROM "Account" a WHERE a."Account_id" = e."Account_id" LIMIT 1
) WHERE e."Entreprise_id" IS NULL AND e."Account_id" IS NOT NULL;

UPDATE "Ledger" l SET "Entreprise_id" = (
  SELECT j."Entreprise_id" FROM "Journal" j WHERE j."Journal_id" = l."Journal_id" LIMIT 1
) WHERE l."Entreprise_id" IS NULL AND l."Journal_id" IS NOT NULL;

UPDATE "Payment" p SET "Entreprise_id" = (
  SELECT t."Entreprise_id" FROM "Transactions" t WHERE t."Transactions_id" = p."Transactions_id" LIMIT 1
) WHERE p."Entreprise_id" IS NULL AND p."Transactions_id" IS NOT NULL;
