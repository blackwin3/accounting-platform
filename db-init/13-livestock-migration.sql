-- Additive migration: individual livestock tracking on Resources.
--
-- Resources already declared Resource_Class=BIOLOGICAL_ASSET and
-- Fair_Value/Fair_Value_Date/Fair_Value_Basis for genuine IAS 41
-- measurement — none of it was ever used by any code, the same
-- "declared, not populated" pattern found repeatedly this session.
-- Individual animal tracking needs one Resources row per animal
-- (Resources_Quantity = 1 each), plus an ID tag and an age/birth date,
-- neither of which existed. Everything else genuinely reuses existing
-- fields: Resources_Quality for condition, Resources_Status for
-- lifecycle state, Resources_Manufacture_Date already works as a birth
-- date with no change needed.
--
-- Run manually once:
--   docker exec -i accounting_db psql -U autarch -d family_accounting < db-init/13-livestock-migration.sql

ALTER TABLE "Resources"
  ADD COLUMN IF NOT EXISTS "Animal_Tag" VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS "Animal_Sex" VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS "Last_Review_Date" DATE NULL;

COMMENT ON COLUMN "Resources"."Animal_Tag" IS 'A herder-assigned identifier for one individual animal (an ear-tag number, a name, or similar) — only meaningful when Resource_Class=BIOLOGICAL_ASSET and Resources_Quantity=1. Null for ordinary fungible stock.';
COMMENT ON COLUMN "Resources"."Animal_Sex" IS 'MALE / FEMALE — only meaningful for BIOLOGICAL_ASSET rows.';
COMMENT ON COLUMN "Resources"."Last_Review_Date" IS 'When this animal''s condition (Resources_Quality) and status (Resources_Status) were last checked and recorded — the "monthly review" date. Distinct from Fair_Value_Date, which tracks when the animal''s KES valuation was last reassessed; an animal can be reviewed for health without its valuation changing.';

CREATE INDEX IF NOT EXISTS "idx_resources_animal_tag" ON "Resources" ("Animal_Tag");
