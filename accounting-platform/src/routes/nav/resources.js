const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

// GET /resources — the Resources group dashboard (products, assets)
router.get("/resources", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({ where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId } });
    const productIds = products.map((p) => p.Product_id);
    const resources = await prisma.Resources.findMany({ where: { Product_id: { in: productIds } } });
    const stockByProduct = Object.fromEntries(resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)]));

    const lowStockCount = products.filter((p) => {
      if (p.Is_Service || p.Is_Utility) return false;
      const stock = stockByProduct[p.Product_id] ?? 0;
      const threshold = p.Product_Reorder_Level != null ? Number(p.Product_Reorder_Level) : 10;
      return stock <= threshold;
    }).length;

    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);
    const assetRows = await prisma.Assets.findMany({ where: { Records_id: { in: unitRecordIds } } });
    const assetCarryingValue = assetRows.reduce((sum, a) => sum + Number(a.Carrying_Amount || 0), 0);

    res.render("resources", {
      title: "Resources",
      active: "resources",
      currentBusinessUnit: req.currentBusinessUnit,
      productCount: products.length,
      lowStockCount,
      assetCount: assetRows.length,
      assetCarryingValue,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading resources dashboard: " + err.message);
  }
});

// GET /resources/inventory — goods in stock
router.get("/resources/inventory", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Is_Service: 0, Is_Utility: 0, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });
    const productIds = products.map((p) => p.Product_id);
    const resources = await prisma.Resources.findMany({ where: { Product_id: { in: productIds } } });
    const stockByProduct = Object.fromEntries(resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)]));

    // A product with any Transactions history can no longer be edited or
    // deleted — only discontinued. Checked once here for the whole list
    // rather than per-row, to avoid N+1 queries.
    const usedTransactions = await prisma.Transactions.findMany({
      where: { Product_id: { in: productIds }, Entreprise_id: entrepriseId },
      select: { Product_id: true },
    });
    const usedProductIds = new Set(usedTransactions.map((t) => t.Product_id));

    res.render("inventory", {
      title: "Inventory",
      active: "inventory",
      currentBusinessUnit: req.currentBusinessUnit,
      items: products.map((p) => ({
        id: p.Product_id,
        name: p.Product_Name,
        stock: stockByProduct[p.Product_id] ?? 0,
        price: Number(p.Product_Price || 0),
        cost: Number(p.Product_Cost || 0),
        unit: p.Product_Unit || "",
        category: p.Product_Category || "",
        reorderLevel: p.Product_Reorder_Level != null ? Number(p.Product_Reorder_Level) : null,
        isDiscontinued: !!p.Is_Discontinued,
        hasHistory: usedProductIds.has(p.Product_id),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading inventory: " + err.message);
  }
});

// GET /resources/services — services sold to or bought for the business
router.get("/resources/services", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Is_Service: 1, Is_Utility: 0, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });

    res.render("services", {
      title: "Services",
      active: "services",
      currentBusinessUnit: req.currentBusinessUnit,
      items: products.map((p) => ({
        name: p.Product_Name,
        price: Number(p.Product_Price || 0),
        cost: Number(p.Product_Cost || 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading services: " + err.message);
  }
});

// GET /resources/utility — utility catalogue and cost incurred
router.get("/resources/utility", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Is_Utility: 1, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });

    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);
    const utilityExpenses = await prisma.Expenditure.findMany({
      where: { Records_id: { in: unitRecordIds }, Expenditure_Category: "UTILITIES" },
      orderBy: { Expenditure_id: "desc" },
      take: 50,
    });
    const usageTotal = utilityExpenses.reduce((sum, e) => sum + Number(e.Net_Amount || 0), 0);

    res.render("utility", {
      title: "Utility",
      active: "utility",
      currentBusinessUnit: req.currentBusinessUnit,
      items: products.map((p) => ({
        name: p.Product_Name,
        billingCycle: p.Billing_Cycle,
        price: Number(p.Product_Price || 0),
      })),
      usage: utilityExpenses.map((e) => ({
        date: e.Period ? new Date(e.Period).toLocaleDateString("en-GB") : "",
        amount: Number(e.Net_Amount || 0),
      })),
      usageTotal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading utility: " + err.message);
  }
});

module.exports = router;
