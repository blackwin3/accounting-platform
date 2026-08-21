-- Migration 23: Fix historical unbalanced journal groups
-- These were created before the Journal_Entry_Group fix (each DR and CR
-- got a different group ID because Date.now() changed between calls).
-- Fix: for each transaction that has journal entries with DIFFERENT groups
-- but matching transaction IDs, merge them into one group.

DO $$
DECLARE
  r RECORD;
  new_group TEXT;
BEGIN
  -- Find transactions with multiple different journal groups
  FOR r IN
    SELECT "Transactions_id", MIN("Journal_Entry_Group") as keep_group
    FROM "Journal"
    WHERE "Journal_Entry_Group" IS NOT NULL
    AND "Transactions_id" IS NOT NULL
    GROUP BY "Transactions_id"
    HAVING COUNT(DISTINCT "Journal_Entry_Group") > 1
  LOOP
    -- Merge all entries for this transaction into the earliest group
    UPDATE "Journal"
    SET "Journal_Entry_Group" = r.keep_group
    WHERE "Transactions_id" = r."Transactions_id"
    AND "Journal_Entry_Group" != r.keep_group;
  END LOOP;
END $$;
