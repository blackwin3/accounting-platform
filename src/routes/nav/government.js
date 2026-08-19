const { getCurrencyConfig, makeFmt } = require("../../services/currency");
/**
 * government.js — Organisation > Government page.
 * Taxes, levies, grants, and government service payments
 * like land rates that owners commonly forget to provision for.
 */

const express = require("express");
const router = express.Router();
const { prisma, round2 } = require("../../services/postingEngine");

router.get("/organisation/government", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;

    // Tax-related transactions
    const catalogues = await prisma.Catalogue.findMany({ where: { Entreprise_id: entrepriseId } });
    const taxEventNames = ["PAY_EXPENSE_TAX"];
    const taxCatalogueIds = catalogues.filter((c) => taxEventNames.includes(c.Event_Name)).map((c) => c.Catalogue_id);

    const taxJournals = await prisma.Journal.findMany({
      where: { Catalogue_id: { in: taxCatalogueIds.length > 0 ? taxCatalogueIds : [0] }, Entreprise_id: entrepriseId },
      orderBy: { Created_at: "desc" },
      take: 50,
    });
    const taxPaid = round2(taxJournals.reduce((sum, j) => sum + Number(j.Debit || 0), 0));

    // Government grants
    const grantIncomeRows = await prisma.Income.findMany({
      where: { Income_Category: "DONATION", Entreprise_id: entrepriseId },
    });
    const grantsReceived = round2(grantIncomeRows.reduce((sum, i) => sum + Number(i.Net_Amount || 0), 0));

    // Government stakeholders
    const govStakeholders = await prisma.Stakeholder.findMany({
      where: { Stakeholder_Category: "Government", Entreprise_id: entrepriseId },
    });

    // Provisions for government charges
    const govProvisions = await prisma.Liability.findMany({
      where: { Liability_Type: { in: ["Government Provision", "Warranty Provision"] }, Net_Amount: { gt: 0 }, Entreprise_id: entrepriseId },
    });
    const provisionedForGov = round2(govProvisions.reduce((sum, p) => sum + Number(p.Net_Amount || 0), 0));

    // Settings for VAT
    const vatRateSetting = await prisma.Settings.findFirst({ where: { Setting_Name: "VAT_RATE", Entreprise_id: entrepriseId } });
    const vatRegSetting = await prisma.Settings.findFirst({ where: { Setting_Name: "VAT_REGISTERED", Entreprise_id: entrepriseId } });

    // Government expenses display
    const govExpenses = taxJournals.map((j) => ({
      description: j.Description || "Tax payment",
      category: "TAX",
      amount: Number(j.Debit || 0),
      date: j.Created_at ? new Date(j.Created_at).toLocaleDateString("en-GB") : "—",
    }));

    const currency = await getCurrencyConfig(prisma, entrepriseId);
    const fmt = makeFmt(currency);

    res.render("government", {
      title: "Government",
      active: "government",
      currentBusinessUnit: req.currentBusinessUnit,
      currency: currency.code,
      vatRate: vatRateSetting ? Number(vatRateSetting.Setting_Value) : 16,
      vatRegistered: vatRegSetting ? vatRegSetting.Setting_Value === "1" : false,
      taxPaid,
      grantsReceived,
      provisionedForGov,
      unprovisionedCharges: 0,
      govExpenses,
      govStakeholders: govStakeholders.map((s) => ({
        name: s.Business_name || `${s.First_name || ""} ${s.Last_name || ""}`.trim(),
        role: s.Stakeholder_Role || s.Stakeholder_Category,
        phone: s.Tel_1,
        email: s.Email_1,
      })),
      fmt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading government page: " + err.message);
  }
});

module.exports = router;
