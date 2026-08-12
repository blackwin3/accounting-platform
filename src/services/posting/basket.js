/**
 * basket.js — the Point-of-Sale domain: ringing up a basket of goods,
 * either sold to a customer or bought into stock. Formerly till.js,
 * renamed during the Catalogue-driven interpreter migration: postBasket
 * is genuinely an orchestrator that loops over many line items and
 * resolves a Catalogue event per line (via resolveLineCatalogue below),
 * plus handles discount/credit-split logic across the whole basket —
 * fundamentally different in kind from the single fixed-shape events
 * (postFunding, postExpense, postAssetImpairment, etc.) that now
 * genuinely call the interpreter's runCatalogueEvent/runDisposalEvent
 * directly. Forcing this multi-line orchestrator into that same pattern
 * would have been dishonest — it does call Catalogue lookups
 * internally (mustFindCatalogue, resolveLineCatalogue), just not once
 * per basket the way every migrated function does once per call.
 */

const {
  prisma,
  PostingError,
  PAYMENT_METHODS,
  resolvePaymentAccount,
  mustFindCatalogue,
  resolveAllAccounts,
  openTransactionCycle,
  postJournalPair,
  adjustResourceQuantity,
  writeNarrative,
  buildCycleReference,
  round2,
  findOrCreateExpensePlaceholder,
  generateReceipt,
} = require("./core");

/**
 * resolveLineCatalogue — per-line-item Catalogue resolution for the Till.
 * Goods, Services, and Utilities are genuinely different kinds of events
 * (different accounts, different narrative, different meaning), so each
 * gets its own Catalogue row and its own narrative template rather than
 * every purchase/sale sharing BUY_INVENTORY_CASH/SELL_GOODS_CASH's fixed
 * "Added to inventory" wording regardless of what was actually bought or
 * sold. Self-provisions the Catalogue row on first use, same pattern as
 * every other auto-provisioning helper in this engine.
 */
async function resolveLineCatalogue(tx, { eventName, isUtility, isService, isSell, entrepriseId }) {
  let catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
  if (catalogue) return catalogue;

  let narrativeTemplate, description, debitCode, creditCode, cycleType;
  if (!isUtility && !isService) {
    // Goods — unchanged from the original BUY_INVENTORY_CASH/SELL_GOODS_CASH wording
    narrativeTemplate = isSell
      ? "Sold {Quantity} {Product_Name} for KES {Amount}."
      : "Purchased {Quantity} {Product_Name} for KES {Amount}. Added to inventory.";
    description = isSell ? "Cash sale of goods." : "Purchase of inventory.";
    debitCode = isSell ? "1000" : "1100";
    creditCode = isSell ? "4000" : "1000";
    cycleType = isSell ? "INCOME" : "INVENTORY";
  } else if (isUtility) {
    // Utility — a token/unit consumed or, less commonly, provided by the
    // business (e.g. a landlord unit reselling metered electricity). The
    // unit word itself (token, unit, litre, etc.) comes from the
    // product's own Product_Unit field, not a hardcoded "unit" — an
    // electricity token and an NWSC water unit are genuinely different
    // things and should read that way.
    narrativeTemplate = isSell
      ? "Provided {Quantity} {Unit} {Product_Name} for KES {Amount}. Offered by Business."
      : "Purchased {Quantity} {Unit} {Product_Name} for KES {Amount}. Added to Business.";
    description = isSell ? "A utility provided by the business." : "A utility consumed by the business — electricity, water, internet.";
    debitCode = isSell ? "1000" : "5400";
    creditCode = isSell ? "4600" : "1000";
    cycleType = "EXPENDITURE";
  } else {
    // Service — direction matters here specifically, per the explicit
    // request: a plumbing visit the business PAYS FOR is a different
    // event from a plumbing visit the business PROVIDES to a customer.
    narrativeTemplate = isSell
      ? "Provided {Quantity} {Product_Name} for KES {Amount}. Offered by Business."
      : "Bought {Quantity} {Product_Name} for KES {Amount}. Added to Business.";
    description = isSell ? "A service offered by the business to a customer." : "A service bought by the business.";
    debitCode = isSell ? "1000" : "5450";
    creditCode = isSell ? "4400" : "1000";
    cycleType = "EXPENDITURE";
  }

  return tx.Catalogue.create({
    data: {
      Event_Name: eventName,
      Event_Description: description,
      Debit_Account_code: debitCode,
      Credit_Account_code: creditCode,
      Cash_Flow_Category: "OPERATING",
      Operational_Impact: isUtility || isService ? "NONE" : (isSell ? "INVENTORY_DECREASE" : "INVENTORY_INCREASE"),
      Risk_Level: "LOW",
      Documentation_type: "RECEIPT",
      Report_trigger: isSell ? "DAILY_SALES" : "DAILY_PURCHASES",
      Escalation_Role: "NONE",
      Cycle_type: cycleType,
      Alert_Required: 0,
      Narrative_template: narrativeTemplate,
      Evidence_template: "RECEIPT",
      Report_sections: isSell ? "RECEIPT:LineItem|DAILY_SALES:Revenue" : "DAILY_REPORT:CashMovement",
      Default_Business_Unit: "SHOP",
      Is_Active: 1,
      Version_No: 1,
      Effective_From: new Date("2020-04-01"),
      Entreprise_id: entrepriseId,
    },
  });
}

/**
 * postBasket — post a full POS basket (one or more line items, one mode:
 * sell or buy) as a single Records (TRANSACTION_BATCH) with correctly
 * split Catalogue events per the standardized reference design:
 *
 *   SELL: fires SELL_GOODS_CASH (DR Cash CR Sales) AND RECORD_COGS
 *         (DR COGS CR Inventory) for every line — two Catalogue events,
 *         four Journal rows per line item.
 *   BUY:  fires BUY_INVENTORY_CASH only (DR Inventory CR Cash) — a
 *         balance-sheet movement, never an income-statement expense.
 *
 * All lines in the basket share one Records_id (Records_type=
 * TRANSACTION_BATCH) and one Cycle_reference, matching the receipt model:
 * Document -> Records -> Transactions (multi-line).
 *
 * Every Journal row is posted against the current OPEN accounting period
 * (Structures_Type=ACCOUNTING_PERIOD, Period_Status=OPEN) via Period_id —
 * this is the authoritative period gate; posting is refused if no OPEN
 * period exists, mirroring the "Closed Period Entry Block" rule.
 *
 * @param {Object} input
 * @param {"sell"|"buy"} input.mode
 * @param {Array<{productId:number, quantity:number, unitPrice:number}>} input.lines
 * @param {"CASH"|"MOBILE"|"BANK"|"CREDIT"} [input.paymentMethod] - defaults to CASH
 * @param {number} [input.discount] - a positive value is a genuine
 *   discount off the basket (see below); a negative value instead means
 *   that portion of the basket is on credit while the rest is paid via
 *   the selected paymentMethod — a split payment. E.g. total 100, paymentMethod
 *   CASH, discount -30: DR Cash 70, DR Trade Receivable 30, CR Sales 100.
 *   This is the simplified alternative to selecting paymentMethod=CREDIT
 *   for the entire basket — the sale/purchase still posts at full list
 *   price (Sales/Inventory unaffected); the discount is a separate DR/CR
 *   against a dedicated Discount account, and is also recorded as a
 *   zero-balance historical Liability row (already settled, not owed) so
 *   it's visible on the Liability page alongside credit activity.
 * @param {string} [input.businessUnit]  - defaults to "SHOP"
 * @param {number} [input.administrationId]
 */
async function postBasket(input) {
  const {
    mode, lines, paymentMethod = "CASH", discount = 0, businessUnit = "SHOP", administrationId = null,
    stakeholderId = null, paymentReference = "", notes = "", entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (mode !== "sell" && mode !== "buy") throw new PostingError('mode must be "sell" or "buy"');
  if (!Array.isArray(lines) || lines.length === 0) throw new PostingError("at least one line item is required");
  if (!PAYMENT_METHODS[paymentMethod] && paymentMethod !== "CREDIT") throw new PostingError(`Unknown payment method "${paymentMethod}"`);
  // A negative discount is meaningful (a partial-credit split) — validated
  // against the basket total further down, once runningTotal is known.
  for (const line of lines) {
    if (!line.productId) throw new PostingError("each line requires productId");
    if (!line.quantity || line.quantity <= 0) throw new PostingError("each line requires a positive quantity");
    if (line.unitPrice == null || line.unitPrice < 0) throw new PostingError("each line requires a non-negative unitPrice");
  }

  return prisma.$transaction(async (tx) => {
    // 1. Resolve the current OPEN accounting period for THIS business — mandatory gate
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) {
      throw new PostingError(
        "No OPEN accounting period found. An accountant or the system must open today's period before entries can be posted."
      );
    }

    // Verify the referenced stakeholder, if any, genuinely belongs to
    // this business — never trust a client-supplied ID blindly.
    let stakeholder = null;
    if (stakeholderId) {
      stakeholder = await tx.Stakeholder.findUnique({ where: { Stakeholder_id: Number(stakeholderId) } });
      if (!stakeholder || stakeholder.Entreprise_id !== entrepriseId) {
        throw new PostingError("Selected customer/supplier not found for this business.");
      }
    }

    // 2. Resolve accounts once for the basket. The cash-equivalent side
    // (Cash/Mobile/Bank/Receivable/Payable) depends on paymentMethod and
    // sale-vs-purchase direction; everything else comes from the fixed
    // Inventory/Sales/COGS codes.
    const accounts = await resolveAllAccounts(tx, entrepriseId);
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, mode === "sell" ? "receive" : "pay", entrepriseId);

    // 3. Resolve the Catalogue blueprint(s) for this basket's mode
    const catalogue = mode === "sell"
      ? {
          sale: await mustFindCatalogue(tx, "SELL_GOODS_CASH", entrepriseId),
          cogs: await mustFindCatalogue(tx, "RECORD_COGS", entrepriseId),
        }
      : {
          purchase: await mustFindCatalogue(tx, "BUY_INVENTORY_CASH", entrepriseId),
        };
    const primaryCatalogueId = mode === "sell" ? catalogue.sale.Catalogue_id : catalogue.purchase.Catalogue_id;

    // 4. Open the Records batch (one receipt/ticket for the whole basket)
    const cycleReference = buildCycleReference(mode);
    const recordsData = {
      Catalogue_id: primaryCatalogueId, // NOT NULL in schema; set to the basket's primary event
      Records_type: "TRANSACTION_BATCH",
      Records_date: new Date(),
      Period_id: openPeriod.Structures_id,
      Business_Unit: businessUnit,
      Administration_id: administrationId,
      Batch_Status: "OPEN",
      Entreprise_id: entrepriseId,
    };
    // Stakeholder_id is only included when actually set. If the Prisma
    // client hasn't been regenerated since migration 12 added this
    // column (a real deployment-sync risk — `prisma generate` must run
    // after `prisma db pull` for a new column to actually be usable),
    // this at least lets the overwhelming majority of baskets, which
    // reference no stakeholder at all, succeed rather than crash.
    if (stakeholder) {
      recordsData.Stakeholder_id = stakeholder.Stakeholder_id;
    }

    let recordsRow;
    try {
      recordsRow = await tx.Records.create({ data: recordsData });
    } catch (err) {
      // If the Prisma client genuinely doesn't recognise Stakeholder_id
      // yet (client out of sync with the migration), retry once without
      // it rather than fail the whole sale — the stakeholder link is a
      // nice-to-have for a credit sale's context, not something that
      // should ever block a real transaction from posting.
      if (stakeholder && err.message && err.message.includes("Stakeholder_id")) {
        const { Stakeholder_id, ...fallbackData } = recordsData;
        recordsRow = await tx.Records.create({ data: fallbackData });
      } else {
        throw err;
      }
    }

    // A human-entered note (distinct from the system-generated per-line
    // narrative below) — most useful for exactly the cases named: a
    // Mobile Money reference, why a discount was given, or who a credit
    // sale is actually for. Written once for the whole basket, not per
    // line, since it's context about the transaction as a whole.
    if (notes && notes.trim()) {
      await tx.Narrative.create({
        data: {
          Records_id: recordsRow.Records_id,
          Narrative_type: "NOTE",
          Narrative_source: "HUMAN",
          Narrative_audience: "OWNER",
          Is_Generated: 0,
          Description: notes.trim(),
          Language: "en",
          Author: administrationId,
          Narrative_date: new Date(),
          Entreprise_id: entrepriseId,
        },
      });
    }

    const postedTransactions = [];
    const postedJournal = [];
    let runningTotal = 0;

    for (const line of lines) {
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.unitPrice);
      const amount = round2(quantity * unitPrice);
      runningTotal += amount;

      const product = await tx.Product.findUnique({ where: { Product_id: Number(line.productId) } });
      if (!product || product.Entreprise_id !== entrepriseId) throw new PostingError(`Product ${line.productId} not found`);

      if (mode === "sell") {
        // Route the sale by what's actually being sold. A can of sugar is
        // physical stock leaving the shelf; an electricity token or a
        // plumbing visit is not — treating every sale as an inventory
        // movement was the actual bug behind "products overlap in
        // accounts": every sale, regardless of type, was posting to the
        // exact same generic Sales/Inventory/COGS accounts.
        const isUtility = !!product.Is_Utility;
        const isService = !isUtility && !!product.Is_Service;

        // BUSINESS-tier check: enough stock exists to cover this sale.
        // Only real Goods carry a physical quantity — a Utility token or a
        // Service has nothing on a shelf to run short of.
        if (!isUtility && !isService) {
          const resource = await tx.Resources.findFirst({ where: { Product_id: product.Product_id } });
          const available = resource ? Number(resource.Resources_Quantity || 0) : 0;
          if (quantity > available) {
            throw new PostingError(
              `Not enough ${product.Product_Name} in stock: ${quantity} requested, ${available} available. Record a purchase first, or reduce the quantity.`
            );
          }
        }

        const incomeEventLabel = isUtility ? "SELL_UTILITY" : isService ? "SELL_SERVICE" : "SELL_GOODS_CASH";
        // Readable label for the Journal description — distinct from
        // incomeEventLabel, which stays as the internal event name used
        // for Catalogue lookups and Income_type. "SELL_GOODS_CASH" reads
        // as though every sale were cash-only, which stopped being true
        // once Mobile/Bank/Credit payment methods existed — the payment
        // source is already shown separately at the end of the line.
        //
        // FORMERLY a genuine risk: money.js's Cash Flow route used to
        // classify Journal rows by matching against these exact display
        // strings, which broke for real once already when a label was
        // reworded and the classification logic wasn't updated to match.
        // Cash Flow now reads Journal.Catalogue_id -> Catalogue.Event_Name
        // instead (a real, stable key that's never shown to a user), so
        // this label is genuinely free to reword without any risk to
        // Direct-vs-Indirect reconciliation.
        const sellDescriptionLabel = isUtility ? "SELL UTILITY" : isService ? "SELL SERVICE" : "SELL GOODS";
        const lineCatalogue = await resolveLineCatalogue(tx, { eventName: incomeEventLabel, isUtility, isService, isSell: true, entrepriseId });
        // The income account genuinely comes from the Catalogue row's own
        // Credit_Account_code now, not a second, independently
        // re-derived isUtility/isService branch — resolveLineCatalogue
        // already wrote the authoritative code when it seeded this row;
        // trusting it here means there's only one place this choice is
        // actually made, not two copies that could silently drift apart.
        const incomeAccount = accounts[lineCatalogue.Credit_Account_code];
        if (!incomeAccount) {
          throw new PostingError(`Account code "${lineCatalogue.Credit_Account_code}" from Catalogue event "${incomeEventLabel}" has no matching Account row for this business.`);
        }

        // --- Leg A: DR Cash/Mobile/Bank/Receivable, CR the matching income account ---
        const saleTxn = await openTransactionCycle(tx, {
          accountId: paymentAccount.Account_id,
          productId: product.Product_id,
          quantity,
          amount,
          businessEvent: "SALE",
          cycleType: "INCOME",
          businessUnit,
          recordsId: recordsRow.Records_id,
          cycleReference,
          referenceNo: paymentMethod === "MOBILE" && paymentReference ? paymentReference : null,
          entrepriseId,
        });
        postedTransactions.push(saleTxn);

        postedJournal.push(
          ...(await postJournalPair(tx, {
            debitAccount: paymentAccount, // Cash / Mobile / Bank / Trade Receivable
            creditAccount: incomeAccount, // Sales, Service Income, or Utility Income — never blended together
            amount,
            catalogueId: lineCatalogue.Catalogue_id,
            transactionId: saleTxn.Transactions_id,
            productId: product.Product_id,
            periodId: openPeriod.Structures_id,
            administrationId,
            description: `${sellDescriptionLabel}: ${quantity} x ${product.Product_Name} @ ${unitPrice} (${paymentMethod})`,
            entrepriseId,
          }))
        );

        // --- Leg B: RECORD_COGS — Goods only. A Service or Utility has no
        // stock to relieve, so there is nothing to match against Inventory. ---
        if (!isUtility && !isService) {
          const unitCost = Number(product.Product_Cost || 0);
          const cogsAmount = round2(quantity * unitCost);
          // Same fix as the sell/buy branches above: read COGS's accounts
          // from catalogue.cogs's own Debit_Account_code/Credit_Account_code,
          // not a second hardcoded copy of the same codes.
          const cogsExpenseAccount = accounts[catalogue.cogs.Debit_Account_code];
          const inventoryAccount = accounts[catalogue.cogs.Credit_Account_code];
          if (cogsExpenseAccount && inventoryAccount && cogsAmount > 0) {
            postedJournal.push(
              ...(await postJournalPair(tx, {
                debitAccount: cogsExpenseAccount,
                creditAccount: inventoryAccount,
                amount: cogsAmount,
                catalogueId: catalogue.cogs.Catalogue_id,
                transactionId: saleTxn.Transactions_id,
                productId: product.Product_id,
                periodId: openPeriod.Structures_id,
                administrationId,
                description: `COST OF GOODS SOLD: ${quantity} x ${product.Product_Name} @ cost ${unitCost}`,
                entrepriseId,
              }))
            );
          }

          // Inventory physically decreases only for real stock
          await adjustResourceQuantity(tx, product.Product_id, quantity, "INVENTORY_DECREASE");
        }

        // System narrative for this line
        await writeNarrative(tx, lineCatalogue, saleTxn, recordsRow, {
          Quantity: quantity,
          Product_Name: product.Product_Name,
          Unit: product.Product_Unit || "unit",
          UnitPrice: unitPrice.toFixed(2),
          Amount: amount.toFixed(2),
        }, entrepriseId);

        // Income snapshot
        await tx.Income.create({
          data: {
            Catalogue_id: lineCatalogue.Catalogue_id,
            Account_id: incomeAccount.Account_id,
            Records_id: recordsRow.Records_id,
            Transactions_id: saleTxn.Transactions_id,
            Income_type: incomeEventLabel,
            Business_Unit: businessUnit,
            Net_Amount: amount,
            Cash_Received: paymentMethod === "CREDIT" ? 0 : amount,
            Outstanding_Amount: paymentMethod === "CREDIT" ? amount : 0,
            Period_id: openPeriod.Structures_id,
            Period: new Date(),
            Entreprise_id: entrepriseId,
          },
        });
      } else {
        // Route the purchase by what's actually being bought. A sack of
        // sugar becomes stock on the shelf (an asset until sold); an
        // electricity token or an internet subscription is consumed
        // immediately and is never inventory — it was incorrectly
        // capitalised as Inventory before this fix, which is exactly the
        // setup-flow bug: paying for water/electricity/internet should
        // reduce Cash and record an expense, not inflate stock value.
        const isUtility = !!product.Is_Utility;
        const isService = !isUtility && !!product.Is_Service;
        const purchaseEventLabel = isUtility ? "PAY_UTILITY" : isService ? "PAY_SERVICE" : "BUY_INVENTORY_CASH";
        // Readable label for the Journal description, per the same reasoning
        // as sellDescriptionLabel above — the payment source is already
        // shown separately at the end of the line. FORMERLY a genuine risk
        // (see the identical note on sellDescriptionLabel) — money.js's
        // Cash Flow classification no longer matches against this string
        // at all, so it's genuinely free to reword now.
        const buyDescriptionLabel = isUtility ? "PAY UTILITY" : isService ? "PAY SERVICE" : "BUY INVENTORY";
        const lineCatalogue = await resolveLineCatalogue(tx, { eventName: purchaseEventLabel, isUtility, isService, isSell: false, entrepriseId });
        // Same fix as the sell branch above: read the debit account from
        // the Catalogue row's own Debit_Account_code rather than a
        // second, independently re-derived isUtility/isService branch.
        const debitAccount = accounts[lineCatalogue.Debit_Account_code];
        if (!debitAccount) {
          throw new PostingError(`Account code "${lineCatalogue.Debit_Account_code}" from Catalogue event "${purchaseEventLabel}" has no matching Account row for this business.`);
        }

        const buyTxn = await openTransactionCycle(tx, {
          accountId: paymentAccount.Account_id,
          productId: product.Product_id,
          quantity,
          amount,
          businessEvent: isUtility || isService ? "PAYMENT" : "PURCHASE",
          cycleType: isUtility || isService ? "EXPENDITURE" : "INVENTORY",
          businessUnit,
          recordsId: recordsRow.Records_id,
          cycleReference,
          referenceNo: paymentMethod === "MOBILE" && paymentReference ? paymentReference : null,
          entrepriseId,
        });
        postedTransactions.push(buyTxn);

        postedJournal.push(
          ...(await postJournalPair(tx, {
            debitAccount, // Inventory (Goods), Utilities (5400), or Service Expense (5450) — never blended
            creditAccount: paymentAccount, // Cash / Mobile / Bank / Trade Payable
            amount,
            catalogueId: lineCatalogue.Catalogue_id,
            transactionId: buyTxn.Transactions_id,
            productId: product.Product_id,
            periodId: openPeriod.Structures_id,
            administrationId,
            description: `${buyDescriptionLabel}: ${quantity} x ${product.Product_Name} @ ${unitPrice} (${paymentMethod})`,
            entrepriseId,
          }))
        );

        // Only real Goods increase physical stock — a utility or service
        // has no quantity on a shelf to track.
        if (!isUtility && !isService) {
          await adjustResourceQuantity(tx, product.Product_id, quantity, "INVENTORY_INCREASE");
        }

        await writeNarrative(tx, lineCatalogue, buyTxn, recordsRow, {
          Quantity: quantity,
          Product_Name: product.Product_Name,
          Unit: product.Product_Unit || "unit",
          Amount: amount.toFixed(2),
        }, entrepriseId);

        // NOTE: deliberately NOT writing an Expenditure row against an
        // expense account here — inventory purchase is a balance-sheet
        // movement (Dr Inventory Cr Cash), never an income-statement
        // expense, per the reference design. COGS (the real expense)
        // is recognised later, at the point of sale, via RECORD_COGS.
      }
    }

    let discountLiability = null;
    let creditSplitLiability = null;

    if (discount < 0) {
      // Negative discount: a partial-credit split. The basket already
      // posted in full against the selected paymentMethod's account —
      // this adjustment moves the credit portion over to Trade
      // Receivable/Payable instead, so the net effect is a genuine split
      // between what's actually collected/paid now and what's owed.
      const creditAmount = round2(Math.abs(discount));
      if (creditAmount > runningTotal) {
        throw new PostingError(`Credit portion (KES ${creditAmount}) cannot exceed the basket total (KES ${runningTotal.toFixed(2)}).`);
      }
      if (paymentMethod === "CREDIT") {
        throw new PostingError("Payment method is already Credit for the whole basket — a negative discount split doesn't apply.");
      }

      const isSell = mode === "sell";
      const splitEventName = isSell ? "PARTIAL_CREDIT_SALE" : "PARTIAL_CREDIT_PURCHASE";
      const splitLabel = isSell ? "Trade Receivables" : "Trade Payables";

      let splitCatalogue = await tx.Catalogue.findFirst({ where: { Event_Name: splitEventName, Entreprise_id: entrepriseId } });
      if (!splitCatalogue) {
        splitCatalogue = await tx.Catalogue.create({
          data: {
            Event_Name: splitEventName,
            Event_Description: isSell
              ? "A portion of a sale is on credit while the rest was collected via the payment method selected at the till. DR Trade Receivables CR the payment method account, for the credit portion only."
              : "A portion of a purchase is on credit while the rest was paid via the payment method selected at the till. DR the payment method account CR Trade Payables, for the credit portion only.",
            Debit_Account_code: isSell ? "1200" : "1000",
            Credit_Account_code: isSell ? "1000" : "2000",
            Cash_Flow_Category: "NONE", // the cash leg was already counted in the basket's own postings; this only reclassifies part of it
            Operational_Impact: "NONE",
            Risk_Level: "LOW",
            Documentation_type: "NONE",
            Report_trigger: "INCOME_STATEMENT",
            Escalation_Role: "NONE",
            Cycle_type: isSell ? "INCOME" : "EXPENDITURE",
            Alert_Required: 0,
            Narrative_template: `KES {Amount} of this basket is on credit (${splitLabel}), the rest paid via {PaymentMethod}.`,
            Evidence_template: "NONE",
            Report_sections: `BALANCE_SHEET:${splitLabel.replace(" ", "")}`,
            Default_Business_Unit: businessUnit,
            Is_Active: 1,
            Version_No: 1,
            Effective_From: new Date("2020-04-01"),
            Entreprise_id: entrepriseId,
          },
        });
      }

      const receivableOrPayableAccount = await resolvePaymentAccount(tx, "CREDIT", isSell ? "receive" : "pay", entrepriseId);
      const splitProduct = await findOrCreateExpensePlaceholder(tx, splitLabel, entrepriseId);

      const splitTxn = await openTransactionCycle(tx, {
        accountId: receivableOrPayableAccount.Account_id,
        productId: splitProduct.Product_id,
        quantity: 1,
        amount: creditAmount,
        businessEvent: "ADJUSTMENT",
        cycleType: isSell ? "INCOME" : "EXPENDITURE",
        businessUnit,
        recordsId: recordsRow.Records_id,
        cycleReference,
        entrepriseId,
      });
      postedTransactions.push(splitTxn);

      postedJournal.push(
        ...(await postJournalPair(tx, {
          debitAccount: isSell ? receivableOrPayableAccount : paymentAccount,
          creditAccount: isSell ? paymentAccount : receivableOrPayableAccount,
          amount: creditAmount,
          catalogueId: splitCatalogue.Catalogue_id,
          transactionId: splitTxn.Transactions_id,
          productId: splitProduct.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `${splitEventName}: KES ${creditAmount} of basket ${cycleReference} on credit, rest via ${paymentMethod}`,
          entrepriseId,
        }))
      );

      await writeNarrative(tx, splitCatalogue, splitTxn, recordsRow, {
        Amount: creditAmount.toFixed(2),
        PaymentMethod: paymentMethod,
      }, entrepriseId);

      // Historical record on the Liability page — this is a genuinely
      // outstanding amount (unlike a settled discount), so it carries the
      // real balance, not a zero.
      creditSplitLiability = await tx.Liability.create({
        data: {
          Catalogue_id: splitCatalogue.Catalogue_id,
          Account_id: receivableOrPayableAccount.Account_id,
          Records_id: recordsRow.Records_id,
          Liability_Type: splitLabel,
          Liability_Classification: "CURRENT",
          Net_Amount: creditAmount,
          Period: new Date(),
          Entreprise_id: entrepriseId,
        },
      });
    } else if (discount > 0) {
      if (discount > runningTotal) {
        throw new PostingError(`Discount (KES ${discount}) cannot exceed the basket total (KES ${runningTotal.toFixed(2)}).`);
      }

      // The sale/purchase above already posted at full list price — Sales
      // and Inventory are unaffected by the discount. The discount itself
      // is a separate reduction against what's actually collected or paid:
      //   Discount given (sell):  DR Discount Allowed, CR Cash/Mobile/Bank/Receivable
      //   Discount taken (buy):   DR Cash/Mobile/Bank/Payable, CR Discount Received
      // This is a simplification of the fuller purchase-discount treatment
      // under IAS 2 (which would reduce inventory cost directly) — kept as
      // a separate visible line instead, per the explicit choice to make
      // discounts individually trackable and reportable rather than folded
      // silently into the transaction price.
      const isSell = mode === "sell";
      const discountEventName = isSell ? "DISCOUNT_ALLOWED" : "DISCOUNT_RECEIVED";
      const discountCode = isSell ? "4900" : "5910";
      const discountLabel = isSell ? "Discount Allowed" : "Discount Received";

      let discountCatalogue = await tx.Catalogue.findFirst({ where: { Event_Name: discountEventName, Entreprise_id: entrepriseId } });
      if (!discountCatalogue) {
        discountCatalogue = await tx.Catalogue.create({
          data: {
            Event_Name: discountEventName,
            Event_Description: isSell
              ? "A discount given to a customer on a sale. Sale itself posts at full list price; this reduces what's actually collected. DR Discount Allowed (4900) CR Cash/Mobile/Bank/Receivable."
              : "A discount received from a supplier on a purchase. Purchase itself posts at full invoiced price; this reduces what's actually paid. DR Cash/Mobile/Bank/Payable CR Discount Received (5910).",
            Debit_Account_code: isSell ? discountCode : null,
            Credit_Account_code: isSell ? null : discountCode,
            Cash_Flow_Category: "NONE", // nets out within the same basket's cash leg, not a separate cash movement
            Operational_Impact: "NONE",
            Risk_Level: "LOW",
            Documentation_type: "NONE",
            Report_trigger: "INCOME_STATEMENT",
            Escalation_Role: "NONE",
            Cycle_type: isSell ? "INCOME" : "EXPENDITURE",
            Alert_Required: 0,
            Narrative_template: `${discountLabel} of KES {Amount} on this basket.`,
            Evidence_template: "NONE",
            Report_sections: `INCOME_STATEMENT:${discountLabel}`,
            Default_Business_Unit: businessUnit,
            Is_Active: 1,
            Version_No: 1,
            Effective_From: new Date("2020-04-01"),
            Entreprise_id: entrepriseId,
          },
        });
      }

      let discountCodeRow = await tx.Account_codes.findFirst({ where: { Code: discountCode, Entreprise_id: entrepriseId } });
      if (!discountCodeRow) {
        discountCodeRow = await tx.Account_codes.create({
          data: {
            Code: discountCode,
            Code_name: discountLabel,
            Code_categories: isSell ? "EXPENDITURE" : "INCOME",
            Statement_Section: isSell ? "OPERATING_EXPENSE" : "OTHER_INCOME",
            Is_Active: 1,
            Entreprise_id: entrepriseId,
          },
        });
      }
      let discountAccount = await tx.Account.findFirst({ where: { Account_Code_id: discountCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
      if (!discountAccount) {
        discountAccount = await tx.Account.create({
          data: {
            Account_Name: discountLabel,
            Account_Type: isSell ? "EXPENDITURE" : "INCOME",
            Account_Code_id: discountCodeRow.Account_codes_id,
            Normal_Balance: isSell ? "DEBIT" : "CREDIT",
            Current_Balance: 0,
            Authoritative_Source: "JOURNAL",
            Is_Active: 1,
            Entreprise_id: entrepriseId,
          },
        });
      }

      const discountProduct = await findOrCreateExpensePlaceholder(tx, discountLabel, entrepriseId);
      const discountTxn = await openTransactionCycle(tx, {
        accountId: paymentAccount.Account_id,
        productId: discountProduct.Product_id,
        quantity: 1,
        amount: round2(discount),
        businessEvent: "ADJUSTMENT",
        cycleType: isSell ? "INCOME" : "EXPENDITURE",
        businessUnit,
        recordsId: recordsRow.Records_id,
        cycleReference,
        entrepriseId,
      });
      postedTransactions.push(discountTxn);

      postedJournal.push(
        ...(await postJournalPair(tx, {
          debitAccount: isSell ? discountAccount : paymentAccount,
          creditAccount: isSell ? paymentAccount : discountAccount,
          amount: round2(discount),
          catalogueId: discountCatalogue.Catalogue_id,
          transactionId: discountTxn.Transactions_id,
          productId: discountProduct.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `${discountLabel.toUpperCase()}: KES ${discount} on basket ${cycleReference}`,
          entrepriseId,
        }))
      );

      await writeNarrative(tx, discountCatalogue, discountTxn, recordsRow, {
        Amount: discount.toFixed(2),
      }, entrepriseId);

      // Zero-balance historical record — already settled, not an
      // outstanding obligation, but grouped on the Liability page per the
      // explicit choice to keep discount/credit activity visible together.
      discountLiability = await tx.Liability.create({
        data: {
          Catalogue_id: discountCatalogue.Catalogue_id,
          Account_id: discountAccount.Account_id,
          Records_id: recordsRow.Records_id,
          Liability_Type: discountLabel,
          Liability_Classification: "CURRENT",
          Net_Amount: 0,
          Period: new Date(),
          Entreprise_id: entrepriseId,
        },
      });
    }

    await tx.Records.update({
      where: { Records_id: recordsRow.Records_id },
      data: { Records_Totals: round2(runningTotal), Batch_Status: "TRADING" },
    });

    // Generate a receipt for this basket
    const receipt = await generateReceipt(tx, {
      recordsId: recordsRow.Records_id,
      transactionId: postedTransactions.length > 0 ? postedTransactions[0].Transactions_id : null,
      amount: round2(runningTotal),
      description: `Basket ${cycleReference}`,
      administrationId: input.administrationId || null,
      entrepriseId: input.entrepriseId,
    });

    return {
      recordsId: recordsRow.Records_id,
      cycleReference,
      total: round2(runningTotal),
      netTotal: discount < 0 ? round2(runningTotal - Math.abs(discount)) : round2(runningTotal - discount), // what's actually collected/paid now
      discount: round2(discount),
      creditSplit: discount < 0 ? round2(Math.abs(discount)) : 0,
      transactions: postedTransactions,
      journal: postedJournal,
      receiptNo: receipt.Documents_no,
    };
  });
}

module.exports = { postBasket };
