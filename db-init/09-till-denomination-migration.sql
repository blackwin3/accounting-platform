-- New table: Till_Denomination_Count
--
-- Tracks the physical cash-drawer breakdown by denomination (Kenyan
-- Shilling notes and coins) for a given business, on a given trading day.
-- Distinct from Records.Actual_Closing_Cash (a single total figure,
-- entered once at period close) — this is a live, editable count any
-- cashier can update through the day as change is given and received,
-- with the running total compared against the Cash account's actual
-- Journal-derived balance so a mismatch is visible immediately rather
-- than only discovered at end-of-day reconciliation.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/09-till-denomination-migration.sql

CREATE TABLE IF NOT EXISTS "Till_Denomination_Count" (
  "Till_Denomination_Count_id" SERIAL PRIMARY KEY,
  "Entreprise_id" INT NOT NULL,
  "Business_Unit" VARCHAR(20) NOT NULL,
  "Count_Date" DATE NOT NULL,
  "Count_1000" INT NOT NULL DEFAULT 0,
  "Count_500" INT NOT NULL DEFAULT 0,
  "Count_200" INT NOT NULL DEFAULT 0,
  "Count_100" INT NOT NULL DEFAULT 0,
  "Count_50" INT NOT NULL DEFAULT 0,
  "Count_40" INT NOT NULL DEFAULT 0,
  "Count_20" INT NOT NULL DEFAULT 0,
  "Count_10" INT NOT NULL DEFAULT 0,
  "Count_5" INT NOT NULL DEFAULT 0,
  "Count_1" INT NOT NULL DEFAULT 0,
  "Updated_By" INT NULL,
  "Updated_At" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fk_till_denomination_management" FOREIGN KEY ("Updated_By") REFERENCES "Management" ("Administration_id")
);

-- One count per business, per business unit, per day — updating "today's"
-- count is an upsert, not a fresh row every time someone recounts the drawer.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_till_denom_unique_day"
  ON "Till_Denomination_Count" ("Entreprise_id", "Business_Unit", "Count_Date");

COMMENT ON TABLE "Till_Denomination_Count" IS 'Physical cash-drawer breakdown by note/coin denomination, one row per business unit per trading day. Compared against the Cash account''s Journal-derived balance for real-time variance detection — a mismatch means either a miscounted drawer or an unrecorded transaction, and should be investigated the same day rather than only at formal period close.';
