-- Additive migration: extends the individual livestock register (13) to
-- cover plants/crops too, plus genuine growth-stage tracking and parent
-- lineage for births — "Agriculture and Livestock" rather than
-- "Livestock" alone.
--
-- Animal_Tag from migration 13 is kept exactly as-is (no rename, no
-- data migration needed) — a crop bed's tag is written to the same
-- column, since both are fundamentally the same concept: a
-- human-assigned identifier for one individually-tracked biological
-- asset, whether it walks or grows in the ground. The column name stays
-- historically accurate to what it was built for first; the comment
-- below documents the wider use.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/14-agriculture-livestock-migration.sql

ALTER TABLE "Resources"
  ADD COLUMN IF NOT EXISTS "Growth_Stage" VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS "Parent_Resources_id" INT NULL;

COMMENT ON COLUMN "Resources"."Animal_Tag" IS 'A herder or farmer-assigned identifier for one individually-tracked biological asset — an ear-tag number for an animal, a bed/row number for a crop planting. Only meaningful when Resource_Class=BIOLOGICAL_ASSET and Resources_Quantity=1. Null for ordinary fungible stock. Named for its original livestock use; also used for individually-tracked plants since migration 14.';
COMMENT ON COLUMN "Resources"."Growth_Stage" IS 'Where this individual animal or planting is in its own lifecycle — e.g. NEWBORN/JUVENILE/ADULT for an animal, or SEEDLING/GROWING/MATURE/HARVESTED for a crop. Free text by design: the real stages differ genuinely by species and this system has no fixed list to impose. Distinct from Resources_Status, which is the accounting/operational state (AVAILABLE/SOLD/LOST) rather than the biological one.';
COMMENT ON COLUMN "Resources"."Parent_Resources_id" IS 'For an animal born on the register (not purchased/registered independently): the mother''s own Resources row. Null for a purchased or independently-registered animal/planting with no tracked parent. Self-referencing — lets a birth be recorded as a real, traceable event rather than an animal appearing from nowhere.';

CREATE INDEX IF NOT EXISTS "idx_resources_parent" ON "Resources" ("Parent_Resources_id");
