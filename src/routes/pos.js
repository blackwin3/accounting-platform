/**
 * pos.js — Point of Sale / Exchange hub.
 * The till is the improved cashier point — this route handles the
 * stakeholder-facing transaction interface: sell, buy, settle debts,
 * and view transaction history with the counterparty.
 */

const express = require("express");
const router = express.Router();
const { prisma } = require("../services/postingEngine");
const { getCurrencyConfig, makeFmt } = require("../services/currency");

// GET /pos — full-screen POS interface
router.get("/pos", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const currency = await getCurrencyConfig(prisma, entrepriseId);
    const fmt = makeFmt(currency);

    // Load products for the till
    const products = await prisma.Product.findMany({
      where: { Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });

    // Load stakeholders for counterparty selection
    const stakeholders = await prisma.Stakeholder.findMany({
      where: { Entreprise_id: entrepriseId },
      orderBy: { Stakeholder_id: "desc" },
    });

    // Recent transactions for the activity feed
    const recentTransactions = await prisma.Transactions.findMany({
      where: { Entreprise_id: entrepriseId },
      orderBy: { Created_at: "desc" },
      take: 15,
    });

    // Outstanding receivables for quick settlement
    let receivables = [];
    try {
      receivables = await prisma.Money.findMany({
        where: { Instrument_type: "CUSTOMER_DEBT", Money_Status: "ACTIVE", Entreprise_id: entrepriseId },
        orderBy: { Money_id: "desc" },
        take: 10,
      });
    } catch { /* Money table may not have these fields */ }

    res.render("pos", {
      layout: false,
      title: "POS",
      currency, fmt,
      products: products.map(p => ({
        id: p.Product_id,
        name: p.Product_Name,
        price: Number(p.Product_Price || 0),
        type: p.Product_type,
        nature: p.Product_Nature,
        unit: p.Product_Unit,
        category: p.Product_Category,
      })),
      stakeholders: stakeholders.map(s => ({
        id: s.Stakeholder_id,
        name: s.Business_name || `${s.First_name || ""} ${s.Last_name || ""}`.trim(),
        category: s.Stakeholder_Category,
      })),
      recentTransactions: recentTransactions.map(t => ({
        id: t.Transactions_id,
        date: t.Created_at ? new Date(t.Created_at).toLocaleDateString("en-GB") : "—",
        amount: Number(t.Amount || 0),
        event: t.Business_Event || t.Operational_Event || "—",
        description: t.Description,
      })),
      receivables: receivables.map(r => ({
        id: r.Money_id,
        name: r.Money_Name,
        outstanding: Number(r.Outstanding_Amount || 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading POS: " + err.message);
  }
});

module.exports = router;
