-- Migration 19: Structural fixes from project assessments
-- Addresses the top 5 open schema items plus supporting fields

-- 1. Documents.Records_id — the missing FK that prevents
--    Receipt → Records → Transactions traceability
ALTER TABLE "Documents" ADD COLUMN IF NOT EXISTS "Records_id" INT NULL;
CREATE INDEX IF NOT EXISTS "idx_documents_records" ON "Documents" ("Records_id");

-- 2. Payment.Product_id — make nullable so non-product payments
--    (loan repayments, tax, rent, insurance) don't need a fake product
ALTER TABLE "Payment" ALTER COLUMN "Product_id" DROP NOT NULL;

-- 3. Payment.Transactions_id — the missing FK that makes payments
--    traceable through Transaction → Journal → Ledger
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "Transactions_id" INT NULL;
CREATE INDEX IF NOT EXISTS "idx_payment_transactions" ON "Payment" ("Transactions_id");

-- 4. Payment.Payment_Purpose — controlled vocabulary for what this
--    payment is actually settling, so not everything has to be a product
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "Payment_Purpose" VARCHAR(30) NULL;

-- 5. Stakeholder.Stakeholder_Type — distinguish person from organisation
ALTER TABLE "Stakeholder" ADD COLUMN IF NOT EXISTS "Stakeholder_Type" VARCHAR(20) NULL DEFAULT 'PERSON';

-- 6. LogicConditions.Rule_Status — versioning for rules that change
ALTER TABLE "LogicConditions" ADD COLUMN IF NOT EXISTS "Rule_Status" VARCHAR(15) NULL DEFAULT 'ACTIVE';

-- 7. File_Hash — extend for SHA-256 (64 chars hex)
ALTER TABLE "Documents" ALTER COLUMN "File_Hash" TYPE VARCHAR(64);

-- 8. Journal.Journal_Entry_Group — groups DR/CR lines into a single
--    balanced entry, essential for multi-line events (VAT, disposal,
--    asset purchase with trade-in)
ALTER TABLE "Journal" ADD COLUMN IF NOT EXISTS "Journal_Entry_Group" VARCHAR(45) NULL;

-- 9. Money — Interest_type to support different rate forms
ALTER TABLE "Money" ADD COLUMN IF NOT EXISTS "Interest_Type" VARCHAR(20) NULL;
-- SIMPLE, COMPOUND, REDUCING_BALANCE, FLAT, EFFECTIVE

-- 10. Loan interest tracking fields
ALTER TABLE "Money" ADD COLUMN IF NOT EXISTS "Interest_Accrued" DECIMAL(15,2) NULL DEFAULT 0;
ALTER TABLE "Money" ADD COLUMN IF NOT EXISTS "Total_Interest_Paid" DECIMAL(15,2) NULL DEFAULT 0;
ALTER TABLE "Money" ADD COLUMN IF NOT EXISTS "Next_Payment_Date" DATE NULL;
