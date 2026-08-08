-- Additive migration: login credentials for Management (Owner/Accountant/Advisor/Cashier).
-- Safe to run on the existing seeded database — does not drop or modify existing rows.
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/03-auth-migration.sql

ALTER TABLE "Management"
  ADD COLUMN IF NOT EXISTS "Username" VARCHAR(45) UNIQUE,
  ADD COLUMN IF NOT EXISTS "Password_Hash" VARCHAR(255);

CREATE INDEX IF NOT EXISTS "idx_management_username" ON "Management" ("Username");
