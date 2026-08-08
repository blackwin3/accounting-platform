-- Additive migration: Report_Status on Reports.
--
-- Reports already has Report_Stage (position in the accounting close
-- chain: TRIAL_BALANCE_UNADJUSTED -> ... -> BALANCE_SHEET). That's a
-- different concern from whether a specific generated report has been
-- reviewed, approved, or issued to someone outside the system (a bank, an
-- accountant, a successor). Without this column, every report the app
-- generates reads as equally authoritative the moment it's created, which
-- is misleading for anything meant to leave the system as evidence.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/07-report-status-migration.sql

ALTER TABLE "Reports"
  ADD COLUMN IF NOT EXISTS "Report_Status" VARCHAR(20) DEFAULT 'DRAFT';

COMMENT ON COLUMN "Reports"."Report_Status" IS 'Review/approval lifecycle, independent of Report_Stage (position in the close chain): DRAFT = just generated, not yet reviewed by anyone. GENERATED = same as DRAFT, kept for compatibility with systems that use this term. REVIEWED = an accountant or advisor has looked at it. APPROVED = the owner has signed off. ISSUED = shared outside the system (e.g. given to a bank or a successor). SUPERSEDED = a later report has replaced this one for the same period/stage. A report being generated does not mean it is correct or final — Report_Status tracks how far it has actually been through review, separately from Is_Adjusted and Report_Stage which track its position in the accounting chain.';

CREATE INDEX IF NOT EXISTS "idx_reports_status" ON "Reports" ("Report_Status");
