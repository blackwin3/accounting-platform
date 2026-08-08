-- Additive migration: Validation_Tier on LogicConditions.
--
-- Every rule this system enforces genuinely falls into one of three
-- distinct kinds of question, in a fixed order a real accounting review
-- would ask them:
--   BUSINESS     — does this make operational sense? (product exists,
--                  enough stock, customer exists) — none of this system's
--                  current rules are actually at this tier yet; it exists
--                  so future rules have a real place to declare it.
--   ACCOUNTING   — is the books-keeping itself sound? (period open,
--                  accounts active, journal balanced) — this is what
--                  "Closed Period Entry Block" and "Double Entry Balance
--                  Check" already are, just never labelled as a tier.
--   COMPLIANCE   — does this satisfy a named standard? (IAS 16, IFRS 9,
--                  IFRS 15) — this is what "Loan Amortization Discipline"
--                  and the IAS 1 / IAS 7 rules already are.
--
-- No existing column captures this — Logic_type (VALIDATION/REPORTING) is
-- a different axis (what kind of check this is), and Review_Level is a
-- different axis again (who approves it). This is genuinely new
-- information, not a repurposing of something already there.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/10-logic-conditions-tier-migration.sql

ALTER TABLE "LogicConditions"
  ADD COLUMN IF NOT EXISTS "Validation_Tier" VARCHAR(15) DEFAULT 'ACCOUNTING';

COMMENT ON COLUMN "LogicConditions"."Validation_Tier" IS 'BUSINESS = does this make operational sense (product exists, stock available, customer exists). ACCOUNTING = is the books-keeping itself sound (period open, journal balanced, accounts active). COMPLIANCE = does this satisfy a named standard (IAS 16, IFRS 9, IFRS 15, tax). A real posting is expected to pass all three tiers in order — business sense first, then bookkeeping soundness, then standard compliance — the same order a human accountant would actually check them in.';

CREATE INDEX IF NOT EXISTS "idx_logicconditions_tier" ON "LogicConditions" ("Validation_Tier");
