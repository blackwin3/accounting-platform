const { prisma } = require("./postingEngine");

const LOW_STOCK_DEFAULT_THRESHOLD = 10;
const LARGE_ASSET_THRESHOLD = 50000; // KES — flags any single fixed-asset purchase above this

/**
 * getAlerts — computes the current set of owner-facing alerts:
 *   - LOW_STOCK: any product at or below its reorder level (or a default threshold)
 *   - NO_OPEN_PERIOD: no Structures row with Period_Status=OPEN exists
 *   - OUT_OF_BALANCE: total Journal debits != total Journal credits
 *   - LARGE_ASSET_PURCHASE: any Assets row above the large-spend threshold
 *     acquired in the last 24 hours (recent enough to still need owner review)
 */
async function getAlerts(entrepriseId) {
  const alerts = [];
  if (!entrepriseId) return alerts;

  // --- Low stock ---
  const products = await prisma.Product.findMany({ where: { Entreprise_id: entrepriseId } });
  const productIds = products.map((p) => p.Product_id);
  const resources = await prisma.Resources.findMany({ where: { Product_id: { in: productIds } } });
  const stockByProduct = Object.fromEntries(resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)]));

  for (const p of products) {
    if (p.Is_Asset) continue; // fixed assets aren't stock
    const stock = stockByProduct[p.Product_id];
    if (stock === undefined) continue;
    const threshold = p.Product_Reorder_Level != null ? Number(p.Product_Reorder_Level) : LOW_STOCK_DEFAULT_THRESHOLD;
    if (stock <= threshold) {
      alerts.push({
        type: "LOW_STOCK",
        severity: stock === 0 ? "high" : "medium",
        message: stock === 0
          ? `${p.Product_Name} is out of stock.`
          : `${p.Product_Name} is low: ${stock} left (reorder at ${threshold}).`,
        link: "/products",
      });
    }
  }

  // --- Open period ---
  const openPeriod = await prisma.Structures.findFirst({
    where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
  });
  if (!openPeriod) {
    alerts.push({
      type: "NO_OPEN_PERIOD",
      severity: "high",
      message: "No accounting period is currently OPEN. Sales and purchases cannot be posted until one is opened.",
      link: "/settings",
    });
  }

  // --- Journal balance ---
  const journalAgg = await prisma.Journal.aggregate({ _sum: { Debit: true, Credit: true }, where: { Entreprise_id: entrepriseId } });
  const totalDebit = Number(journalAgg._sum.Debit || 0);
  const totalCredit = Number(journalAgg._sum.Credit || 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    alerts.push({
      type: "OUT_OF_BALANCE",
      severity: "high",
      message: `The journal is out of balance by KES ${Math.abs(totalDebit - totalCredit).toFixed(2)}. Debits: ${totalDebit.toFixed(2)}, Credits: ${totalCredit.toFixed(2)}.`,
      link: "/transactions",
    });
  }

  // --- Large asset purchases (recent) ---
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentAssets = await prisma.Assets.findMany({
    where: { Cost_Amount: { gte: LARGE_ASSET_THRESHOLD }, Entreprise_id: entrepriseId },
  });
  for (const a of recentAssets) {
    if (a.Acquisition_Date && new Date(a.Acquisition_Date) >= since) {
      alerts.push({
        type: "LARGE_ASSET_PURCHASE",
        severity: "medium",
        message: `${a.Assets_Type || "An asset"} was purchased for KES ${Number(a.Cost_Amount).toFixed(2)} — above the KES ${LARGE_ASSET_THRESHOLD.toLocaleString()} review threshold.`,
        link: "/reports",
      });
    }
  }

  return alerts;
}

module.exports = { getAlerts, LOW_STOCK_DEFAULT_THRESHOLD, LARGE_ASSET_THRESHOLD };
