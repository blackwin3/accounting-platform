const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

// GET /assets — the asset purchase wizard + register
router.get("/assets", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const unitRecords = await prisma.Records.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      select: { Records_id: true },
    });
    const unitRecordIds = unitRecords.map((r) => r.Records_id);

    const assetRows = await prisma.Assets.findMany({
      where: { Records_id: { in: unitRecordIds }, Entreprise_id: entrepriseId },
      orderBy: { Assets_id: "desc" },
    });

    const mappedAssets = assetRows.map((a) => ({
      id: a.Assets_id,
      name: a.Assets_Type,
      method: a.Depreciation_Method,
      ownershipType: a.Ownership_Type || "BUSINESS",
      cost: Number(a.Cost_Amount || 0),
      accumulatedDepreciation: Number(a.Accumulated_Depreciation || 0),
      accumulatedImpairment: Number(a.Accumulated_Impairment || 0),
      carryingAmount: Number(a.Carrying_Amount || 0),
      acquisitionDate: a.Acquisition_Date ? new Date(a.Acquisition_Date).toLocaleDateString("en-GB") : "—",
      disposed: !!a.Period_end,
    }));

    res.render("assets", {
      title: "Assets",
      active: "assets",
      currentBusinessUnit: req.currentBusinessUnit,
      assets: mappedAssets,
      activeAssets: mappedAssets.filter((a) => !a.disposed),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading assets: " + err.message);
  }
});

module.exports = router;
