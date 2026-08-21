let _prisma;
function getPrisma() { if (!_prisma) { _prisma = require("../posting/core").prisma; } return _prisma; }

function truncateAtBoundary(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  const hardCut = text.slice(0, maxLength - 3); // reserve 3 chars for "..."
  const lastSentenceEnd = hardCut.lastIndexOf(". ");
  if (lastSentenceEnd > maxLength * 0.5) {
    return hardCut.slice(0, lastSentenceEnd + 1);
  }
  const lastSpace = hardCut.lastIndexOf(" ");
  return (lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut) + "...";
}

// Real column caps on Structures -- the actual source of the "value too
// long for the column's type" crash, hit repeatedly because earlier
// fixes only checked individual field literals, never the length of
// template-literal concatenations built from multiple fields at once
// (e.g. `${name}|${description}` can overflow even when name and
// description are each independently short enough). Enforced here as a
// defensive backstop in upsertStructure itself, so no future call site --
// however it builds its Structures_Name or Structures_Description -- can
// reintroduce this crash.
const STRUCTURES_FIELD_CAPS = {
  Structure_Level: 15, Structures_Type: 45, Compliance_Level: 20,
  Business_Maturity: 20, Escalation_Role: 20, Measurement_Basis: 20,
  Framework_Name: 20, Framework_Version: 20, Rule_Code: 20,
  Standard_Reference: 45, Rule_Severity: 10, Applies_To_Table: 45,
  Structures_Name: 45, Structures_Rule: 45, Structures_Condition: 45,
  Structures_Description: 255, Recognition_Method: 45,
  Preference_key: 255, Preference_value: 255, Period_Status: 10, Period_name: 45,
};

async function upsertStructure(fields) {
  const safeFields = { ...fields };
  for (const [field, cap] of Object.entries(STRUCTURES_FIELD_CAPS)) {
    if (typeof safeFields[field] === "string" && safeFields[field].length > cap) {
      safeFields[field] = truncateAtBoundary(safeFields[field], cap);
    }
  }

  const existing = await getPrisma().Structures.findFirst({
    where: { Structures_Name: safeFields.Structures_Name, Structures_Type: safeFields.Structures_Type, Entreprise_id: safeFields.Entreprise_id },
  });

  if (existing) {
    // Genuinely update, not just skip -- a prior seed run can have created
    // this row with stale content (e.g. ProcessActions' source-of-truth
    // row was created with isPopulated=false before ProcessActions was
    // ever seeded; re-running seed.js after the fix found the row already
    // existed and silently kept the stale text, which is exactly why the
    // Rules page kept showing "Declared, not yet populated" even after
    // the code said isPopulated=true).
    //
    // Deliberately excludes Period_Status (and the accounting-period-only
    // fields Structures_Period, Period_name) -- an ACCOUNTING_PERIOD row's
    // open/closed state is real, live data set by actual user action
    // (opening or closing a trading day), never something a re-run of the
    // seed script should silently reset back to its original value.
    const updatable = {};
    for (const field of ["Structures_Description", "Rule_Severity", "Standard_Reference", "Recognition_Method", "Applies_To_Table", "Measurement_Basis"]) {
      if (safeFields[field] !== undefined && safeFields[field] !== existing[field]) {
        updatable[field] = safeFields[field];
      }
    }
    if (Object.keys(updatable).length > 0) {
      return getPrisma().Structures.update({ where: { Structures_id: existing.Structures_id }, data: updatable });
    }
    return existing;
  }

  return getPrisma().Structures.create({ data: safeFields });
}

/**
 * seedCatalogueEvents -- the single source of truth for every Catalogue
 * event definition in the system. Called at business-creation time and
 * on every visit to the Rules page (idempotent -- upsertCatalogue is
 * find-or-create, safe to re-run).
 *
 * Before this function existed, Catalogue rows were created by two
 * different mechanisms: four events seeded in main() and 35+ events
 * created on-demand inside posting functions via mustFindOrCreateCatalogue
 * or tx.Catalogue.create. This meant:
 *   -- The Rules page could only show events that had already been posted
 *   -- Changing a debitCode or narrativeTemplate required finding the
 *     right file among 15+ posting files
 *   -- An accountant reviewing the system's rules could not see what
 *     events existed without reading source code
 *
 * Every posting function that currently calls mustFindOrCreateCatalogue
 * should eventually drop that call and simply call runCatalogueEvent
 * (which will find the already-seeded row). The transition is safe:
 * mustFindOrCreateCatalogue is find-or-create, so if the row already
 * exists from seed it returns it; if seed hasn't run yet it creates it
 * -- same behaviour, just with seed as the preferred first path.
 */

async function seedAccountingRules(entrepriseId) {
  const ifrsFramework = await upsertStructure({
    Structures_Type: "FRAMEWORK",
    Structure_Level: "FRAMEWORK",
    Framework_Name: "IFRS_SME",
    Framework_Priority: 2,
    Structures_Name: "IFRS for SMEs",
    Structures_Description: "The primary accounting framework this system is built toward. Individual IAS/IFRS standard references below are used as educational and supporting references -- this system does not prepare full IFRS financial statements. Where IFRS for SMEs and full IFRS differ, the SME standard applies.",
    Mandatory: 1,
    Rule_Severity: "INFO",
    Entreprise_id: entrepriseId,
  });

  // Declare the framework policy explicitly so auditors and accountants
  // know the system's stance on which standards are authoritative
  await upsertStructure({
    Structures_Type: "ACCOUNTING_POLICY",
    Structure_Level: "RULE",
    Parent_Structure_id: ifrsFramework.Structures_id,
    Framework_Name: "IFRS_SME",
    Framework_Priority: 2,
    Structures_Name: "FRAMEWORK_DECLARATION",
    Structures_Description: "Primary framework: IFRS for SMEs. Individual IAS/IFRS references (IAS 2, IAS 16, IAS 41, IFRS 9, IFRS 15, IFRS 16, IFRS 17) are used as educational references to explain the accounting principles being applied. They are not a claim that this business prepares full IFRS financial statements.",
    Rule_Code: "FW_DECLARATION",
    Mandatory: 1,
    Rule_Severity: "INFO",
    Entreprise_id: entrepriseId,
  });

  const standards = [
    {
      code: "IAS2",
      name: "IAS 2 -- Inventories",
      reference: "IAS 2.9",
      ownerExplanation: "Stock is valued at what you paid for it. The cost of goods you sell only counts as an expense when the sale actually happens -- not when you first bought the stock.",
      description: "Inventory is measured at the lower of cost and net realisable value. Cost of goods sold is recognised as an expense in the period the related revenue is recognised -- never at the point of purchase.",
      appliesTo: "RESOURCE",
      recognitionMethod: "On Consumption",
      catalogueEvents: ["BUY_INVENTORY_CASH", "RECORD_COGS", "SELL_GOODS_CASH"],
      policyName: "Cost formula -- actual cost",
      policyDescription: "Inventory is purchased and consumed at its recorded cost. BUY_INVENTORY_CASH capitalises the purchase to the Inventory account (balance sheet); RECORD_COGS transfers that cost to expense only when the matching sale is recognised.",
    },
    {
      code: "IAS16",
      name: "IAS 16 -- Property, Plant and Equipment",
      reference: "IAS 16.73",
      ownerExplanation: "Vehicles, equipment, and fixtures are recorded at what they cost, then their value is spread down over the years you'll actually use them -- not written off all at once.",
      description: "Fixed assets are recognised at cost and depreciated over their useful life. Accumulated depreciation and the resulting carrying amount must be tracked and disclosed.",
      appliesTo: "ASSET",
      recognitionMethod: "On Depreciation",
      catalogueEvents: ["PURCHASE_FIXED_ASSET"],
      policyName: "Depreciation method -- straight-line default",
      policyDescription: "Assets purchased through the Assets wizard default to straight-line depreciation over the stated useful life, with an explicit residual value. Reducing-balance and units-of-production are also available per asset.",
    },
    {
      code: "IFRS15",
      name: "IFRS 15 -- Revenue from Contracts with Customers",
      reference: "IFRS 15.31",
      ownerExplanation: "A sale counts as income the moment the customer actually gets the goods -- for a till sale, that's the moment you ring it up. Simply receiving a deposit or ordering stock doesn't count yet.",
      description: "Revenue is recognised when control of goods transfers to the customer -- at the point of sale for cash retail transactions, not when cash is merely received or goods are merely purchased.",
      appliesTo: "INCOME",
      recognitionMethod: "On Delivery",
      catalogueEvents: ["SELL_GOODS_CASH", "RECEIVE_RENT_INCOME"],
      policyName: "Point-of-sale recognition",
      policyDescription: "SELL_GOODS_CASH recognises revenue at the moment the till posts the sale, matching cash receipt and delivery for this business's retail model. Rental income is recognised when received, per the cash-basis election documented under IFRS 9 below.",
    },
    {
      code: "IFRS9",
      name: "IFRS 9 -- Financial Instruments",
      reference: "IFRS 9.5.1",
      ownerExplanation: "Money owed to you (unpaid customer bills) and money you owe (unpaid supplier bills, loans) are tracked at the actual amount involved -- what's really outstanding, not an estimate.",
      description: "Loans, bonds, equity investments, trade receivables, and trade payables are all financial instruments under IFRS 9, each requiring classification (amortised cost vs fair value) and, for loans and credit balances, disclosure with an interest rate or credit terms and maturity.",
      appliesTo: "MONEY",
      recognitionMethod: "On Payment",
      catalogueEvents: ["OWNER_CAPITAL_INJECTION", "LOAN_DRAWDOWN", "RECEIVE_INTEREST_INCOME", "RECEIVE_DIVIDEND_INCOME", "SELL_GOODS_CASH", "BUY_INVENTORY_CASH", "PAY_EXPENSE_UTILITIES"],
      policyName: "Amortised cost throughout -- bonds, shares, receivables, and payables",
      policyDescription: "Government bonds held for coupon income are measured at amortised cost (Instrument_Class=AMORTIZED_COST). Listed shares held for potential price appreciation are measured at fair value through OCI (Instrument_Class=FAIR_VALUE_OCI). Trade Receivables (1200) and Trade Payables (2000) -- created whenever a sale, purchase, or expense is recorded on Credit rather than Cash/Mobile/Bank -- are carried at amortised cost: the amount actually owed, with no discounting applied given their short (typically under 12 month) settlement horizon.",
    },
    {
      code: "IAS1",
      name: "IAS 1 -- Presentation of Financial Statements",
      reference: "IAS 1.66-1.69",
      ownerExplanation: "Your financial reports can't be produced until the books are actually balanced and reviewed -- the system won't let you skip straight to a Profit Statement or Balance Sheet from unchecked figures.",
      description: "Financial statements are prepared on an accrual basis and require a complete, balanced set of accounts before Income Statement or Balance Sheet can be presented -- never generated directly from an unadjusted trial balance. Assets and liabilities must also be classified as current or non-current so a reader can judge short-term liquidity at a glance.",
      appliesTo: "REPORT",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Adjusted trial balance gate, and current/non-current classification",
      policyDescription: "The Reports page enforces the full chain: Unadjusted Trial Balance -> Adjusted Trial Balance -> Income Statement / Balance Sheet. Financial statements cannot be generated from a report that isn't marked Is_Adjusted=1. Separately, Assets.Asset_Classification and Liability.Liability_Classification each carry a CURRENT / NON_CURRENT value (IAS 1.66 and IAS 1.69) -- Cash, Inventory, and Trade Receivables are current; Property Plant and Equipment is non-current; Trade Payables are current; a Loan Payable is classified by its remaining term.",
    },
    {
      code: "IFRS12",
      name: "IFRS 12 -- Disclosure of Interests in Other Entities",
      reference: "IFRS 12.7",
      ownerExplanation: "Every business unit you run -- however many, whatever they're called -- is part of the same one business, not separate companies. Everything is reported together as a single enterprise.",
      description: "A reporting entity discloses enough information for a reader to evaluate the nature of, and risks from, its interests in other entities, and the effect of those interests on its financial position. Relevant to a family enterprise the moment it operates more than one business unit under common family control.",
      appliesTo: "ORGANISATION",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Single reporting entity, multiple business units -- not separate legal entities",
      policyDescription: "Business units (Structures_Type=BUSINESS_UNIT) are modelled and posted as divisions of one Organisation, not as separate legal entities with their own accounts to consolidate. This is a deliberate scope decision, not a gap: there is no subsidiary, no non-controlling interest, and no group structure requiring elimination entries beyond the internal-transfer handling already documented under IFRS 15. If a business unit were ever incorporated separately -- a common next step as a family enterprise formalises -- this policy is where that change would be recorded, and Structures.Parent_Structure_id already supports the resulting BUSINESS_UNIT -> Structures_Type=DIVISION hierarchy without a schema change.",
    },
    {
      code: "IAS7",
      name: "IAS 7 -- Statement of Cash Flows",
      reference: "IAS 7.10-7.17",
      ownerExplanation: "Your Cash Flow page shows real cash -- money that actually moved through Cash, Mobile Money, and Bank -- sorted into everyday trading, buying/selling big assets, and loans or capital. This is different from your profit figure, which includes sales not yet paid for.",
      description: "Cash flows are classified as operating, investing, or financing, and a reader must be able to see the enterprise's actual cash and cash-equivalent position separately from its accrual-basis profit -- cash generated from trading is not the same figure as net income.",
      appliesTo: "REPORT",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Direct method -- actual cash movements by activity",
      policyDescription: "The Cash Flow page (Money -> Cash Flow) uses the direct method: it reads real Journal postings against the Cash, Mobile Money, and Bank accounts and classifies each by the Cash_Flow_Category already set on its Catalogue event (OPERATING for sales/purchases/expenses, INVESTING for asset purchases and disposals, FINANCING for capital and loan drawdowns) -- not an indirect reconciliation from net profit. Receivables and Payables are shown separately as the gap between profit and cash, per IAS 7.18's distinction between operating result and operating cash flow.",
    },
    {
      code: "IAS8",
      name: "IAS 8 -- Accounting Policies, Estimates and Errors",
      reference: "IAS 8.13-8.14",
      ownerExplanation: "You apply the same rules the same way every time -- the same depreciation method for similar assets, the same way of valuing stock. If a past entry needs correcting, it should be reversed and redone with a visible trail, not just quietly edited.",
      description: "An entity selects and applies its accounting policies consistently for similar transactions, discloses what those policies are, and -- when a policy or an estimate changes, or an error from a prior period is found -- accounts for that change or correction in a defined, traceable way rather than silently editing history.",
      appliesTo: "REPORT",
      recognitionMethod: null,
      catalogueEvents: [],
      policyName: "Consistent policies; corrections tracked, not overwritten",
      policyDescription: "Depreciation method and inventory cost basis (actual cost, not FIFO or weighted-average) are each set once per asset or event type and applied consistently rather than varied case by case. Transactions carry Correction_Status=ORIGINAL by default; the schema's Correction_Status/Correction_of fields are designed so a prior entry is reversed and replaced rather than edited in place, keeping a traceable history. This is the schema's intended mechanism for IAS 8 error correction -- noted here as a known gap: no reversal action exists in the interface yet, so a correction currently has to be posted as a new offsetting entry rather than a formal linked reversal.",
    },
    {
      code: "IFRS16",
      name: "IFRS 16 -- Leases",
      reference: "IFRS 16.22-16.26",
      ownerExplanation: "When you sign a lease -- for premises, a vehicle, equipment -- it goes on the books as both something you now have the right to use and something you owe. Rent is no longer just a monthly expense; it's paying down that debt.",
      description: "A lessee recognises a Right-of-Use asset and a corresponding Lease Liability at the start of a lease, rather than treating rent as a simple period expense. The Right-of-Use asset is then amortised over the lease term, and each payment reduces the Lease Liability rather than being expensed directly.",
      appliesTo: "ASSET",
      recognitionMethod: "On Commencement",
      catalogueEvents: ["LEASE_COMMENCEMENT", "LEASE_PAYMENT"],
      policyName: "Right-of-Use asset and Lease Liability recognised together at commencement",
      policyDescription: "Lease commencement records the Right-of-Use asset and the Lease Liability together, at the total contracted payments over the term -- a simplification of full IFRS 16, which discounts future payments to present value using the lessee's incremental borrowing rate; this system does not yet have a rate input, so commencement uses the undiscounted total instead. Each lease payment then reduces the Lease Liability (the financing portion) and separately amortises the Right-of-Use asset over the lease term via the same depreciation mechanism used for owned assets.",
    },
    {
      code: "IAS37",
      name: "IAS 37 -- Provisions, Contingent Liabilities and Contingent Assets",
      reference: "IAS 37.14",
      ownerExplanation: "If you offer a warranty on something you sell, you record the likely cost of future repairs at the time of sale -- not just when a customer actually comes back with a problem. This is different from a supplier bill, where the amount owed is already certain.",
      description: "A provision is recognised only when there is a present obligation from a past event, payment is probable, and the amount can be reliably estimated -- distinct from a Trade Payable, which is a known, certain amount. A warranty offered on goods sold is the clearest everyday example: the obligation exists at the point of sale even though the exact repair cost and timing are not yet known.",
      appliesTo: "MONEY",
      recognitionMethod: "On Estimate",
      catalogueEvents: ["RECORD_PROVISION", "UTILISE_PROVISION"],
      policyName: "Warranty provisions recognised at sale, utilised as claims arise",
      policyDescription: "Recording a provision posts an estimated Warranty Expense against a Provision for Warranties liability. When a claim is honoured, that same provision is drawn down (paid out of the existing liability) rather than a fresh expense being recognised -- the expense was already booked when the provision was first estimated, per IAS 37.14's matching principle.",
    },
    {
      code: "IAS36",
      name: "IAS 36 -- Impairment of Assets",
      reference: "IAS 36.59",
      ownerExplanation: "If something you own is damaged, becomes outdated, or is simply worth less than it used to be, its value on the books is written down right away to reflect that -- separate from the normal gradual depreciation every asset goes through.",
      description: "When an asset's recoverable amount falls below its carrying amount -- through damage, obsolescence, or a genuine drop in value -- the carrying amount is written down immediately to the recoverable amount, and the loss is recognised in profit or loss. This is separate from scheduled depreciation, which spreads a known cost over a known life.",
      appliesTo: "ASSET",
      recognitionMethod: "On Impairment Test",
      catalogueEvents: ["RECORD_IMPAIRMENT"],
      policyName: "Impairment recognised immediately, distinct from depreciation",
      policyDescription: "The Assets page's Impairment form posts the write-down directly against the asset, capped at its current carrying amount so it can never go negative. Accumulated impairment is tracked separately from accumulated depreciation, and both are netted against cost to compute carrying amount, matching the schema's own documented formula -- depreciation running after an impairment correctly accounts for the reduced remaining value rather than depreciating as if the impairment never happened.",
    },
    {
      code: "IAS41",
      name: "IAS 41 -- Agriculture",
      reference: "IAS 41.10-41.12",
      ownerExplanation: "Your animals and crops are valued at what they would fetch at market today, not what you originally paid. When a calf is born or a crop grows, the increase in value is genuine income even though no cash changed hands. When an animal dies, the loss is genuine even though nothing was sold.",
      description: "Biological assets are measured at fair value less costs to sell. A gain or loss arising from a change in fair value is recognised in profit or loss for the period. At the point of harvest, the produce is measured at fair value less costs to sell and thereafter enters IAS 2 (Inventory) -- IAS 41 does not govern post-harvest produce.",
      appliesTo: "RESOURCE",
      recognitionMethod: "On Fair Value Change",
      catalogueEvents: ["LIVESTOCK_BIRTH", "LIVESTOCK_LOSS", "LIVESTOCK_THEFT", "HARVEST"],
      policyName: "Biological assets at fair value less costs to sell",
      policyDescription: "Animals and crops are registered at estimated market fair value. Monthly reviews update the fair value without a journal posting -- the gain or loss is recognised only at specific events: births (new asset, DR Biological Assets CR Gain on Biological Assets), deaths (DR Loss CR Biological Assets), and harvest (DR Inventory CR Biological Assets -- the produce transitions from IAS 41 to IAS 2 at the point of harvest). Theft is tracked separately from natural loss for risk-pattern analysis.",
    },
    {
      code: "IFRS17",
      name: "IFRS 17 -- Insurance Contracts",
      reference: "IFRS 17.3",
      ownerExplanation: "When you pay insurance premiums, that money is buying protection over a period of time. The cost is spread over the coverage period, not just recorded when you pay. When something goes wrong and the insurer pays you, that payout is income -- separate from the premiums you paid.",
      description: "Insurance premiums are expensed over the period of coverage. Prepaid portions are carried as prepaid insurance until the coverage period passes. Claims are recognised when the right to compensation is established -- the claim receipt is income (Insurance Claim Income), not a reversal of the premium expense, because the premium bought coverage and the claim is the coverage paying out.",
      appliesTo: "MONEY",
      recognitionMethod: "Over Coverage Period",
      catalogueEvents: ["PAY_EXPENSE_INSURANCE", "INSURANCE_CLAIM_RECEIPT"],
      policyName: "Premiums expensed over coverage period, claims as income when right established",
      policyDescription: "Insurance premiums are posted as Insurance Expense when paid, linked back to the specific policy via the Money row (postExpense with moneyId). The full premium is currently expensed immediately -- a future improvement would spread it over the coverage months as a prepaid asset. Claims received from the insurer are posted as Insurance Claim Income (a separate income account, 4800), not a reversal of the expense. The Risk Position panel on the Risks & Insurance page computes the coverage ratio (total insured value / total asset carrying value) to flag under-insurance.",
    },
  ];

  for (const std of standards) {
    const standardStructure = await upsertStructure({
      Structures_Type: "STANDARD",
      Structure_Level: "STANDARD",
      Parent_Structure_id: ifrsFramework.Structures_id,
      Framework_Name: "IAS",
      Framework_Priority: 1,
      Framework_Version: std.code,
      Rule_Code: std.code,
      Standard_Reference: std.reference,
      // Structures_Name is capped at 45 characters -- std.name (e.g. "IAS
      // 37 -- Provisions, Contingent Liabilities and Contingent Assets" at
      // 67 chars) regularly exceeded that and crashed seed.js on the
      // first standard reached in that state. std.code (e.g. "IAS37") is
      // always short; the full readable name moves into
      // Structures_Description, pipe-separated ahead of the owner
      // explanation, same pattern used elsewhere in this function.
      Structures_Name: std.code,
      Structures_Description: `${std.name}|${std.ownerExplanation}`,
      Applies_To_Table: std.appliesTo,
      Recognition_Method: std.recognitionMethod,
      Mandatory: 1,
      Rule_Severity: "BLOCK",
      Measurement_Basis: std.code === "IAS2" ? "HISTORICAL_COST" : std.code === "IFRS9" ? "AMORTIZED_COST" : null,
      // Pipe-separated list of Catalogue Event_Names this standard governs.
      // Stored here so the Rules page can display the linkage without
      // depending on the Catalogue.Structures_id FK being set -- that FK
      // only gets written when a matching Catalogue row exists for this
      // business (i.e. after the relevant posting function has been called
      // at least once), but the display should work from the very first
      // visit to the Rules page, before any transactions have been posted.
      Structures_Condition: std.catalogueEvents.join("|"),
      Entreprise_id: entrepriseId,
    });

    await upsertStructure({
      Structures_Type: "ACCOUNTING_POLICY",
      Structure_Level: "RULE",
      Parent_Structure_id: standardStructure.Structures_id,
      Framework_Name: "INTERNAL",
      Framework_Priority: 4,
      // Structures_Name is capped at 45 characters -- every one of the 11
      // policyName values here exceeds that, which is what was actually
      // crashing seed.js on the very first standard it tried to seed
      // (before even reaching the source-of-truth policy fixed earlier).
      // A short fixed label goes here; the real policy name and its full
      // detail both live in Structures_Description, separated by a pipe,
      // same pattern used for the source-of-truth rows.
      Structures_Name: "Policy",
      Structures_Description: `${std.policyName}|${std.description} ${std.policyDescription}`, // technical detail, accountant-facing
      Applies_To_Table: std.appliesTo,
      Mandatory: 1,
      Rule_Severity: "INFO",
      Entreprise_id: entrepriseId,
    });

    // Tag which Catalogue events this standard actually governs, so the
    // Rules page can show "this standard applies to these real processes"
    for (const eventName of std.catalogueEvents) {
      const cat = await getPrisma().Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
      if (cat) {
        await getPrisma().Catalogue.update({
          where: { Catalogue_id: cat.Catalogue_id },
          data: { Structures_id: standardStructure.Structures_id },
        });
      }
    }
  }

  // --- LogicConditions: the two enforcement rules genuinely live in
  //     postingEngine.js today. Documenting them here makes the actual
  //     running behaviour visible on the Rules page, not aspirational.
  await upsertLogicCondition({
    name: "Closed Period Entry Block",
    whenEvent: "ANY_JOURNAL_INSERT",
    leftOperand: "Structures.Period_Status WHERE Structures_id = Journal.Period_id",
    operator: "!=",
    rightOperand: "OPEN",
    checkExpression: "Every Journal row must reference a Structures row with Period_Status = OPEN.",
    enforcement: "BLOCK",
    ownerMessage: "You cannot post entries right now -- no accounting period is open. Open today's period in Settings.",
    accountantMessage: "IAS 1 cutoff: Journal.Period_id must reference an OPEN Structures period. This is enforced in postBasket, postExpense, postFunding, postAssetPurchase, and postUnitIncome before any Journal row is written.",
    logicExplanation: "Prevents backdating entries into a closed or nonexistent period. Genuinely enforced -- every posting function in postingEngine.js checks for an OPEN period and throws before writing anything if none exists.",
    logicType: "VALIDATION",
    reviewLevel: "ACCOUNTANT",
    validationTier: "ACCOUNTING",
  });

  await upsertLogicCondition({
    name: "Double Entry Balance Check",
    whenEvent: "ANY_JOURNAL_INSERT",
    leftOperand: "SUM(Journal.Debit) WHERE Transactions_id = NEW.Transactions_id",
    operator: "=",
    rightOperand: "SUM(Journal.Credit) WHERE Transactions_id = NEW.Transactions_id",
    checkExpression: "Every posting function writes matched debit/credit Journal pairs within a single database transaction -- postJournalPair always creates both sides together.",
    enforcement: "BLOCK",
    ownerMessage: "Entries are always recorded in matching pairs -- you'll never see an unbalanced entry from normal use of the till, expenses, or funds pages.",
    accountantMessage: "Structural guarantee rather than a post-hoc check: postJournalPair() in postingEngine.js always writes a Debit row and a Credit row for the same amount inside one Prisma $transaction, so partial writes cannot occur. The Reports and Journal pages both display a live balance check as a secondary confirmation.",
    logicExplanation: "The Trial Balance and Journal pages compute SUM(Debit) vs SUM(Credit) live and flag any mismatch -- this is a visible confirmation of what the engine already guarantees structurally.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "ACCOUNTING",
  });

  await upsertLogicCondition({
    name: "Loan Amortization Discipline",
    whenEvent: "PERIOD_CLOSE:MONTHLY",
    leftOperand: "Money.Outstanding_Amount WHERE Instrument_type=LOAN",
    operator: "=",
    rightOperand: "Opening_Principal - SUM(principal_repayments_this_period)",
    checkExpression: "A loan's Outstanding_Amount should reduce only by the principal portion of each repayment -- interest paid does not reduce principal owed.",
    enforcement: "WARN",
    ownerMessage: "Loan repayments split into two parts: the amount that actually reduces what you owe, and the interest cost. Only the first part brings the loan balance down.",
    accountantMessage: "Not yet enforced structurally -- currently modelled honestly as a gap. postFunding() records a loan drawdown (DR Cash/Bank CR Loan Payable) but this system has no repayment/amortization schedule function yet: no split of a repayment into principal and interest, no automatic reduction of Money.Outstanding_Amount, no interest accrual between payments. A single lump-sum loan (as currently seeded) doesn't expose this gap; a formally amortized loan with a fixed schedule and rate -- the kind a larger multi-unit business is more likely to carry -- would need this built before the loan register could be trusted for real repayment tracking.",
    logicExplanation: "Recorded here as a documented gap, not a working control, so the Rules page stays honest about what this system does and doesn't verify yet -- matching the standard set elsewhere in this file that only real, running behaviour is described as enforced.",
    logicType: "VALIDATION",
    reviewLevel: "ACCOUNTANT",
    validationTier: "COMPLIANCE",
  });

  // IAS 1 and IAS 7 correctly have no Catalogue event -- neither governs a
  // single postable transaction the way IAS 2 governs BUY_INVENTORY_CASH.
  // They govern presentation: whether a report can be generated at all,
  // and how cash movements get categorised once it is. That enforcement
  // is real and already running in reporting.js and the Cash Flow route --
  // it was just never represented as a LogicConditions row before, which
  // is what made the Rules page correctly say these standards had no
  // visible rule guiding how things are processed.
  await upsertLogicCondition({
    name: "Adjusted Trial Balance Gate",
    whenEvent: "REPORT_GENERATE",
    leftOperand: "Reports.Is_Adjusted WHERE Reports_id = parentReportId",
    operator: "=",
    rightOperand: "1",
    checkExpression: "generateIncomeStatement() and generateBalanceSheet() both call requireAdjustedParent(), which throws unless the referenced parent Reports row has Report_Stage=TRIAL_BALANCE_ADJUSTED and Is_Adjusted=1.",
    enforcement: "BLOCK",
    ownerMessage: "Your Income Statement or Balance Sheet can't be generated until the trial balance has actually been adjusted -- this stops a report from being produced against unreviewed figures.",
    accountantMessage: "Genuinely enforced in reporting.js: requireAdjustedParent() is called at the top of both generateIncomeStatement() and generateBalanceSheet(), and throws ReportingError before any Reports row is written if the referenced parent isn't an adjusted trial balance. IAS 1's presentation requirement is a structural gate here, not a checklist item.",
    logicExplanation: "This is the actual rule behind IAS 1's Structures row on the Rules page -- it has no Catalogue event because it governs report generation, not a transaction, but the block is real and running.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "COMPLIANCE",
  });

  await upsertLogicCondition({
    name: "Cash Flow Activity Classification",
    whenEvent: "REPORT_VIEW",
    leftOperand: "Catalogue.Cash_Flow_Category WHERE Catalogue_id = Journal.Catalogue_id",
    operator: "IN",
    rightOperand: "OPERATING, INVESTING, FINANCING",
    checkExpression: "Every cash-equivalent Journal row (Cash/Mobile/Bank) is sorted by its Catalogue event's Cash_Flow_Category into the three IAS 7 activity classes and totalled separately from accrual-basis profit.",
    enforcement: "INFO",
    ownerMessage: "Your Cash Flow page separates real cash movements -- everyday trading, buying or selling big assets, and loans or capital -- from your profit figure, which includes sales you haven't been paid for yet.",
    accountantMessage: "Genuinely enforced in the Money > Cash Flow route: every Journal row against a cash-equivalent account is looked up via its Catalogue_id to read Cash_Flow_Category (OPERATING/INVESTING/FINANCING/NONE), then summed per category. Catalogue rows that don't set a Cash_Flow_Category are correctly excluded from the classified totals rather than silently defaulting to one bucket.",
    logicExplanation: "This is the actual rule behind IAS 7's Structures row on the Rules page -- a report-time classification rather than a single postable event, but genuinely computed from real data each time the page loads, not hardcoded.",
    logicType: "REPORTING",
    reviewLevel: "NONE",
    validationTier: "COMPLIANCE",
  });

  // BUSINESS tier: does this make operational sense, before any
  // accounting or compliance question is even reached? Both of these are
  // genuinely enforced today, not just documented -- Product-existence was
  // already checked before this session; the stock-sufficiency check was
  // added specifically because building this rule's documentation
  // surfaced that it was missing.
  await upsertLogicCondition({
    name: "Product Must Exist",
    whenEvent: "BASKET_LINE_ADD",
    leftOperand: "Product.Product_id WHERE Product_id = line.productId AND Entreprise_id = current",
    operator: "NOT_NULL",
    rightOperand: "",
    checkExpression: "Every basket line's productId must resolve to a real Product row belonging to the business posting the sale -- a stale or cross-business product reference is rejected before any posting begins.",
    enforcement: "BLOCK",
    ownerMessage: "The item you're trying to sell or buy couldn't be found -- it may have been removed, or belongs to a different business unit.",
    accountantMessage: "Genuinely enforced in postBasket(): each line's Product_id is resolved via tx.Product.findUnique and checked against Entreprise_id first. A missing or cross-business product throws PostingError before any Journal write.",
    logicExplanation: "The most basic business-sense question a sale can be asked: does the thing being sold actually exist? This runs before any accounting or compliance check -- there is no point validating a period is open for a sale of a product that doesn't exist.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "BUSINESS",
  });

  await upsertLogicCondition({
    name: "Sufficient Stock Available",
    whenEvent: "BASKET_LINE_ADD",
    leftOperand: "Resources.Resources_Quantity WHERE Product_id = line.productId",
    operator: ">=",
    rightOperand: "line.quantity",
    checkExpression: "A Goods sale cannot request more units than Resources.Resources_Quantity currently holds for that product. Services and Utilities are exempt -- neither carries a physical quantity.",
    enforcement: "BLOCK",
    ownerMessage: "You're trying to sell more than you have in stock. Record a purchase first, or reduce the quantity.",
    accountantMessage: "Genuinely enforced in postBasket(): for Goods lines, current Resources_Quantity is checked against the requested quantity before any Journal write. Previously a sale could drive inventory negative unchecked -- found and fixed while documenting this rule.",
    logicExplanation: "Business sense, checked before accounting: a sale that would take stock negative isn't an accounting problem to flag after the fact, it's an operational impossibility to refuse before posting begins.",
    logicType: "VALIDATION",
    reviewLevel: "NONE",
    validationTier: "BUSINESS",
  });

  console.log("Accounting rules seeded: 11 IAS/IFRS standards with policies, mapped to real Catalogue events; 7 LogicConditions across all three validation tiers (Business, Accounting, Compliance), documenting live enforcement (and one honestly documented gap).");
}

/**
 * seedProcessActions -- real workflow steps for the three processes this
 * system actually has: a Till sale, an expense payment, and a fixed
 * asset purchase. Each row answers "what step happened," never "what
 * accounts moved" -- that separation is deliberate, matching the
 * architectural rule that ProcessActions must never Debit/Credit
 * (Catalogue answers "what accounts," ProcessActions answers "what
 * happened"). Accounting_Event=1 only on the step where a real posting
 * function actually calls postJournalPair, verified against till.js,
 * claims.js, and assets.js rather than invented.
 *
 * Ordered via Sequence_No and chained via ParentAction_id so a process
 * can be walked step by step, matching the review's diagram: Business
 * Event -> Catalogue -> LogicConditions -> ProcessActions -> Posting
 * Engine -> Journal.
 */
const PROCESS_ACTIONS_FIELD_CAPS = {
  Process_name: 45, Action_Type: 20, Cycle_type: 20, From_State: 20,
  To_State: 20, Applies_To: 20, Approval_Level: 20, Process_Description: 255,
  Default_Journal_Template: 45, Reversal_Method: 20, Required_Document: 45,
  Required_Evidence: 45, Scheduled_date: 45, Recurrence_Pattern: 20,
};



const LOGIC_CONDITIONS_FIELD_CAPS = {
  Conditons_Name: 45, When_Event: 20, Left_Operand: 100, Operator: 10,
  Right_Operand: 100, Check_Expression: 500, Enforcement: 10,
  Owner_Message: 255, Accountant_Message: 255, Logic_type: 20, Review_Level: 20,
  Validation_Tier: 15,
};

async function upsertLogicCondition({
  name,
  whenEvent,
  leftOperand,
  operator,
  rightOperand,
  checkExpression,
  enforcement,
  ownerMessage,
  accountantMessage,
  logicExplanation,
  logicType,
  reviewLevel,
  validationTier,
}) {
  // NOTE: LogicConditions has no Entreprise_id column yet -- missing from
  // the original multi-tenancy migration, same gap as Equity. These rows
  // (the enforcement-rule documentation on the Rules page) are currently
  // shared globally across every business rather than scoped per-business.
  // Left unscoped deliberately rather than silently working around it;
  // needs a follow-up migration.
  const existing = await getPrisma().LogicConditions.findFirst({ where: { Conditons_Name: name } });
  if (existing) return existing;

  const safeData = {
    Conditons_Name: name,
    When_Event: whenEvent,
    Left_Operand: leftOperand,
    Operator: operator,
    Right_Operand: rightOperand,
    Check_Expression: checkExpression,
    Enforcement: enforcement,
    Owner_Message: ownerMessage,
    Accountant_Message: accountantMessage,
    Logic_Explanation: logicExplanation, // TEXT column, no practical length cap
    Logic_type: logicType,
    Review_Level: reviewLevel,
    Validation_Tier: validationTier || "ACCOUNTING",
    Fact_Type: "ACTUAL",
    Confidence_Level: 5,
  };

  // Defensive backstop, same pattern as upsertStructure: several of this
  // file's own accountantMessage values were already over the real
  // 255-char Accountant_Message cap and only avoided crashing because
  // Conditons_Name uniqueness meant they'd never actually been inserted
  // fresh since this bug was introduced. Truncating here closes that gap
  // regardless of what any calling code passes in.
  for (const [field, cap] of Object.entries(LOGIC_CONDITIONS_FIELD_CAPS)) {
    if (typeof safeData[field] === "string" && safeData[field].length > cap) {
      safeData[field] = truncateAtBoundary(safeData[field], cap);
    }
  }

  return getPrisma().LogicConditions.create({ data: safeData });
}


/**
 * seedDefaultSettings -- seeds the typed, categorised Settings rows that
 * every business needs. Unlike Preference_key/Preference_value on
 * Structures (which stores everything as strings), each setting has
 * an explicit Data_Type so consumers don't need to parse.
 */
async function seedDefaultSettings(entrepriseId) {
  const settings = [
    // -- ACCOUNTING ---------------------------------------------------
    { category: "ACCOUNTING", name: "MATERIALITY_THRESHOLD", value: "5000", dataType: "DECIMAL", description: "Amounts below this are expensed immediately rather than capitalised. IAS 16 materiality." },
    { category: "ACCOUNTING", name: "DEPRECIATION_DEFAULT_METHOD", value: "STRAIGHT_LINE", dataType: "STRING", description: "Default depreciation method for new fixed assets." },
    { category: "ACCOUNTING", name: "FISCAL_YEAR_START", value: "01", dataType: "INT", description: "Month number (1-12) when the fiscal year begins." },
    { category: "ACCOUNTING", name: "DEFAULT_CURRENCY", value: "KES", dataType: "STRING", description: "Default currency for all transactions." },
    { category: "ACCOUNTING", name: "RECOGNITION_BASIS", value: "CASH", dataType: "STRING", description: "Default recognition basis: CASH or ACCRUAL. Cash is simpler for novice users; accrual is required for full IFRS compliance." },
    { category: "ACCOUNTING", name: "PRIMARY_FRAMEWORK", value: "IFRS_FOR_SMES", dataType: "STRING", description: "Primary accounting framework. Individual standard references are educational -- not a claim of full IFRS compliance." },
    { category: "ACCOUNTING", name: "RESIDUAL_VALUE_DEFAULT", value: "0", dataType: "DECIMAL", description: "Default residual value for new assets when the owner doesn't know. KES 0 is conservative." },

    // -- INVENTORY ----------------------------------------------------
    { category: "INVENTORY", name: "COST_FORMULA", value: "FIFO", dataType: "STRING", description: "Inventory cost formula: FIFO, WEIGHTED_AVERAGE, or SPECIFIC. IAS 2.25." },
    { category: "INVENTORY", name: "REORDER_ALERT_ENABLED", value: "1", dataType: "BOOLEAN", description: "Alert when stock falls below reorder level." },
    { category: "INVENTORY", name: "EXPIRY_TRACKING_ENABLED", value: "0", dataType: "BOOLEAN", description: "Track expiry dates on perishable inventory." },
    { category: "INVENTORY", name: "SPOILAGE_WRITE_OFF_AUTO", value: "0", dataType: "BOOLEAN", description: "Automatically write off expired inventory at period close." },
    { category: "INVENTORY", name: "NRV_CHECK_ENABLED", value: "0", dataType: "BOOLEAN", description: "Check Net Realisable Value at period end (IAS 2.28 -- lower of cost and NRV)." },

    // -- CASH_FLOW ----------------------------------------------------
    { category: "CASH_FLOW", name: "CASH_FLOW_METHOD", value: "INDIRECT", dataType: "STRING", description: "Cash flow statement method: DIRECT or INDIRECT. IAS 7." },
    { category: "CASH_FLOW", name: "INTEREST_CLASSIFICATION", value: "OPERATING", dataType: "STRING", description: "Where interest paid appears on the cash flow: OPERATING or FINANCING. IAS 7 policy choice." },
    { category: "CASH_FLOW", name: "DIVIDEND_CLASSIFICATION", value: "OPERATING", dataType: "STRING", description: "Where dividends received appear: OPERATING or INVESTING. IAS 7 policy choice." },

    // -- COMPLIANCE ---------------------------------------------------
    { category: "COMPLIANCE", name: "VAT_RATE", value: "16.00", dataType: "DECIMAL", description: "Standard VAT rate. Kenya: 16%." },
    { category: "COMPLIANCE", name: "VAT_REGISTERED", value: "0", dataType: "BOOLEAN", description: "Whether this business is VAT registered with KRA." },
    { category: "COMPLIANCE", name: "WITHHOLDING_TAX_RATE", value: "5.00", dataType: "DECIMAL", description: "Withholding tax rate on payments to suppliers (if applicable)." },
    { category: "COMPLIANCE", name: "TAX_FILING_FREQUENCY", value: "ANNUAL", dataType: "STRING", description: "How often the business files tax returns: MONTHLY, QUARTERLY, ANNUAL." },
    { category: "COMPLIANCE", name: "COUNTY_RATES_ANNUAL", value: "0", dataType: "DECIMAL", description: "Annual county land rates -- set to actual amount so the system can warn when it's due. KES 0 = not applicable." },
    { category: "COMPLIANCE", name: "BUSINESS_PERMIT_ANNUAL", value: "0", dataType: "DECIMAL", description: "Annual single business permit cost. KES 0 = not applicable." },

    // -- USER ---------------------------------------------------------
    { category: "USER", name: "REQUIRE_EVIDENCE_ON_POST", value: "0", dataType: "BOOLEAN", description: "Require evidence attachment before a transaction can be posted." },
    { category: "USER", name: "AUTO_OPEN_PERIOD", value: "1", dataType: "BOOLEAN", description: "Automatically open today's period when the first transaction is posted." },
    { category: "USER", name: "RECEIPT_AUTO_GENERATE", value: "1", dataType: "BOOLEAN", description: "Automatically generate a receipt Document for every basket sale." },
    { category: "USER", name: "SHOW_ACCOUNTING_JARGON", value: "0", dataType: "BOOLEAN", description: "Show technical accounting terms (DR/CR, accrual) in the interface. Off = plain language for novice owners." },

    // -- SUCCESSION ---------------------------------------------------
    { category: "SUCCESSION", name: "SUCCESSION_PLAN_ACTIVE", value: "0", dataType: "BOOLEAN", description: "Whether a formal succession plan exists for this business." },
    { category: "SUCCESSION", name: "SUCCESSION_REVIEW_FREQUENCY", value: "ANNUAL", dataType: "STRING", description: "How often the succession plan should be reviewed." },
  ];

  for (const s of settings) {
    const existing = await getPrisma().Settings.findFirst({
      where: { Setting_Name: s.name, Entreprise_id: entrepriseId },
    });
    if (!existing) {
      await getPrisma().Settings.create({
        data: {
          Setting_Category: s.category,
          Setting_Name: s.name,
          Setting_Value: s.value,
          Data_Type: s.dataType,
          Description: s.description,
          Entreprise_id: entrepriseId,
        },
      });
    }
  }
}

/**
 * seedPeriodEndChecks -- seeds the default period-end checklist as
 * Structures rows (Structures_Type = "PERIOD_END_CHECK"). Each row
 * defines one check: its name (maps to an evaluation function in
 * accounting_practice.js), its Rule_Severity (BLOCK/WARN/INFO), and an
 * optional Preference_value for threshold configuration.
 */
async function seedPeriodEndChecks(entrepriseId) {
  const checks = [
    { name: "JOURNAL_BALANCED", description: "Every debit must be matched by an equal credit. A period with an out-of-balance Journal should never be closed.", severity: "BLOCK", threshold: null },
    { name: "DEPRECIATION_RUN", description: "If the business has depreciating assets, at least one depreciation entry must have been posted in this period.", severity: "WARN", threshold: null },
    { name: "OPEN_RECEIVABLES_AGE", description: "Review any trade receivables still outstanding. Threshold (days) is configurable via Preference_value.", severity: "INFO", threshold: 30 },
    { name: "PROVISIONS_REVIEWED", description: "IAS 37 requires provisions to be reviewed at each reporting date.", severity: "INFO", threshold: 90 },
    { name: "INSURANCE_ACTIVE", description: "A business with fixed assets should have at least one active insurance policy.", severity: "INFO", threshold: null },
    { name: "STOCK_COUNT_VERIFIED", description: "Physical stock count should be reconciled against system quantities before closing a period.", severity: "INFO", threshold: null },
  ];

  for (const check of checks) {
    await upsertStructure({
      Structures_Type: "PERIOD_END_CHECK",
      Structure_Level: "RULE",
      Framework_Name: "INTERNAL",
      Framework_Priority: 4,
      Structures_Name: check.name,
      Structures_Description: check.description,
      Mandatory: check.severity === "BLOCK" ? 1 : 0,
      Rule_Severity: check.severity,
      Preference_value: check.threshold ? String(check.threshold) : null,
      Entreprise_id: entrepriseId,
    });
  }
}


module.exports = { seedAccountingRules, seedDefaultSettings, seedPeriodEndChecks };
