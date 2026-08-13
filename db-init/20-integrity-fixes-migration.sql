-- Migration 20: Integrity fixes from outstanding assessment items
-- Addresses items 1-10 from the open list (excluding Journal grouping)

-- 1. IFRS framework declaration: handled in seed.js (Structures row)
--    No schema change needed — seedAccountingRules will create it.

-- 2. Cycle_id/Cycle_stage: add a non-unique index for query performance
--    (full uniqueness is too strict — parallel branches are valid)
CREATE INDEX IF NOT EXISTS "idx_transactions_cycle_stage"
  ON "Transactions" ("Cycle_id", "Cycle_stage");

-- 3. Business_Unit controlled vocabulary: enforce via CHECK constraint
--    on Transactions (the authoritative source — other tables inherit)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_transactions_business_unit'
  ) THEN
    ALTER TABLE "Transactions" ADD CONSTRAINT "chk_transactions_business_unit"
      CHECK ("Business_Unit" IN ('SHOP','FARM','HERD','CATTLE','RENTAL','INVESTMENTS','TEACHING','OTHER'));
  END IF;
END $$;

-- 8. Resource_Mode — add to Resources for semantic clarity
ALTER TABLE "Resources" ADD COLUMN IF NOT EXISTS "Resource_Mode" VARCHAR(15) NULL;
-- QUANTITY / SERIALIZED / LOT / PROPERTY / BIOLOGICAL / FINANCIAL

-- 9. Status enforcement: make Resource_Class a CHECK constraint
-- (already exists as free text — add CHECK for new inserts)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_resources_class'
  ) THEN
    ALTER TABLE "Resources" ADD CONSTRAINT "chk_resources_class"
      CHECK ("Resource_Class" IN (
        'INVENTORY','FIXED_ASSET','CONSUMABLE','FINANCIAL_ASSET',
        'DIGITAL_CREDIT','BIOLOGICAL_ASSET','SERVICE','LAND','BUILDING',
        'BEARER_PLANT',NULL
      ));
  END IF;
END $$;

-- 10. Money.Payment_id circular FK — drop it
-- Keep Payment.Money_id (the correct one-to-many direction)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_Money_fk_Mony_Paymnt_1' AND table_name = 'Money'
  ) THEN
    ALTER TABLE "Money" DROP CONSTRAINT "fk_Money_fk_Mony_Paymnt_1";
  END IF;
END $$;
-- Column stays (backward compat) but FK removed — no longer circular
