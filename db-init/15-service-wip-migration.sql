-- Additive migration: work-in-progress tracking for genuine effort-based
-- Services (carpentry, consulting, repair work) — distinct from a
-- Utility (electricity, water, internet), which already has its own
-- instant-purchase consumption cycle via Is_Utility and needs no change
-- here. A Service with Is_Utility=0 is the one that genuinely benefits
-- from a running hours/value tally rather than being bought and
-- consumed in one instant Till transaction.
--
-- Reuses Resources the same way livestock/crops do (migrations 13-14):
-- one Resources row per service engagement (Resources_Quantity always
-- 1 — this is a single piece of work, not fungible stock), with
-- Resource_Class=WORK_IN_PROGRESS as the IFRS 15 (Revenue from
-- Contracts with Customers) analogue to BIOLOGICAL_ASSET's IAS 41 — a
-- distinct classification precisely so this system's existing
-- rule-triggering pattern (Resource_Class -> which standard applies)
-- extends correctly rather than overloading BIOLOGICAL_ASSET for
-- something that isn't a living thing.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/15-service-wip-migration.sql

ALTER TABLE "Resources"
  ADD COLUMN IF NOT EXISTS "Hourly_Rate" DECIMAL(15,2) NULL,
  ADD COLUMN IF NOT EXISTS "Hours_Logged" DECIMAL(15,2) NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "Service_Client" VARCHAR(100) NULL;

COMMENT ON COLUMN "Resources"."Hourly_Rate" IS 'KES per hour for this specific service engagement — only meaningful when Resource_Class=WORK_IN_PROGRESS. Rates genuinely vary per engagement (a rush job may be billed higher than routine work), so this lives on the individual Resources row, not the Product.';
COMMENT ON COLUMN "Resources"."Hours_Logged" IS 'Running total of hours logged against this engagement so far. Fair_Value (already on Resources from migration 13) = Hours_Logged x Hourly_Rate, recomputed each time hours are logged — the same "declared, not populated until used" field this system reuses everywhere rather than inventing a duplicate.';
COMMENT ON COLUMN "Resources"."Service_Client" IS 'Free text — who this engagement is for, when it is not worth creating a full Stakeholder row (a one-off repair job, a small consulting task). Optional; a genuine customer relationship should still use Stakeholder where it exists.';
