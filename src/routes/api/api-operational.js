/**
 * api-operational.js — the Operational Layer: Resources, Transactions,
 * Payment, Money. The day-to-day movement of stock and cash — the Till,
 * Products/Inventory management, Repackaging, and the operational side
 * of Livestock, Services, and Lessor (registering, logging, hiring —
 * the record-keeping actions, not the accounting postings those actions
 * eventually trigger). Extracted from the original single api.js as
 * part of a 5-layer split matching this system's own architectural
 * documentation.
 */

const express = require("express");
const router = express.Router();
const { postBasket, postRepackaging, registerAnimal, bulkPlanting, recordMonthlyReview, recordAnimalLoss, recordBirth, recordHarvest, postSeasonalLabour, startServiceEngagement, logServiceHours, billServiceEngagement, leaseOutInventory, returnLeasedInventory, hireOutEquipment, endEquipmentHire, PostingError, prisma, computeAccountBalance } = require("../../services/postingEngine");

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * hasTransactionHistory — true if this product has ever been posted
 * against. Once true, editing its price/cost/name or deleting it outright
 * would silently misrepresent the accounting already recorded — a past
 * Journal narrative and COGS figure are computed from the product's
 * values at the moment they were posted, not read live from Product each
 * time. The only safe action past this point is discontinuing it.
 */
async function hasTransactionHistory(productId, entrepriseId) {
  const count = await prisma.Transactions.count({ where: { Product_id: productId, Entreprise_id: entrepriseId } });
  return count > 0;
}


router.get("/products", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const products = await prisma.Product.findMany({
      where: { Business_Unit: req.currentBusinessUnit, Entreprise_id: entrepriseId },
      orderBy: { Product_Name: "asc" },
    });
    const productIds = products.map((p) => p.Product_id);
    const resources = await prisma.Resources.findMany({
      where: { Product_id: { in: productIds } },
    });
    const stockByProduct = Object.fromEntries(
      resources.map((r) => [r.Product_id, Number(r.Resources_Quantity || 0)])
    );

    const mapped = products.map((p) => ({
      id: p.Product_id,
      name: p.Product_Name,
      price: Number(p.Product_Price || 0),
      cost: Number(p.Product_Cost || 0),
      stock: stockByProduct[p.Product_id] ?? 0,
      isUtility: !!p.Is_Utility,
      isService: !!p.Is_Service,
      isInvestment: p.Product_type === "Investment",
      billingCycle: p.Billing_Cycle,
    }));

    // Inventory (goods) first — the highest-frequency, everyday till action.
    // Services next — sold to or bought for the business, less frequent than a goods sale.
    // Utilities and Investments last — bought (paid for/acquired) far more
    // often than sold at the Till; selling an investment is a deliberate,
    // infrequent action better handled on the Money > Investments or
    // Assets page, not mixed into everyday till activity.
    const inventory = mapped.filter((p) => !p.isService && !p.isUtility && !p.isInvestment);
    const services = mapped.filter((p) => p.isService && !p.isUtility && !p.isInvestment);
    const utilities = mapped.filter((p) => p.isUtility && !p.isInvestment);
    const investments = mapped.filter((p) => p.isInvestment);

    res.json({ inventory, services, utilities, investments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/cash — the till/cash Account_id to post against
router.get("/accounts/cash", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const codeRow = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
    if (!codeRow) return res.status(404).json({ error: "Cash account code (1000) not seeded yet" });
    const account = await prisma.Account.findFirst({ where: { Account_Code_id: codeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!account) return res.status(404).json({ error: "Cash account not seeded yet" });
    res.json({ id: account.Account_id, name: account.Account_Name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/basket  { mode: "sell"|"buy", lines: [{productId, quantity, unitPrice}], discount }
router.post("/basket", async (req, res) => {
  try {
    const { mode, lines, paymentMethod, discount, stakeholderId, paymentReference, notes } = req.body;

    const result = await postBasket({
      mode,
      lines,
      paymentMethod,
      discount: discount ? Number(discount) : 0,
      stakeholderId: stakeholderId || null,
      paymentReference: paymentReference || "",
      notes: notes || "",
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });

    res.json({
      ok: true,
      recordsId: result.recordsId,
      cycleReference: result.cycleReference,
      total: result.total,
      netTotal: result.netTotal,
      discount: result.discount,
      lineCount: result.transactions.length,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error posting basket" });
  }
});

// GET /api/till-denomination — today's physical cash-drawer count for the
// current business unit, plus the expected Cash balance to compare against.
router.get("/till-denomination", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const businessUnit = req.currentBusinessUnit;
    const todayStr = new Date().toISOString().slice(0, 10);

    const existing = await prisma.Till_Denomination_Count.findFirst({
      where: { Entreprise_id: entrepriseId, Business_Unit: businessUnit, Count_Date: new Date(todayStr) },
    });

    const counts = {};
    for (const d of DENOMINATIONS) {
      counts[d] = existing ? existing[`Count_${d}`] || 0 : 0;
    }

    // Expected cash: the Cash account's actual balance, computed live from
    // Journal — Current_Balance is never kept in sync by any posting
    // function in this engine, so reading it directly always showed 0.
    const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
    const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;
    const expectedCash = cashAccount ? await computeAccountBalance(prisma, cashAccount.Account_id, "DEBIT") : 0;

    const countedTotal = DENOMINATIONS.reduce((sum, d) => sum + d * counts[d], 0);

    res.json({
      counts,
      denominations: DENOMINATIONS,
      countedTotal,
      expectedCash,
      variance: round2(countedTotal - expectedCash),
      updatedAt: existing ? existing.Updated_At : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error loading till count" });
  }
});

// POST /api/till-denomination { counts: { "1000": 3, "500": 10, ... } }
router.post("/till-denomination", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const businessUnit = req.currentBusinessUnit;
    const todayStr = new Date().toISOString().slice(0, 10);
    const { counts } = req.body;
    if (!counts || typeof counts !== "object") return res.status(400).json({ error: "counts object is required" });

    const data = { Updated_By: req.currentUser.Administration_id, Updated_At: new Date() };
    for (const d of DENOMINATIONS) {
      const n = Number(counts[d] || 0);
      if (n < 0 || !Number.isInteger(n)) return res.status(400).json({ error: `Count for ${d} must be a non-negative whole number` });
      data[`Count_${d}`] = n;
    }

    const existing = await prisma.Till_Denomination_Count.findFirst({
      where: { Entreprise_id: entrepriseId, Business_Unit: businessUnit, Count_Date: new Date(todayStr) },
    });

    const saved = existing
      ? await prisma.Till_Denomination_Count.update({ where: { Till_Denomination_Count_id: existing.Till_Denomination_Count_id }, data })
      : await prisma.Till_Denomination_Count.create({
          data: { ...data, Entreprise_id: entrepriseId, Business_Unit: businessUnit, Count_Date: new Date(todayStr) },
        });

    const countedTotal = DENOMINATIONS.reduce((sum, d) => sum + d * data[`Count_${d}`], 0);

    const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
    const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;
    const expectedCash = cashAccount ? await computeAccountBalance(prisma, cashAccount.Account_id, "DEBIT") : 0;

    res.json({ ok: true, countedTotal, expectedCash, variance: round2(countedTotal - expectedCash) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error saving till count" });
  }
});

// POST /api/products — add a new product to the catalog directly (not via a purchase)
router.post("/products", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { name, type, isUtility, billingCycle, category, price, cost, unit, startingStock, reorderLevel, interestRate, maturityDate } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Product name is required" });
    if (price == null || price < 0) return res.status(400).json({ error: "Price must be zero or positive" });
    if (cost == null || cost < 0) return res.status(400).json({ error: "Cost must be zero or positive" });

    // Scoped to this business only — a product named "Milk" in one
    // business must never block, or be confused with, a product named
    // "Milk" in a different business. This check was previously global,
    // and worse, the row created below never set Entreprise_id at all —
    // every product ever created through this endpoint belonged to no
    // business, which is the actual cause of products appearing to leak
    // between businesses.
    const existing = await prisma.Product.findFirst({ where: { Product_Name: name.trim(), Entreprise_id: entrepriseId } });
    if (existing) {
      // If the conflicting product is an Asset whose Assets row has
      // already been disposed (Period_end set — see postAssetDisposal),
      // its name genuinely isn't "in use" anymore: the asset has left
      // the register, and there's no live entity left for a new
      // purchase of the same name to be confused with. Real Goods,
      // Services, and Utilities are unaffected by this — they have no
      // Assets row at all, so this branch never applies to them.
      let nameGenuinelyFree = false;
      if (existing.Is_Asset) {
        // Find the Assets row(s) for this specific product by walking its
        // own Transactions -> Records -> Assets chain, rather than any
        // Assets row for the business in general.
        const productTxns = await prisma.Transactions.findMany({ where: { Product_id: existing.Product_id, Entreprise_id: entrepriseId }, select: { Records_id: true } });
        const recordsIds = productTxns.map((t) => t.Records_id).filter(Boolean);
        const assetRows = recordsIds.length ? await prisma.Assets.findMany({ where: { Records_id: { in: recordsIds } } }) : [];
        nameGenuinelyFree = assetRows.length > 0 && assetRows.every((a) => a.Period_end != null);
      }
      if (!nameGenuinelyFree) {
        return res.status(400).json({ error: `A product named "${name.trim()}" already exists.` });
      }
    }

    // Derive Product_Nature from the existing type/flags — the single
    // authoritative classification that replaces the ambiguous boolean
    // combination of Is_Asset/Is_Service/Is_Utility.
    let productNature = "GOOD";
    if (type === "Services") productNature = "SERVICE";
    else if (type === "Investment") productNature = "FINANCIAL_INSTRUMENT";
    else if (type === "Asset") productNature = "FIXED_ASSET";
    else if (isUtility) productNature = "UTILITY";
    else if (type === "Goods") productNature = "GOOD";

    const product = await prisma.Product.create({
      data: {
        Product_Name: name.trim(),
        Product_type: type || "Goods",
        Product_Nature: productNature,
        Product_Category: category || null,
        Product_Price: price,
        Product_Rate: type === "Investment" && interestRate != null ? interestRate : null,
        Product_Cost: cost,
        Product_Unit: unit || "unit",
        Product_Reorder_Level: type === "Goods" && reorderLevel != null ? reorderLevel : null,
        Is_Service: type === "Services" ? 1 : 0,
        Is_Utility: isUtility ? 1 : 0,
        Billing_Cycle: isUtility ? billingCycle : null,
        Business_Unit: req.currentBusinessUnit,
        Entreprise_id: entrepriseId,
      },
    });

    if (type === "Goods") {
      await prisma.Resources.create({
        data: {
          Product_id: product.Product_id,
          Resource_type: "INVENTORY",
          Resource_Class: "INVENTORY",
          Resources_Quantity: startingStock || 0,
          Resources_Status: "AVAILABLE",
          Resources_Source: "DONATION", // opening stock not tied to a purchase transaction
          Last_updated: new Date(),
        },
      });
    }

    if (type === "Investment") {
      // Anchor the Money instrument to this business's own Cash account —
      // the previous version looked up Account_codes/Account with no
      // Entreprise_id filter at all, so it could anchor to any business's
      // Cash account depending on database row order.
      const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
      const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;

      if (cashAccount) {
        await prisma.Money.create({
          data: {
            Account_id: cashAccount.Account_id,
            Product_id: product.Product_id,
            Instrument_type: "MONEY_MARKET",
            Instrument_Class: interestRate ? "AMORTIZED_COST" : "FAIR_VALUE_OCI",
            Money_Status: "ACTIVE",
            Risk_Level: "LOW",
            Money_Name: name.trim(),
            Principal_amount: cost,
            Interest_rate: interestRate || null,
            Outstanding_Amount: cost,
            Start_date: new Date(),
            Maturity_date: maturityDate ? new Date(maturityDate) : null,
            Entreprise_id: entrepriseId,
          },
        });
      }
    }

    res.json({ ok: true, productId: product.Product_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding product" });
  }
});

// PUT /api/products/:id — edit a product's own details. Refused once the
// product has any transaction history (see hasTransactionHistory above).
router.put("/products/:id", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const productId = Number(req.params.id);
    const product = await prisma.Product.findUnique({ where: { Product_id: productId } });
    if (!product || product.Entreprise_id !== entrepriseId) return res.status(404).json({ error: "Product not found" });

    const used = await hasTransactionHistory(productId, entrepriseId);
    const { name, price, cost, unit, category, reorderLevel } = req.body;

    // Price and cost are the only genuinely unsafe fields to change after
    // use — every past sale/purchase already baked its own price and cost
    // into Journal.Description and the Income/Expenditure rows as frozen
    // figures, so editing Product.Product_Price/Cost now wouldn't corrupt
    // history, but it WOULD make "current price" silently diverge from
    // what was actually charged historically without any visible flag,
    // which is exactly the kind of confusion this system tries hard to
    // avoid elsewhere (see e.g. the honest isPopulated flags on the Rules
    // page). Name, unit, category, and reorder level are genuinely safe
    // to correct at any time — a product name is interpolated into
    // Journal.Description as a plain string at the moment of posting, so
    // renaming "Milk" to "Whole Milk" today changes nothing about any
    // past record; it only fixes how the product reads going forward.
    if (used && (price != null || cost != null)) {
      return res.status(400).json({
        error: "Price and cost can no longer be changed once this product has been used in a transaction — historical sales/purchases used the price and cost at the time, and changing it now would make that comparison silently wrong. You can still correct the name, unit, category, or reorder level. Discontinue this product and create a new one if the price genuinely needs to change.",
      });
    }

    if (name != null && !name.trim()) return res.status(400).json({ error: "Product name cannot be empty" });
    if (price != null && price < 0) return res.status(400).json({ error: "Price must be zero or positive" });
    if (cost != null && cost < 0) return res.status(400).json({ error: "Cost must be zero or positive" });

    const updated = await prisma.Product.update({
      where: { Product_id: productId },
      data: {
        ...(name != null ? { Product_Name: name.trim() } : {}),
        ...(!used && price != null ? { Product_Price: price } : {}),
        ...(!used && cost != null ? { Product_Cost: cost } : {}),
        ...(unit != null ? { Product_Unit: unit } : {}),
        ...(category != null ? { Product_Category: category } : {}),
        ...(reorderLevel != null ? { Product_Reorder_Level: reorderLevel } : {}),
      },
    });
    res.json({ ok: true, productId: updated.Product_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error updating product" });
  }
});

// POST /api/products/:id/discontinue — hide from the Till and new
// purchases. Always allowed, regardless of transaction history — this
// never touches Journal-adjacent data, only whether the product is
// offered going forward.
router.post("/products/:id/discontinue", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const productId = Number(req.params.id);
    const product = await prisma.Product.findUnique({ where: { Product_id: productId } });
    if (!product || product.Entreprise_id !== entrepriseId) return res.status(404).json({ error: "Product not found" });

    await prisma.Product.update({ where: { Product_id: productId }, data: { Is_Discontinued: 1 } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error discontinuing product" });
  }
});

// POST /api/products/:id/reactivate — undo a discontinue, e.g. a seasonal
// item coming back into stock. Also always allowed.
router.post("/products/:id/reactivate", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const productId = Number(req.params.id);
    const product = await prisma.Product.findUnique({ where: { Product_id: productId } });
    if (!product || product.Entreprise_id !== entrepriseId) return res.status(404).json({ error: "Product not found" });

    await prisma.Product.update({ where: { Product_id: productId }, data: { Is_Discontinued: 0 } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error reactivating product" });
  }
});

// DELETE /api/products/:id — genuinely remove a product row. Refused once
// the product has any transaction history, same rule as editing — a
// deleted-but-referenced Product would leave Transactions/Journal rows
// pointing at nothing.
router.delete("/products/:id", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const productId = Number(req.params.id);
    const product = await prisma.Product.findUnique({ where: { Product_id: productId } });
    if (!product || product.Entreprise_id !== entrepriseId) return res.status(404).json({ error: "Product not found" });

    if (await hasTransactionHistory(productId, entrepriseId)) {
      return res.status(400).json({
        error: "This product has already been used in a transaction and cannot be deleted — doing so would leave historical records pointing at nothing. Discontinue it instead.",
      });
    }

    // Resources row (stock count) is safe to remove too, since a never-used
    // product's stock is either the original entry or zero — no history to lose.
    const resource = await prisma.Resources.findFirst({ where: { Product_id: productId } });
    if (resource) await prisma.Resources.delete({ where: { Resources_id: resource.Resources_id } });
    await prisma.Product.delete({ where: { Product_id: productId } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error deleting product" });
  }
});

module.exports = router;
