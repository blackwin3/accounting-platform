const { getCurrencyConfig, makeFmt } = require("../../services/currency");
/**
 * interest-rates.js — Money > Interest Rates page.
 * All financial instruments carrying interest, growth, depreciation,
 * commission, or discount rates — loans, investments, assets, and
 * business percentage arrangements — in one view.
 */

const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

router.get("/money/interest-rates", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;

    // Loans — Money rows with type LOAN
    const loanRows = await prisma.Money.findMany({
      where: { Instrument_type: "LOAN", Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
    });
    const loans = loanRows.map((l) => ({
      name: l.Money_Name,
      principal: Number(l.Principal_amount || 0),
      outstanding: Number(l.Outstanding_Amount || 0),
      rate: l.Interest_rate != null ? Number(l.Interest_rate) : null,
      frequency: l.Repayment_Frequency,
      status: l.Money_Status,
    }));

    // Investments — bonds, money market, shares
    const investmentRows = await prisma.Money.findMany({
      where: { Instrument_type: { in: ["MONEY_MARKET", "BOND", "SHARES"] }, Entreprise_id: entrepriseId },
      orderBy: { Money_id: "desc" },
    });
    const investments = investmentRows.map((m) => ({
      name: m.Money_Name,
      principal: Number(m.Principal_amount || 0),
      rate: m.Interest_rate != null ? Number(m.Interest_rate) : null,
      maturity: m.Maturity_date ? new Date(m.Maturity_date).toLocaleDateString("en-GB") : null,
      status: m.Money_Status,
    }));

    // Assets with depreciation
    const assetRows = await prisma.Assets.findMany({
      where: { Entreprise_id: entrepriseId, Period_end: null },
      orderBy: { Assets_id: "asc" },
    });
    const assets = assetRows.filter((a) => a.Useful_Life_Years).map((a) => {
      const cost = Number(a.Cost_Amount || 0);
      const carrying = Number(a.Carrying_Amount || cost - Number(a.Accumulated_Depreciation || 0));
      const life = Number(a.Useful_Life_Years);
      const annualRate = life > 0 ? round2(100 / life) : null;
      return { name: a.Assets_Type, cost, carrying, method: a.Depreciation_Method || "STRAIGHT_LINE", usefulLife: life, annualRate };
    });

    // Business percentage arrangements — commission, profit-share, discount
    let arrangements = [];
    try {
      const mgmtRows = await prisma.Management.findMany({
        where: { Entreprise_id: entrepriseId, Arrangement_Type: { not: null } },
      });
      arrangements = mgmtRows.filter(m => m.Arrangement_Rate).map(m => ({
        name: m.Management_Name,
        type: m.Arrangement_Type,
        rate: Number(m.Arrangement_Rate),
      }));
    } catch { /* Arrangement_Type may not exist */ }

    const currency = await getCurrencyConfig(prisma, entrepriseId);
    const fmt = makeFmt(currency);

    // Products with rates
    const products = await prisma.Product.findMany({
      where: { Entreprise_id: entrepriseId },
    });
    const productRates = products
      .filter(p => p.Product_Price || p.Product_Rate || p.Product_Cost)
      .map(p => {
        const price = Number(p.Product_Price || 0);
        const cost = Number(p.Product_Cost || 0);
        const marginPct = price > 0 && cost > 0 ? round2(((price - cost) / cost) * 100) : null;
        return {
          name: p.Product_Name,
          nature: p.Product_Nature || p.Product_type || "—",
          price: price || null,
          cost: cost || null,
          marginPct,
          rate: p.Product_Rate ? Number(p.Product_Rate) : null,
        };
      })
      .filter(p => p.marginPct != null || p.rate != null);

    res.render("interest-rates", {
      title: "Interest Rates",
      active: "interest-rates",
      currentBusinessUnit: req.currentBusinessUnit,
      loans,
      investments,
      assets,
      arrangements,
      productRates,
      fmt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading interest rates: " + err.message);
  }
});

module.exports = router;
