-- Migration 21: Product_Nature, Structures_Type CHECK, expanded Settings

-- Product_Nature — single authoritative classification replacing
-- the ambiguous Is_Asset/Is_Service/Is_Utility boolean flags
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "Product_Nature" VARCHAR(25) NULL;
-- GOOD / SERVICE / FIXED_ASSET / FINANCIAL_INSTRUMENT / BIOLOGICAL_OUTPUT / CONSUMABLE / UTILITY

-- Structures_Type controlled vocabulary CHECK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_structures_type'
  ) THEN
    ALTER TABLE "Structures" ADD CONSTRAINT "chk_structures_type"
      CHECK ("Structures_Type" IN (
        'ACCOUNTING_STANDARD','ACCOUNTING_POLICY','ACCOUNTING_PERIOD',
        'ACCOUNTING_ASSUMPTION','MEASUREMENT_RULE','WORKFLOW_RULE',
        'WORKFLOW_POLICY','REPORT_TEMPLATE','INDUSTRY_TEMPLATE',
        'CHART_TEMPLATE','DISCLOSURE_RULE','AUDIT_RULE','TAX_RULE',
        'CONTROL_POLICY','ENUM_TEMPLATE','FAMILY_POLICY',
        'INHERITANCE_POLICY','FRAMEWORK','STANDARD','PERIOD_END_CHECK',
        'SYSTEM_ARCHITECTURE','BUSINESS_UNIT',NULL
      ));
  END IF;
END $$;
