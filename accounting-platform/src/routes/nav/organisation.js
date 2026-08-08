const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

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

module.exports = router;
