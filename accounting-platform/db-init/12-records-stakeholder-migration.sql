-- Additive migration: Stakeholder_id on Records.
--
-- A Till sale on credit, or a discount given, genuinely relates to a
-- specific person or business (which customer owes this, which supplier
-- gave this discount) — but nothing in this system could record that
-- relationship. Money already links a stakeholder to a rental tenant or
-- an investment counterparty; Records had no equivalent, so a Till
-- transaction's "who" was only ever describable in free text.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/12-records-stakeholder-migration.sql

ALTER TABLE "Records"
  ADD COLUMN IF NOT EXISTS "Stakeholder_id" INT NULL;

COMMENT ON COLUMN "Records"."Stakeholder_id" IS 'The customer, supplier, or other Stakeholder this batch of transactions relates to — most useful for a Credit sale (who owes this) or a Discount (who received it). Optional: most Till activity has no specific counterparty and this stays null.';

CREATE INDEX IF NOT EXISTS "idx_records_stakeholder" ON "Records" ("Stakeholder_id");
