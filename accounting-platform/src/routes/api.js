const express = require("express");
const router = express.Router();
const { postBasket, postAssetPurchase, postAssetDisposal, postDepreciationRun, postAssetImpairment, postAssetRevaluation, postLeaseCommencement, postLeasePayment, postProvision, postProvisionUtilisation, postExpense, postFunding, postUnitIncome, postFundTransfer, postReceivableSettlement, postPayableSettlement, postInvestmentPurchase, postInvestmentSale, postInsurancePolicy, closeInsurancePolicy, postRepackaging, postCorrection, PostingError, prisma, computeAccountBalance } = require("../services/postingEngine");

// GET /api/products — list sellable products with current stock, filtered to the active Business Unit,
// grouped as Inventory (goods) / Services / Utilities — in that order, matching how often each is used at the till
// GET /api/stakeholders/lookup — a lightweight list for the Till's
// customer/supplier picker, distinct from the full /organisation/stakeholders
// page. Only Customer/Supplier/Creditor/Debtor categories are relevant at
// the point of sale — family/employee/advisor stakeholders aren't offered here.
router.get("/stakeholders/lookup", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Stakeholder.findMany({
      where: {
        Entreprise_id: entrepriseId,
        Stakeholder_Category: { in: ["Customer", "Supplier"] },
      },
      orderBy: { First_name: "asc" },
    });
    res.json(
      rows.map((s) => ({
        id: s.Stakeholder_id,
        name: [s.First_name, s.Last_name].filter(Boolean).join(" ") || s.Business_name || `#${s.Stakeholder_id}`,
        category: s.Stakeholder_Category,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

const DENOMINATIONS = [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1];

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

function round2(n) {
  return Math.round(n * 100) / 100;
}

// POST /api/asset-purchase { name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, ownershipType }
router.post("/asset-purchase", async (req, res) => {
  try {
    const { name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, ownershipType } = req.body;
    const result = await postAssetPurchase({ name, cost, usefulLifeYears, residualValue, depreciationMethod, paymentMethod, ownershipType, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    const monthlyDepreciation = (cost - (residualValue || 0)) / usefulLifeYears / 12;
    res.json({
      ok: true,
      assetId: result.asset.Assets_id,
      transactionId: result.transaction.Transactions_id,
      monthlyDepreciation,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error recording asset purchase" });
  }
});

// POST /api/asset-disposal { assetId, proceeds, paymentMethod }
router.post("/asset-disposal", async (req, res) => {
  try {
    const { assetId, proceeds, paymentMethod } = req.body;
    const result = await postAssetDisposal({ assetId, proceeds, paymentMethod, entrepriseId: req.currentUser.Entreprise_id });
    res.json({
      ok: true,
      transactionId: result.transaction.Transactions_id,
      gainLoss: result.gainLoss,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error recording asset disposal" });
  }
});

// POST /api/depreciation-run { assetId, amount? } — amount is optional, defaults to one month straight-line
router.post("/depreciation-run", async (req, res) => {
  try {
    const { assetId, amount } = req.body;
    const result = await postDepreciationRun({ assetId, amount: amount ? Number(amount) : undefined, entrepriseId: req.currentUser.Entreprise_id });
    res.json({
      ok: true,
      transactionId: result.transaction.Transactions_id,
      amount: result.amount,
      newAccumulated: result.newAccumulated,
      newCarrying: result.newCarrying,
    });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error posting depreciation" });
  }
});

// POST /api/asset-impairment { assetId, writeDownAmount, reason }
router.post("/asset-impairment", async (req, res) => {
  try {
    const { assetId, writeDownAmount, reason } = req.body;
    const result = await postAssetImpairment({ assetId, writeDownAmount: Number(writeDownAmount), reason, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newCarrying: result.newCarrying });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error recording impairment" });
  }
});

// POST /api/asset-revaluation { assetId, newValue, reason }
router.post("/asset-revaluation", async (req, res) => {
  try {
    const { assetId, newValue, reason } = req.body;
    const result = await postAssetRevaluation({ assetId, newValue: Number(newValue), reason, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newCarrying: result.newCarrying, change: result.change });
  } catch (err) {
    if (err instanceof PostingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error revaluing asset" });
  }
});

// POST /api/lease-commencement { description, totalLeasePayments, leaseTermYears }
router.post("/lease-commencement", async (req, res) => {
  try {
    const { description, totalLeasePayments, leaseTermYears } = req.body;
    const result = await postLeaseCommencement({
      description,
      totalLeasePayments,
      leaseTermYears,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, liabilityId: result.liability.Liability_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error commencing lease" });
  }
});

// POST /api/lease-payment { liabilityId, amount, paymentMethod }
router.post("/lease-payment", async (req, res) => {
  try {
    const { liabilityId, amount, paymentMethod } = req.body;
    const result = await postLeasePayment({ liabilityId, amount, paymentMethod, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newOutstanding: result.newOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording lease payment" });
  }
});

// POST /api/provision { amount, description }
router.post("/provision", async (req, res) => {
  try {
    const { amount, description } = req.body;
    const result = await postProvision({ amount, description, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, liabilityId: result.liability.Liability_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording provision" });
  }
});

// POST /api/provision-utilisation { liabilityId, amount, paymentMethod }
router.post("/provision-utilisation", async (req, res) => {
  try {
    const { liabilityId, amount, paymentMethod } = req.body;
    const result = await postProvisionUtilisation({ liabilityId, amount, paymentMethod, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, newOutstanding: result.newOutstanding });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error honouring claim" });
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

    const product = await prisma.Product.create({
      data: {
        Product_Name: name.trim(),
        Product_type: type || "Goods",
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

// POST /api/expense { category, amount, paymentMethod, notes }
router.post("/expense", async (req, res) => {
  try {
    const { category, amount, paymentMethod, notes } = req.body;
    const result = await postExpense({ category, amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording expense" });
  }
});

// POST /api/settle-receivable { amount, paymentMethod, notes } — a customer pays down an outstanding credit sale
router.post("/settle-receivable", async (req, res) => {
  try {
    const { amount, paymentMethod, notes } = req.body;
    const result = await postReceivableSettlement({ amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingReceivable: result.remainingReceivable });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error settling receivable" });
  }
});

// POST /api/settle-payable { amount, paymentMethod, notes } — the business pays down an outstanding credit purchase/expense
router.post("/settle-payable", async (req, res) => {
  try {
    const { amount, paymentMethod, notes } = req.body;
    const result = await postPayableSettlement({ amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, remainingPayable: result.remainingPayable });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error settling payable" });
  }
});

// POST /api/funding { source: "CAPITAL"|"LOAN", amount, paymentMethod, notes }
router.post("/funding", async (req, res) => {
  try {
    const { source, amount, paymentMethod, notes } = req.body;
    const result = await postFunding({ source, amount, paymentMethod, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording funds" });
  }
});

// POST /api/fund-transfer { from, to, amount, notes } — move money between
// the business's own Cash/Mobile/Bank accounts, e.g. topping up a low
// account to cover an upcoming purchase or bill.
router.post("/fund-transfer", async (req, res) => {
  try {
    const { from, to, amount, notes } = req.body;
    const result = await postFundTransfer({ from, to, amount, notes, businessUnit: req.currentBusinessUnit, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error transferring funds" });
  }
});

// POST /api/investment-purchase { name, amount, paymentMethod, interestRate, maturityDate, productId }
router.post("/investment-purchase", async (req, res) => {
  try {
    const { name, amount, paymentMethod, interestRate, maturityDate, productId } = req.body;
    const result = await postInvestmentPurchase({
      name,
      amount,
      paymentMethod,
      interestRate: interestRate ? Number(interestRate) : null,
      maturityDate,
      productId: productId ? Number(productId) : null,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, moneyId: result.money.Money_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error purchasing investment" });
  }
});

// POST /api/investment-sale { moneyId, proceeds, paymentMethod }
router.post("/investment-sale", async (req, res) => {
  try {
    const { moneyId, proceeds, paymentMethod } = req.body;
    const result = await postInvestmentSale({
      moneyId,
      proceeds,
      paymentMethod,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id, gainLoss: result.gainLoss });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error selling investment" });
  }
});

// POST /api/insurance-policy { name, coverageAmount, premiumAmount, startDate, maturityDate, riskLevel, riskNote }
router.post("/insurance-policy", async (req, res) => {
  try {
    const { name, coverageAmount, premiumAmount, startDate, maturityDate, riskLevel, riskNote } = req.body;
    const result = await postInsurancePolicy({
      name,
      coverageAmount: Number(coverageAmount),
      premiumAmount: premiumAmount ? Number(premiumAmount) : null,
      startDate,
      maturityDate,
      riskLevel,
      riskNote,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, moneyId: result.policy.Money_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording insurance policy" });
  }
});

// POST /api/insurance-policy/:id/close — mark a policy as lapsed/cancelled
router.post("/insurance-policy/:id/close", async (req, res) => {
  try {
    await closeInsurancePolicy({ moneyId: req.params.id, entrepriseId: req.currentUser.Entreprise_id });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error closing policy" });
  }
});

// POST /api/repackaging { inputs: [{productId, quantity}], outputProductId, outputQuantity, spoilageQuantity, notes }
router.post("/repackaging", async (req, res) => {
  try {
    const { inputs, outputProductId, outputQuantity, spoilageQuantity, notes } = req.body;
    const result = await postRepackaging({
      inputs: (inputs || []).map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity) })),
      outputProductId: Number(outputProductId),
      outputQuantity: Number(outputQuantity),
      spoilageQuantity: spoilageQuantity ? Number(spoilageQuantity) : 0,
      notes,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({
      ok: true,
      transactionId: result.transaction.Transactions_id,
      outputUnitCost: result.outputUnitCost,
      totalInputValue: result.totalInputValue,
      spoilageValue: result.spoilageValue,
      outputValue: result.outputValue,
    });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error processing repackaging" });
  }
});

// POST /api/corrections { originalJournalId, reason } — reverses a
// specific Journal entry pair, matching the schema's documented rule:
// original never touched, a new entry reverses it. Restricted to
// Owner/Accountant — undoing a posted entry is a genuinely high-trust
// action, deliberately not available to Cashier or Manager.
router.post("/corrections", async (req, res) => {
  try {
    const accessLevel = req.currentUser.Access_Level;
    if (accessLevel !== "OWNER_FULL" && accessLevel !== "ACCOUNTANT") {
      return res.status(403).json({ error: "Only the Owner or Accountant can correct a posted entry." });
    }
    const { originalJournalId, reason } = req.body;
    const result = await postCorrection({
      originalJournalId: Number(originalJournalId),
      reason,
      administrationId: req.currentUser.Administration_id,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, reversedCount: result.reversedCount });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error posting correction" });
  }
});

// POST /api/unit-income { incomeType, amount, paymentMethod, notes, stakeholderId, moneyId }
router.post("/unit-income", async (req, res) => {
  try {
    const { incomeType, amount, paymentMethod, notes, stakeholderId, moneyId } = req.body;
    const result = await postUnitIncome({
      incomeType,
      amount,
      paymentMethod,
      notes,
      stakeholderId,
      moneyId,
      businessUnit: req.currentBusinessUnit,
      entrepriseId: req.currentUser.Entreprise_id,
    });
    res.json({ ok: true, transactionId: result.transaction.Transactions_id });
  } catch (err) {
    if (err instanceof PostingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error recording income" });
  }
});

// POST /api/organisation — create or update the single Organisation record
router.post("/organisation", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { name, industry, type, address, country, currency, businessUnits } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Organisation name is required" });

    const existing = await prisma.Organisation.findUnique({ where: { Entreprise_id: entrepriseId } });

    // Organisation.Account_id and Catalogue_id are NOT NULL in the schema;
    // anchor to this business's own cash account and SELL_GOODS_CASH
    // catalogue event, not whichever business's happened to be created
    // first — the previous version had no Entreprise_id filter on either
    // lookup, which could anchor a brand-new business to another
    // business's accounts entirely.
    const cashCode = await prisma.Account_codes.findFirst({ where: { Code: "1000", Entreprise_id: entrepriseId } });
    const cashAccount = cashCode ? await prisma.Account.findFirst({ where: { Account_Code_id: cashCode.Account_codes_id, Entreprise_id: entrepriseId } }) : null;
    const anchorCatalogue = await prisma.Catalogue.findFirst({ where: { Event_Name: "SELL_GOODS_CASH", Entreprise_id: entrepriseId } });

    // A brand-new business signing up has none of these yet — seed.js was
    // never run for it, since signup never called it. Rather than block
    // setup on that, provision the minimum this Organisation row actually
    // needs (NOT NULL Account_id/Catalogue_id) right here, the same
    // self-provisioning pattern used throughout the posting engine.
    const resolvedCashAccount = cashAccount || (await provisionCashAccount(entrepriseId));
    const resolvedCatalogue = anchorCatalogue || (await provisionSellGoodsCatalogue(entrepriseId));

    const data = {
      Account_id: resolvedCashAccount.Account_id,
      Catalogue_id: resolvedCatalogue.Catalogue_id,
      Organisational_Name: name.trim(),
      Industry: industry || null,
      Organisation_Type: type || null,
      Organisation_Address: address || null,
      Organisation_Country: country || "Kenya",
      Country: country || "Kenya",
      Organisation_Currency: currency || "KES",
      Business_Units: businessUnits || null,
      Entreprise_id: entrepriseId,
    };

    const org = existing
      ? await prisma.Organisation.update({ where: { Entreprise_id: entrepriseId }, data })
      : await prisma.Organisation.create({ data });

    // Open today as the very first trading day for this business — this
    // is the actual fix for "no period open" persisting after signup: the
    // setup wizard never opened one, and nothing else did either.
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyOpenToday = await prisma.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Structures_Name: todayStr, Entreprise_id: entrepriseId },
    });
    if (!alreadyOpenToday) {
      await prisma.Structures.create({
        data: {
          Structures_Type: "ACCOUNTING_PERIOD",
          Framework_Name: "INTERNAL",
          Framework_Priority: 4,
          Structures_Name: todayStr,
          Structures_Description: `Trading day ${todayStr}`,
          Period_name: todayStr,
          Period_Status: "OPEN",
          Structures_Period: new Date(),
          Effective_From: new Date(),
          Effective_To: new Date(),
          Mandatory: 1,
          Rule_Severity: "BLOCK",
          Entreprise_id: entrepriseId,
        },
      });
    }

    res.json({ ok: true, organisationId: org.Entreprise_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error saving business profile" });
  }
});

/**
 * provisionCashAccount / provisionSellGoodsCatalogue — minimal
 * self-provisioning for a brand-new business at the exact moment it needs
 * its very first Account_codes/Account/Catalogue rows, mirroring the
 * pattern already used throughout postingEngine.js. Kept local to this
 * route rather than the shared engine since Organisation-row creation is
 * a one-time setup concern, not a recurring posting operation.
 */
async function provisionCashAccount(entrepriseId) {
  const codeRow = await prisma.Account_codes.create({
    data: { Code: "1000", Code_name: "Cash / Till", Code_categories: "ASSET", Statement_Section: "CURRENT_ASSET", Is_Active: 1, Entreprise_id: entrepriseId },
  });
  return prisma.Account.create({
    data: { Account_Name: "Cash / Till", Account_Type: "ASSET", Account_Code_id: codeRow.Account_codes_id, Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 1, Entreprise_id: entrepriseId },
  });
}

async function provisionSellGoodsCatalogue(entrepriseId) {
  return prisma.Catalogue.create({
    data: {
      Event_Name: "SELL_GOODS_CASH",
      Event_Description: "Cash sale. DR Cash (1000) CR Sales (4000). At point of sale also fires RECORD_COGS.",
      Debit_Account_code: "1000",
      Credit_Account_code: "4000",
      Cash_Flow_Category: "OPERATING",
      Operational_Impact: "INVENTORY_DECREASE",
      Risk_Level: "LOW",
      Documentation_type: "RECEIPT",
      Report_trigger: "DAILY_SALES",
      Escalation_Role: "NONE",
      Cycle_type: "INCOME",
      Alert_Required: 0,
      Narrative_template: "Cash sale: {Quantity} x {Product_Name} at KES {UnitPrice} = KES {Amount}.",
      Evidence_template: "NONE",
      Report_sections: "RECEIPT:LineItem|DAILY_SALES:Revenue",
      Default_Business_Unit: "SHOP",
      Is_Active: 1,
      Version_No: 1,
      Effective_From: new Date("2020-04-01"),
      Entreprise_id: entrepriseId,
    },
  });
}

// POST /api/stakeholders — add a new Stakeholder
router.post("/stakeholders", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { firstName, lastName, category, relationship, location } = req.body;
    if (!firstName || !firstName.trim()) return res.status(400).json({ error: "First name is required" });

    const stakeholder = await prisma.Stakeholder.create({
      data: {
        First_name: firstName.trim(),
        Last_name: lastName ? lastName.trim() : null,
        Stakeholder_Category: category || null,
        Relationship_to_owner: relationship || null,
        Location: location || null,
        Relationship_Status: "ACTIVE",
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, stakeholderId: stakeholder.Stakeholder_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding stakeholder" });
  }
});

// POST /api/knowledge — add a Knowledge note, optionally linked to a
// Transactions row or a Records row (a report). This is the "Add Note"
// action on Transactions and Reports.
router.post("/knowledge", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { explanation, context, transactionId, recordsId } = req.body;
    if (!explanation || !explanation.trim()) return res.status(400).json({ error: "Note text is required" });

    // Author references a Stakeholder, but the logged-in Management user
    // may not have one linked (e.g. the generic role accounts). Link it
    // when we can; otherwise the note is still saved, just unattributed
    // at the Stakeholder level — the session still knows who posted it.
    const author = req.currentUser && req.currentUser.Stakeholder_id ? req.currentUser.Stakeholder_id : null;

    const note = await prisma.Knowledge.create({
      data: {
        Explanation: explanation.trim(),
        Knowledge_type: "EXPLANATION",
        Context: context || null,
        Confidence_Level: 3, // "Based on experience" — a person's own note, not formally verified
        Language: "en",
        Author: author,
        Transactions_id: transactionId ? Number(transactionId) : null,
        Records_id: recordsId ? Number(recordsId) : null,
        Entry_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, knowledgeId: note.Knowledge_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error saving note" });
  }
});

// POST /api/management — link an existing Stakeholder to a Management role
router.post("/management", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { stakeholderId, role, accessLevel } = req.body;
    if (!stakeholderId) return res.status(400).json({ error: "stakeholderId is required" });
    if (!role || !role.trim()) return res.status(400).json({ error: "Role is required" });

    const stakeholder = await prisma.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
    if (!stakeholder || stakeholder.Entreprise_id !== entrepriseId) return res.status(400).json({ error: "Stakeholder not found" });

    const anchorCatalogue = await prisma.Catalogue.findFirst({ where: { Event_Name: "SELL_GOODS_CASH", Entreprise_id: entrepriseId } });
    if (!anchorCatalogue) return res.status(400).json({ error: "System not fully seeded yet. Run the seed script first." });

    const management = await prisma.Management.create({
      data: {
        Catalogue_id: anchorCatalogue.Catalogue_id,
        Stakeholder_id: Number(stakeholderId),
        Management_Name: [stakeholder.First_name, stakeholder.Last_name].filter(Boolean).join(" "),
        Management_Role: role.trim(),
        Access_Level: accessLevel || "VIEWER",
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, managementId: management.Administration_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding management role" });
  }
});

// POST /api/management/:id/edit — update an existing user's role/access level (Owner only, gated on the page route)
router.post("/management/:id/edit", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role, accessLevel } = req.body;
    const target = await prisma.Management.findUnique({ where: { Administration_id: id } });
    if (!target) return res.status(404).json({ error: "User not found" });

    // Guard: never let the last remaining Owner be demoted away from OWNER_FULL
    if (target.Access_Level === "OWNER_FULL" && accessLevel !== "OWNER_FULL") {
      const ownerCount = await prisma.Management.count({ where: { Access_Level: "OWNER_FULL" } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Can't change this — they're the only Owner account. Promote someone else to Owner first." });
      }
    }

    await prisma.Management.update({
      where: { Administration_id: id },
      data: { Management_Role: role || target.Management_Role, Access_Level: accessLevel || target.Access_Level },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error updating user" });
  }
});

// POST /api/management/:id/delete — remove a user's Management role (Owner only, gated on the page route)
router.post("/management/:id/delete", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = await prisma.Management.findUnique({ where: { Administration_id: id } });
    if (!target) return res.status(404).json({ error: "User not found" });

    // Hard block, not just a warning: deleting the last Owner would lock
    // everyone out of Owner-only sections with no way back in.
    if (target.Access_Level === "OWNER_FULL") {
      const ownerCount = await prisma.Management.count({ where: { Access_Level: "OWNER_FULL" } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Can't delete the only Owner account. Promote someone else to Owner first." });
      }
    }

    await prisma.Management.delete({ where: { Administration_id: id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    // Foreign key constraints (Journal.Administration_id, Records.Administration_id, etc.)
    // will block deletion of anyone who has actually posted transactions — surface that plainly.
    if (err.code === "P2003" || (err.message && err.message.includes("Foreign key"))) {
      return res.status(400).json({ error: "This user has posted transactions and can't be deleted. Change their access level instead." });
    }
    res.status(500).json({ error: "Internal error deleting user" });
  }
});

// POST /api/setup/business-unit — create a new BUSINESS_UNIT Structures row.
// Used both by the first-run setup wizard and the Business page's "Add
// Business Unit" action later in the business's life.
router.post("/setup/business-unit", async (req, res) => {
  try {
    const entrepriseId = req.currentUser ? req.currentUser.Entreprise_id : null;
    if (!entrepriseId) return res.status(401).json({ error: "Not logged in." });

    const { code, description } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: "A unit code is required" });
    const normalizedCode = code.trim().toUpperCase();

    const existing = await prisma.Structures.findFirst({
      where: { Structures_Type: "BUSINESS_UNIT", Structures_Name: normalizedCode, Entreprise_id: entrepriseId },
    });
    if (existing) return res.status(400).json({ error: `A business unit named "${normalizedCode}" already exists.` });

    const unit = await prisma.Structures.create({
      data: {
        Structures_Type: "BUSINESS_UNIT",
        Framework_Name: "INTERNAL",
        Framework_Priority: 4,
        Structures_Name: normalizedCode,
        Structures_Description: description && description.trim() ? `${normalizedCode} — ${description.trim()}` : normalizedCode,
        Mandatory: 1,
        Rule_Severity: "INFO",
        Applies_To_Table: "TRANSACTION",
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, structureId: unit.Structures_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error adding business unit" });
  }
});

// POST /api/reports/:id/status — advance a report's review/approval status.
// Distinct from Report_Stage (position in the close chain, set once at
// generation and never changed) — this tracks whether a human has actually
// reviewed, approved, or issued the report, independent of where it sits
// in the accounting chain.
router.post("/reports/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["DRAFT", "GENERATED", "REVIEWED", "APPROVED", "ISSUED", "SUPERSEDED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
    }
    const reportId = Number(req.params.id);
    const report = await prisma.Reports.findUnique({ where: { Reports_id: reportId } });
    if (!report) return res.status(404).json({ error: "Report not found" });

    await prisma.Reports.update({ where: { Reports_id: reportId }, data: { Report_Status: status } });
    res.json({ ok: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error updating report status" });
  }
});

module.exports = router;
