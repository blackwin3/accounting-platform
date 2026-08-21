let _prisma;
function getPrisma() { if (!_prisma) { _prisma = require("../posting/core").prisma; } return _prisma; }
const { postFunding, postAssetPurchase, postBasket } = require("../postingEngine");

async function upsertProduct(name, price, cost, businessUnit = "SHOP", entrepriseId) {
  const existing = await getPrisma().Product.findFirst({ where: { Product_Name: name, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return getPrisma().Product.create({
    data: { Product_Name: name, Product_type: "Goods", Product_Price: price, Product_Cost: cost, Product_Unit: "unit", Business_Unit: businessUnit, Entreprise_id: entrepriseId },
  });
}

async function upsertResource(productId, quantity) {
  const existing = await getPrisma().Resources.findFirst({ where: { Product_id: productId } });
  if (existing) return existing;
  return getPrisma().Resources.create({
    data: {
      Product_id: productId,
      Resource_type: "INVENTORY",
      Resource_Class: "INVENTORY",
      Resources_Quantity: quantity,
      Resources_Status: "AVAILABLE",
      Resources_Source: "PURCHASE",
      Last_updated: new Date(),
    },
  });
}

/**
 * seedChebetFamily — Stage 1 of the Chebet family biography seeding.
 * Real Stakeholder + Management rows for Daniel, Grace, the niece
 * (advisor), and the grandson (successor), plus FARM catalog items
 * (milk, eggs) so the FARM business unit has real products to sell
 * from, matching the multi-unit test case.
 *
 * Deliberately does NOT touch RENTAL or INVESTMENTS yet, or write any
 * Knowledge/succession narrative entries — those are Stage 2.
 */
async function seedChebetFamily(defaultCatalogueId, entrepriseId) {
  // --- Stakeholders: the people behind the business ---
  const daniel = await upsertStakeholder({
    First_name: "Daniel",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Owner",
    Stakeholder_Role: "Owner",
    Relationship_to_owner: null, // Daniel is the owner himself
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const grace = await upsertStakeholder({
    First_name: "Grace",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Owner",
    Stakeholder_Role: "Owner",
    Relationship_to_owner: "Spouse",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const niece = await upsertStakeholder({
    First_name: "Niece",
    Last_name: "Chebet",
    Location: "Nairobi",
    Stakeholder_Category: "Accountant", // financial guidance, per the biography
    Stakeholder_Role: "Employee",
    Relationship_to_owner: "Niece",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const grandson = await upsertStakeholder({
    First_name: "Grandson",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Child Successor",
    Stakeholder_Role: "Employee",
    Relationship_to_owner: "Grandson",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  const daughterInLaw = await upsertStakeholder({
    First_name: "Daughter-in-law",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Employee",
    Stakeholder_Role: "Employee",
    Relationship_to_owner: "Daughter-in-law",
    Relationship_Status: "ACTIVE",
    Entreprise_id: entrepriseId,
  });

  // The son — modelled as data, not just narrative, because his reduced
  // involvement in succession planning is a structurally significant fact
  // the schema should be able to show: Relationship_Status=ESTRANGED and
  // Inheritance_Status=EXCLUDED, not merely described in prose.
  const son = await upsertStakeholder({
    First_name: "Son",
    Last_name: "Chebet",
    Location: "Naivasha",
    Stakeholder_Category: "Owner", // family member by birth, not by role
    Stakeholder_Role: "Owner",
    Relationship_to_owner: "Son",
    Relationship_Status: "ESTRANGED", // reduced day-to-day involvement in family affairs — see the Knowledge entry for the family's stated reasoning
    Entreprise_id: entrepriseId,
  });

  // --- Management: their roles/access in the system ---
  await upsertManagementForStakeholder({
    stakeholderId: daniel.Stakeholder_id,
    name: "Daniel Chebet",
    role: "Owner",
    administrationType: "Owner",
    inheritanceStatus: "CURRENT_OWNER",
    accessLevel: "OWNER_FULL",
    catalogueId: defaultCatalogueId,
    username: "daniel",
    password: "daniel123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: grace.Stakeholder_id,
    name: "Grace Chebet",
    role: "Manager",
    administrationType: "Family",
    inheritanceStatus: "CURRENT_OWNER", // co-owner of the farm specifically
    accessLevel: "MANAGER",
    catalogueId: defaultCatalogueId,
    username: "grace",
    password: "grace123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: niece.Stakeholder_id,
    name: "Niece (Advisor)",
    role: "Advisor",
    administrationType: "Family",
    inheritanceStatus: "ADVISOR",
    accessLevel: "ADVISOR",
    catalogueId: defaultCatalogueId,
    username: "niece",
    password: "niece123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: grandson.Stakeholder_id,
    name: "Grandson (Successor)",
    role: "Employee",
    administrationType: "child",
    inheritanceStatus: "SUCCESSOR",
    accessLevel: "VIEWER", // preparing for succession, not yet operating the business
    catalogueId: defaultCatalogueId,
    username: "grandson",
    password: "grandson123",
    entrepriseId,
  });

  await upsertManagementForStakeholder({
    stakeholderId: daughterInLaw.Stakeholder_id,
    name: "Daughter-in-law",
    role: "Manager",
    administrationType: "Family",
    inheritanceStatus: null, // not part of the succession line per the biography
    accessLevel: "MANAGER",
    catalogueId: defaultCatalogueId,
    arrangementType: "PROFIT_SHARE",
    arrangementRate: 50, // fifty-fifty profit share on produce she manages
    username: "daughterinlaw",
    password: "family123",
    entrepriseId,
  });

  // The son has a Management row so the exclusion is structurally visible
  // (Inheritance_Status=EXCLUDED), not just narrated in Knowledge text. No
  // login credentials — he has no active operating role in the business.
  await upsertManagementForStakeholder({
    stakeholderId: son.Stakeholder_id,
    name: "Son",
    role: "None",
    administrationType: "Family",
    inheritanceStatus: "EXCLUDED",
    accessLevel: "VIEWER",
    catalogueId: defaultCatalogueId,
    entrepriseId,
  });

  // --- FARM catalog: milk and eggs, the two products the biography
  //     explicitly says feed the shop from the farm. Stock is seeded at 0
  //     and then built up through a real posted purchase — not a manufactured
  //     "today's remaining stock" figure with no transaction behind it.
  //     Narratives should explain facts, not invent them.
  const milk = await upsertProduct("Fresh Milk (1L)", 80, 55, "FARM", entrepriseId);
  const eggs = await upsertProduct("Eggs (each)", 15, 10, "FARM", entrepriseId);
  await upsertResource(milk.Product_id, 0);
  await upsertResource(eggs.Product_id, 0);

  // The farm delivers today's milk and eggs to the shop as an actual
  // inventory purchase — DR Inventory CR Cash — so the resulting stock
  // quantity is a real consequence of a posted transaction, matching how
  // every other product's stock in this system is derived.
  const existingMilkDelivery = await getPrisma().Journal.findFirst({ where: { Description: { startsWith: "BUY_INVENTORY_CASH" }, Entreprise_id: entrepriseId, Product_id: milk.Product_id } });
  if (!existingMilkDelivery) {
    await postBasket({
      mode: "buy",
      lines: [{ productId: milk.Product_id, quantity: 80, unitPrice: 55 }], // today's ~80L farm delivery, at cost
      paymentMethod: "CASH",
      businessUnit: "FARM",
      entrepriseId,
    });
    // Today's selling activity so far — 68L sold, 12L genuinely remaining,
    // both numbers now real consequences of posted transactions rather than
    // an assumed opening balance.
    await postBasket({
      mode: "sell",
      lines: [{ productId: milk.Product_id, quantity: 68, unitPrice: 80 }],
      paymentMethod: "CASH",
      businessUnit: "FARM",
      entrepriseId,
    });
  }
  const existingEggsDelivery = await getPrisma().Journal.findFirst({ where: { Description: { startsWith: "BUY_INVENTORY_CASH" }, Entreprise_id: entrepriseId, Product_id: eggs.Product_id } });
  if (!existingEggsDelivery) {
    // A week's lay from 25 hens, delivered to the shop at cost
    await postBasket({
      mode: "buy",
      lines: [{ productId: eggs.Product_id, quantity: 45, unitPrice: 10 }],
      paymentMethod: "CASH",
      businessUnit: "FARM",
      entrepriseId,
    });
  }

  console.log("Chebet family (Stage 1) seeded: Stakeholders, Management, FARM products.");
  console.log("Chebet family login accounts (username / password):");
  console.log("  daniel / daniel123  (OWNER_FULL)");
  console.log("  grace / grace123  (MANAGER)");
  console.log("  niece / niece123  (ADVISOR)");
  console.log("  grandson / grandson123  (VIEWER)");
  console.log("  daughterinlaw / family123  (MANAGER)");

  // ---------------------------------------------------------------
  // Stage 2: RENTAL tenants, INVESTMENTS instruments, and Knowledge/
  // succession narrative entries.
  // ---------------------------------------------------------------
  await seedChebetStage2({ daniel, grace, niece, grandson, daughterInLaw, son, entrepriseId });
}

async function seedChebetStage2({ daniel, grace, niece, grandson, daughterInLaw, son, entrepriseId }) {
  // --- RENTAL: 15 one-bedroom houses as tenant Stakeholders ---
  const tenantNames = [
    "Wanjiru Kamau", "Otieno Owuor", "Njeri Mwangi", "Kiprotich Rono", "Achieng Odhiambo",
    "Muthoni Karanja", "Barasa Wafula", "Wambui Ndung'u", "Cheruiyot Kiplagat", "Nyambura Githinji",
    "Onyango Ochieng", "Wairimu Njoroge", "Kiptoo Bett", "Auma Adhiambo", "Mutiso Kioko",
  ];
  const tenantStakeholders = [];
  for (let i = 0; i < tenantNames.length; i++) {
    const s = await upsertStakeholder({
      First_name: tenantNames[i].split(" ")[0],
      Last_name: tenantNames[i].split(" ")[1] || "",
      Business_name: `House ${i + 1}`,
      Location: "Nakuru",
      Stakeholder_Category: "Customer",
      Stakeholder_Role: "Tenant",
      Relationship_to_owner: "Tenant",
      Relationship_Status: "ACTIVE",
      Entreprise_id: entrepriseId,
    });
    tenantStakeholders.push(s);
  }

  // --- INVESTMENTS: 2 government bonds + Co-op Bank shares as Money rows ---
  const codeRow4200 = await upsertCode("4200", "Interest Income — Bonds", "INCOME", "OTHER_INCOME", entrepriseId);
  const codeRow4300 = await upsertCode("4300", "Dividend Income", "INCOME", "OTHER_INCOME", entrepriseId);
  const interestAccount = await upsertAccount("Interest Income", "INCOME", codeRow4200.Account_codes_id, "CREDIT", entrepriseId);
  const dividendAccount = await upsertAccount("Dividend Income", "INCOME", codeRow4300.Account_codes_id, "CREDIT", entrepriseId);

  await upsertMoneyInstrument({
    accountId: interestAccount.Account_id,
    name: "KE Infrastructure Bond — 14yr",
    instrumentType: "MONEY_MARKET",
    instrumentClass: "AMORTIZED_COST",
    principal: 500000,
    interestRate: 12.5,
    startDate: new Date("2018-01-15"),
    maturityDate: new Date("2032-01-15"),
    entrepriseId,
  });

  await upsertMoneyInstrument({
    accountId: interestAccount.Account_id,
    name: "KE Infrastructure Bond — 18yr",
    instrumentType: "MONEY_MARKET",
    instrumentClass: "AMORTIZED_COST",
    principal: 500000,
    interestRate: 13.0,
    startDate: new Date("2018-01-15"),
    maturityDate: new Date("2036-01-15"),
    entrepriseId,
  });

  await upsertMoneyInstrument({
    accountId: dividendAccount.Account_id,
    name: "Co-operative Bank Shares",
    instrumentType: "MONEY_MARKET",
    instrumentClass: "FAIR_VALUE_OCI",
    principal: 180000,
    interestRate: null,
    startDate: new Date("2005-06-01"),
    maturityDate: null,
    entrepriseId,
  });

  // --- Knowledge: succession and institutional-memory entries ---
  //
  // IMPORTANT FRAMING: Management.Inheritance_Status (CURRENT_OWNER /
  // SUCCESSOR / EXCLUDED / ADVISOR / RETIRED) records what the family has
  // decided and intends — it is not, and must never be read as, a legal
  // determination of inheritance. Kenyan succession law (and most East
  // African jurisdictions) requires a will, a trust instrument, or a
  // court-recognised process before any exclusion or designation is
  // legally binding. The two Knowledge entries below deliberately state
  // this distinction directly, and the second one names the concrete gap
  // (no legal instrument on file) rather than letting the database's own
  // confident-looking status field imply the matter is settled.
  await upsertKnowledge({
    knowledgeType: "DECISION_REASON",
    explanation: "Family succession intention — grandson identified as primary successor, son not currently involved. This is the family's stated intention, not a legal determination.",
    decisionReason:
      "The family has assessed availability, demonstrated interest, and readiness to take on operational responsibility when weighing who should be prepared for succession. The grandson has shown consistent engagement with the business and its investments over an extended period and has been gradually given more responsibility as a result. This reflects the family's current thinking about who should take on that role — it does not by itself change anyone's legal entitlement to inherit, which depends on a will, trust, or other legal instrument.",
    context: "SUCCESSION",
    confidenceLevel: 5,
    authorStakeholderId: daniel.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "WARNING",
    explanation: "Legal status of the succession plan — not yet verified.",
    recommendation:
      "No will, trust, or other legal instrument recording this succession intention has been recorded in this system. Until one exists, the family's stated preference (grandson as successor, son not currently involved) has no legal effect on inheritance, and a professional review with a lawyer is recommended before treating it as settled. Required next steps: (1) draft and execute a will or equivalent legal instrument, (2) have it reviewed by a lawyer familiar with succession law in this jurisdiction, (3) record the resulting document under Documents once it exists.",
    context: "SUCCESSION",
    confidenceLevel: 2, // low confidence deliberately — this documents an open gap, not a settled fact
    authorStakeholderId: daniel.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "RECOMMENDATION",
    explanation: "Role of professional advisors in ongoing decisions.",
    recommendation:
      "Daniel relies on his niece for financial guidance when evaluating investments and banking services. A local accountant periodically reviews financial statements and year-end adjustments. Bank officers evaluate financial reports whenever financing or investment opportunities arise. Future successors should maintain these relationships rather than trying to replace professional expertise with family judgement alone.",
    context: "SUCCESSION",
    confidenceLevel: 4,
    authorStakeholderId: niece.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "LESSON_LEARNED",
    explanation: "Why the farm supports the shop rather than operating as a fully separate business.",
    lessonLearned:
      "Fresh milk is purchased each morning from the family's own dairy cows and repackaged for retail; eggs are purchased weekly from the farm's poultry. Treating the farm-to-shop movement as an internal transfer rather than a sale-and-purchase between two unrelated businesses avoids double-counting income in the consolidated view.",
    context: "FAMILY",
    confidenceLevel: 5,
    authorStakeholderId: grace.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "EXPLANATION",
    explanation: "What the grandson inherits beyond the assets themselves.",
    recommendation:
      "Business records, accounting reports, operating procedures, supplier relationships, investment history, loan repayments, rental management, and financial decisions are documented so that the incoming generation understands not only what assets exist but how those assets were acquired, managed, and sustained. Ownership alone does not guarantee good stewardship — the intention is to transfer knowledge, not just title.",
    context: "SUCCESSION",
    confidenceLevel: 5,
    authorStakeholderId: daniel.Stakeholder_id,
    entrepriseId,
  });

  await upsertKnowledge({
    knowledgeType: "EXPLANATION",
    explanation: "Who actually keeps the business running day to day.",
    recommendation:
      "Whenever Daniel and Grace are travelling or attending to other responsibilities, the daughter-in-law oversees both the village shop and the farm — supervising employees, making sure produce reaches market, and keeping daily business running uninterrupted. She has become, in practice, the operational manager of the household enterprise, even though she holds no ownership stake and no formal place in the succession line.",
    context: "FAMILY",
    confidenceLevel: 5,
    authorStakeholderId: daughterInLaw.Stakeholder_id,
    entrepriseId,
  });

  console.log("Chebet family (Stage 2) seeded: 15 rental tenants, 2 bonds + Co-op shares, 5 Knowledge/succession entries.");

  // ---------------------------------------------------------------
  // Stage 3: the business's actual origin transactions. The biography
  // gives specific figures for these — until now they existed only as
  // narrative text, never posted, so the ledger had no founding capital
  // and Cash could never genuinely start positive from Chebet data alone.
  // Posted through the real engine (not raw Prisma writes) so they
  // produce the same balanced Journal trail as every other transaction.
  // ---------------------------------------------------------------
  const existingCapital = await getPrisma().Journal.findFirst({ where: { Description: { startsWith: "OWNER_CAPITAL_INJECTION" }, Entreprise_id: entrepriseId } });
  if (!existingCapital) {
    await postFunding({
      source: "CAPITAL",
      amount: 350000,
      paymentMethod: "BANK",
      notes: "Initial capital from pension benefits, contributed at retirement, early 2020.",
      businessUnit: "SHOP",
      entrepriseId,
    });
  }

  const existingLoan = await getPrisma().Journal.findFirst({ where: { Description: { startsWith: "LOAN_DRAWDOWN" }, Entreprise_id: entrepriseId } });
  if (!existingLoan) {
    await postFunding({
      source: "LOAN",
      amount: 1000000,
      paymentMethod: "BANK",
      notes: "Business loan, repayable over eight years at 7% annual interest, taken at retirement.",
      businessUnit: "SHOP",
      entrepriseId,
    });
  }

  const existingVehicle = await getPrisma().Assets.findFirst({ where: { Assets_Type: "Toyota Vitz", Entreprise_id: entrepriseId } });
  if (!existingVehicle) {
    // The biography names the vehicle and its 2017 purchase date but does not
    // give a price; this cost is a reasonable period estimate, not a
    // documented figure, and should be corrected if a real value is known.
    await postAssetPurchase({
      name: "Toyota Vitz",
      cost: 1200000,
      usefulLifeYears: 8,
      residualValue: 200000,
      depreciationMethod: "STRAIGHT_LINE",
      paymentMethod: "BANK",
      businessUnit: "SHOP",
      entrepriseId,
    });
  }

  console.log("Chebet family (Stage 3) seeded: founding capital (350,000), founding loan (1,000,000 @ 7%/8yr), Toyota Vitz asset.");
}

async function upsertStakeholder(fields) {
  const existing = await getPrisma().Stakeholder.findFirst({
    where: { First_name: fields.First_name, Last_name: fields.Last_name, Entreprise_id: fields.Entreprise_id },
  });
  if (existing) return existing;
  return getPrisma().Stakeholder.create({ data: fields });
}

async function upsertManagementForStakeholder({
  stakeholderId,
  name,
  role,
  administrationType,
  inheritanceStatus,
  accessLevel,
  catalogueId,
  arrangementType = null,
  arrangementRate = null,
  username = null,
  password = null,
  entrepriseId,
}) {
  const existing = await getPrisma().Management.findFirst({ where: { Stakeholder_id: stakeholderId } });
  if (existing) return existing;
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  return getPrisma().Management.create({
    data: {
      Catalogue_id: catalogueId,
      Stakeholder_id: stakeholderId,
      Management_Name: name,
      Management_Role: role,
      Administration_type: administrationType,
      Inheritance_Status: inheritanceStatus,
      Access_Level: accessLevel,
      Arrangement_Type: arrangementType,
      Arrangement_Rate: arrangementRate,
      Username: username,
      Password_Hash: passwordHash,
      Entreprise_id: entrepriseId,
    },
  });
}

async function upsertMoneyInstrument({ accountId, name, instrumentType, instrumentClass, principal, interestRate, startDate, maturityDate, entrepriseId }) {
  const existing = await getPrisma().Money.findFirst({ where: { Money_Name: name, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return getPrisma().Money.create({
    data: {
      Account_id: accountId,
      Instrument_type: instrumentType,
      Instrument_Class: instrumentClass,
      Accounting_Treatment: instrumentClass === "AMORTIZED_COST" ? "AMORTIZED_COST_EIR" : "FAIR_VALUE_MARKET",
      Money_Status: "ACTIVE",
      Risk_Level: "LOW",
      Money_Name: name,
      Principal_amount: principal,
      Interest_rate: interestRate,
      Outstanding_Amount: principal,
      Start_date: startDate,
      Maturity_date: maturityDate,
      Entreprise_id: entrepriseId,
    },
  });
}

async function upsertKnowledge({
  knowledgeType,
  explanation,
  recommendation = null,
  lessonLearned = null,
  decisionReason = null,
  context,
  confidenceLevel,
  authorStakeholderId,
  entrepriseId,
}) {
  const existing = await getPrisma().Knowledge.findFirst({ where: { Explanation: explanation, Entreprise_id: entrepriseId } });
  if (existing) return existing;
  return getPrisma().Knowledge.create({
    data: {
      Explanation: explanation,
      Knowledge_type: knowledgeType,
      Recommendation: recommendation,
      Lesson_Learned: lessonLearned,
      Decision_Reason: decisionReason,
      Context: context,
      Confidence_Level: confidenceLevel,
      Language: "en",
      Author: authorStakeholderId,
      Entry_date: new Date(),
      Entreprise_id: entrepriseId,
    },
  });
}

module.exports = { seedChebetFamily, seedChebetStage2, upsertProduct, upsertResource, upsertStakeholder, upsertManagementForStakeholder, upsertMoneyInstrument, upsertKnowledge };
