const express = require("express");
const router = express.Router();
const { prisma, round2 } = require("../../services/postingEngine");

// GET /organisation/business
router.get("/organisation/business", async (req, res) => {
  try {
    // Fixed while extracting: this route had no Entreprise_id filter at
    // all — Organisation.findFirst() with zero where clause returned
    // whichever business's profile happened to be first in the table,
    // regardless of who was logged in. Same leak class as several others
    // found and fixed in earlier sessions, missed on this specific route.
    // Entreprise_id is Organisation's own primary key, so findUnique is
    // the correct, precise lookup here.
    const entrepriseId = req.currentUser.Entreprise_id;
    const org = await prisma.Organisation.findUnique({ where: { Entreprise_id: entrepriseId } });

    const sourceOfTruthRows = await prisma.Structures.findMany({
      where: { Structures_Type: "SYSTEM_ARCHITECTURE", Structure_Level: "RULE", Entreprise_id: null },
      orderBy: { Structures_id: "asc" },
    });

    res.render("business", {
      title: "Business",
      active: "business",
      organisation: org
        ? {
            name: org.Organisational_Name,
            industry: org.Industry,
            type: org.Organisation_Type,
            address: org.Organisation_Address,
            country: org.Organisation_Country,
            currency: org.Organisation_Currency,
            businessUnits: org.Business_Units,
          }
        : null,
      sourceOfTruth: sourceOfTruthRows.map((r) => {
        const [question, note] = (r.Structures_Description || "").split("|");
        return {
          question: question || "",
          table: r.Structures_Name,
          note: note || "",
          isPopulated: r.Rule_Severity === "BLOCK",
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading business profile: " + err.message);
  }
});

// GET /organisation/stakeholders
router.get("/organisation/stakeholders", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Stakeholder.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Stakeholder_id: "desc" } });
    res.render("stakeholders", {
      title: "Stakeholders",
      active: "stakeholders",
      stakeholders: rows.map((s) => ({
        name: [s.First_name, s.Last_name].filter(Boolean).join(" ") || s.Business_name || `#${s.Stakeholder_id}`,
        category: s.Stakeholder_Category,
        relationship: s.Relationship_to_owner,
        location: s.Location,
        status: s.Relationship_Status,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading stakeholders: " + err.message);
  }
});

// GET /organisation/management
router.get("/organisation/management", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Management.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Administration_id: "desc" } });
    const stakeholderIds = rows.map((m) => m.Stakeholder_id).filter(Boolean);
    const stakeholders = await prisma.Stakeholder.findMany({ where: { Stakeholder_id: { in: stakeholderIds } } });
    const stakeholderById = Object.fromEntries(stakeholders.map((s) => [s.Stakeholder_id, s]));

    const linkedIds = new Set(stakeholderIds);
    const allStakeholders = await prisma.Stakeholder.findMany({ where: { Entreprise_id: entrepriseId } });
    const availableStakeholders = allStakeholders
      .filter((s) => !linkedIds.has(s.Stakeholder_id))
      .map((s) => ({ id: s.Stakeholder_id, name: [s.First_name, s.Last_name].filter(Boolean).join(" ") || s.Business_name }));

    const ownerCount = rows.filter((m) => m.Access_Level === "OWNER_FULL").length;

    res.render("management", {
      title: "Management",
      active: "management",
      currentUserId: req.currentUser ? req.currentUser.Administration_id : null,
      ownerCount,
      managementRows: rows.map((m) => ({
        id: m.Administration_id,
        name: m.Management_Name || (stakeholderById[m.Stakeholder_id] ? [stakeholderById[m.Stakeholder_id].First_name, stakeholderById[m.Stakeholder_id].Last_name].filter(Boolean).join(" ") : `#${m.Administration_id}`),
        role: m.Management_Role,
        accessLevel: m.Access_Level,
        inheritanceStatus: m.Inheritance_Status,
        username: m.Username,
        // Matches CAPITAL_APPROVAL_ROLES in api-accounting.js exactly —
        // this reflects a real, enforced restriction (capital
        // withdrawal, loan repayment, investment purchase/sale, rental
        // property purchase all check this server-side), not a
        // decorative label.
        canApproveCapital: m.Access_Level === "OWNER_FULL" || m.Access_Level === "ACCOUNTANT",
      })),
      availableStakeholders,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading management: " + err.message);
  }
});

// GET /organisation/processing — repackage/convert inventory: eggs into
// trays, bulk milk into bottles, and similar. Shows every eligible input
// product (real Goods with stock on hand) so the form can be built
// without a page reload once the person picks their inputs.
router.get("/organisation/processing", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    // Goods, Services, and Assets can all be genuine inputs — Labour (a
    // Service) as a factored cost when building a new inventory item or
    // asset, e.g. wood + labour into a finished construction product, is
    // exactly the case this was missing before. Utilities stay excluded:
    // a utility bill isn't a factorable input the way a material or a
    // labour charge is.
    //
    // Matched on Entreprise_id alone, not also Business_Unit: a product
    // created before Business_Unit was consistently set on every new
    // Product row would otherwise be silently invisible here even though
    // it's a completely real, usable product for this business — the
    // same "not backfilled onto existing rows" pattern already found
    // once this session with Expenditure_Behaviour. A repackaging input
    // list is exactly the place where silently hiding a real product is
    // worse than showing one that technically belongs to a different
    // unit than currently selected.
    const products = await prisma.Product.findMany({
      where: { Is_Utility: 0, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });
    const productIds = products.map((p) => p.Product_id);
    const resources = await prisma.Resources.findMany({ where: { Product_id: { in: productIds } } });
    const stockByProduct = Object.fromEntries(resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)]));

    // Recent repackaging history, for the log at the bottom of the page —
    // identified by the REPACKAGE_INVENTORY Catalogue event.
    const catalogue = await prisma.Catalogue.findFirst({ where: { Event_Name: "REPACKAGE_INVENTORY", Entreprise_id: entrepriseId } });
    let history = [];
    if (catalogue) {
      const recordsRows = await prisma.Records.findMany({
        where: { Catalogue_id: catalogue.Catalogue_id, Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
        orderBy: { Records_id: "desc" },
        take: 20,
      });
      const narrativeRows = await prisma.Narrative.findMany({ where: { Entreprise_id: entrepriseId } });
      const narrativeByRecordsId = Object.fromEntries(narrativeRows.map((n) => [n.Records_id, n.Description]));
      history = recordsRows.map((r) => ({
        date: r.Records_date ? new Date(r.Records_date).toLocaleString("en-GB") : "",
        total: Number(r.Records_Totals || 0),
        description: narrativeByRecordsId[r.Records_id] || "",
      }));
    }

    res.render("processing", {
      title: "Processing",
      active: "processing",
      currentBusinessUnit: req.currentBusinessUnit,
      products: products.map((p) => ({
        id: p.Product_id,
        name: p.Product_Name,
        stock: stockByProduct[p.Product_id] ?? 0,
        cost: Number(p.Product_Cost || 0),
        unit: p.Product_Unit,
        isService: !!p.Is_Service,
        isAsset: !!p.Is_Asset,
        isStockedGood: !p.Is_Service && !p.Is_Asset,
      })),
      history,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading processing: " + err.message);
  }
});

// GET /organisation/livestock — individual animal AND crop planting
// register. Modelled deliberately on the Rental unit's own tenant
// pattern: an animal or planting is checked in on periodically (Monthly
// Review) without every check-in being a cash event, the same way a
// tenant is checked in on without every visit collecting rent.
router.get("/organisation/livestock", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });
    const productIds = products.map((p) => p.Product_id);
    const productById = Object.fromEntries(products.map((p) => [p.Product_id, p]));

    const animals = await prisma.Resources.findMany({
      where: { Product_id: { in: productIds }, Resource_Class: "BIOLOGICAL_ASSET" },
      orderBy: { Animal_Tag: "asc" },
    });
    const animalById = Object.fromEntries(animals.map((a) => [a.Resources_id, a]));

    // Real Goods products (not the register itself) — what a harvest
    // actually becomes: sellable inventory, not another register row.
    const goodsProducts = products.filter((p) => !p.Is_Service && !p.Is_Utility && !p.Is_Asset);

    const today = new Date();
    function ageLabel(birthDate) {
      if (!birthDate) return "Unknown";
      const months = Math.floor((today - new Date(birthDate)) / (1000 * 60 * 60 * 24 * 30.44));
      if (months < 1) return "< 1 month";
      if (months < 24) return `${months} month${months === 1 ? "" : "s"}`;
      return `${Math.floor(months / 12)} year${Math.floor(months / 12) === 1 ? "" : "s"}`;
    }
    function reviewStatus(lastReviewDate) {
      if (!lastReviewDate) return { label: "Never reviewed", overdue: true };
      const daysSince = Math.floor((today - new Date(lastReviewDate)) / (1000 * 60 * 60 * 24));
      return { label: `${daysSince} day${daysSince === 1 ? "" : "s"} ago`, overdue: daysSince > 35 };
    }

    res.render("livestock", {
      title: "Agriculture & Livestock",
      active: "livestock",
      currentBusinessUnit: req.currentBusinessUnit,
      products: products.filter((p) => !p.Is_Service && !p.Is_Utility).map((p) => ({ id: p.Product_id, name: p.Product_Name })),
      goodsProducts: goodsProducts.map((p) => ({ id: p.Product_id, name: p.Product_Name })),
      // Only available, female, LIVESTOCK animals can be a mother in the
      // birth-linking dropdown — a crop planting or a male animal simply
      // isn't a valid choice, so they're filtered out here rather than
      // relying on the form to catch a mistake the data already rules out.
      mothers: animals
        .filter((a) => a.Resource_Category === "LIVESTOCK" && a.Animal_Sex === "FEMALE" && a.Resources_Status === "AVAILABLE")
        .map((a) => ({ id: a.Resources_id, tag: a.Animal_Tag, species: productById[a.Product_id] ? productById[a.Product_id].Product_Name : "" })),
      animals: animals.map((a) => {
        const review = reviewStatus(a.Last_Review_Date);
        const parent = a.Parent_Resources_id ? animalById[a.Parent_Resources_id] : null;
        return {
          id: a.Resources_id,
          tag: a.Animal_Tag,
          category: a.Resource_Category,
          species: productById[a.Product_id] ? productById[a.Product_id].Product_Name : "Unknown",
          productId: a.Product_id,
          sex: a.Animal_Sex || "—",
          age: ageLabel(a.Resources_Manufacture_Date),
          growthStage: a.Growth_Stage || "—",
          condition: a.Resources_Quality || "—",
          status: a.Resources_Status,
          fairValue: a.Fair_Value != null ? Number(a.Fair_Value) : null,
          reviewLabel: review.label,
          reviewOverdue: review.overdue,
          parentTag: parent ? parent.Animal_Tag : null,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading livestock: " + err.message);
  }
});

// GET /organisation/services-wip — work-in-progress tracking for
// genuine effort-based Services (carpentry, consulting, repair). A
// Service with Is_Utility=1 (internet, electricity) is deliberately
// excluded here — it already has its own instant-purchase consumption
// cycle through the Till and needs none of this.
router.get("/organisation/services-wip", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const serviceProducts = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Is_Service: 1, Is_Utility: 0, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });
    const productIds = serviceProducts.map((p) => p.Product_id);
    const productById = Object.fromEntries(serviceProducts.map((p) => [p.Product_id, p]));

    const engagements = await prisma.Resources.findMany({
      where: { Product_id: { in: productIds }, Resource_Class: "WORK_IN_PROGRESS" },
      orderBy: { Resources_id: "desc" },
    });

    res.render("services-wip", {
      title: "Services",
      active: "services-wip",
      currentBusinessUnit: req.currentBusinessUnit,
      serviceProducts: serviceProducts.map((p) => ({ id: p.Product_id, name: p.Product_Name })),
      engagements: engagements.map((e) => ({
        id: e.Resources_id,
        service: productById[e.Product_id] ? productById[e.Product_id].Product_Name : "Unknown",
        client: e.Service_Client || "—",
        hourlyRate: Number(e.Hourly_Rate || 0),
        hoursLogged: Number(e.Hours_Logged || 0),
        value: Number(e.Fair_Value || 0),
        status: e.Resources_Status,
        lastUpdated: e.Last_updated ? new Date(e.Last_updated).toLocaleString("en-GB") : "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading services: " + err.message);
  }
});

// GET /organisation/government — taxes, levies, grants, and government
// service payments like land rates and county permits.
router.get("/organisation/government", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;

    // Tax-related expenses
    const taxTransactions = await prisma.Transactions.findMany({
      where: { Entreprise_id: entrepriseId },
    });
    const catalogues = await prisma.Catalogue.findMany({
      where: { Entreprise_id: entrepriseId },
    });
    const taxEventNames = ["PAY_EXPENSE_TAX"];
    const taxCatalogueIds = catalogues.filter((c) => taxEventNames.includes(c.Event_Name)).map((c) => c.Catalogue_id);

    const taxJournals = await prisma.Journal.findMany({
      where: { Catalogue_id: { in: taxCatalogueIds }, Entreprise_id: entrepriseId },
      orderBy: { Created_at: "desc" },
      take: 50,
    });
    const taxPaid = taxJournals.reduce((sum, j) => sum + Number(j.Debit || 0), 0);

    // Government grants (unit income with source = GRANT or OTHER)
    const grantIncomeRows = await prisma.Income.findMany({
      where: { Income_Category: "DONATION", Entreprise_id: entrepriseId },
    });
    const grantsReceived = grantIncomeRows.reduce((sum, i) => sum + Number(i.Net_Amount || 0), 0);

    // Government stakeholders
    const govStakeholders = await prisma.Stakeholder.findMany({
      where: { Stakeholder_Category: "Government", Entreprise_id: entrepriseId },
    });

    // Provisions tagged for government charges
    const govProvisions = await prisma.Liability.findMany({
      where: { Liability_Type: { in: ["Government Provision", "Warranty Provision"] }, Net_Amount: { gt: 0 }, Entreprise_id: entrepriseId },
    });
    const provisionedForGov = govProvisions.reduce((sum, p) => sum + Number(p.Net_Amount || 0), 0);

    // Settings for VAT
    const vatRateSetting = await prisma.Settings.findFirst({ where: { Setting_Name: "VAT_RATE", Entreprise_id: entrepriseId } });
    const vatRegSetting = await prisma.Settings.findFirst({ where: { Setting_Name: "VAT_REGISTERED", Entreprise_id: entrepriseId } });

    // Government expenses — tax category Journal entries as display rows
    const govExpenses = taxJournals.map((j) => ({
      description: j.Description || "Tax payment",
      category: "TAX",
      amount: Number(j.Debit || 0),
      date: j.Created_at ? new Date(j.Created_at).toLocaleDateString("en-GB") : "—",
    }));

    res.render("government", {
      title: "Government",
      active: "government",
      currentBusinessUnit: req.currentBusinessUnit,
      vatRate: vatRateSetting ? Number(vatRateSetting.Setting_Value) : 16,
      vatRegistered: vatRegSetting ? vatRegSetting.Setting_Value === "1" : false,
      taxPaid: round2(taxPaid),
      grantsReceived: round2(grantsReceived),
      provisionedForGov: round2(provisionedForGov),
      unprovisionedCharges: 0,
      govExpenses,
      govStakeholders: govStakeholders.map((s) => ({
        name: s.Business_name || `${s.First_name || ""} ${s.Last_name || ""}`.trim(),
        role: s.Stakeholder_Role || s.Stakeholder_Category,
        phone: s.Tel_1,
        email: s.Email_1,
      })),
      fmt: (n) => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading government page: " + err.message);
  }
});

module.exports = router;
