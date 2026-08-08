/**
 * investments.js — the Investments domain: acquiring and disposing of
 * financial instruments (bonds, shares, and similar Money-market
 * placements). Matches the Money > Investments page, which the Till
 * redirects to whenever someone selects an Investment product, since
 * buying or selling one needs to create/update a Money instrument rather
 * than post a simple Cash-to-Expense/Inventory movement.
 */

const {
  prisma,
  PostingError,
  resolvePaymentAccount,
  openTransactionCycle,
  postJournalPair,
  writeNarrative,
  buildCycleReference,
  round2,
  mustFindOrCreateCatalogue,
  mustFindOrCreateAccount,
  findOrCreateExpensePlaceholder,
} = require("./core");

/**
 * postInvestmentPurchase — acquires a financial instrument: DR Investments
 * (1500, a balance-sheet asset), CR the paying account (Cash/Mobile/Bank).
 * Creates the Money instrument row that tracks the holding going forward.
 */
async function postInvestmentPurchase(input) {
  const { name, amount, paymentMethod = "CASH", interestRate = null, maturityDate = null, productId = null, administrationId = null, businessUnit = "INVESTMENTS", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!name || !name.trim()) throw new PostingError("Investment name is required");
  if (!amount || amount <= 0) throw new PostingError("Amount must be positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK" — an investment purchase is always a real cash-equivalent payment.');

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "PURCHASE_INVESTMENT",
      description: "Acquire a financial instrument (bond, shares, similar Money-market placement). DR Investments (1500) CR Cash/Mobile/Bank. Creates a Money row tracking the holding. IFRS 9.",
      debitCode: "1500",
      creditCode: "1000",
      cashFlowCategory: "INVESTING",
      riskLevel: "MEDIUM",
      cycleType: "INVESTMENT",
      alertRequired: 1,
      narrativeTemplate: "Acquired {Product_Name} for KES {Amount}.",
      reportSections: "BALANCE_SHEET:Investments|CASH_FLOW:Investing",
      businessUnit,
      entrepriseId,
    });

    const investmentsAccount = await mustFindOrCreateAccount(tx, "1500", "Investments", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "pay", entrepriseId);

    const product = productId
      ? await tx.Product.findUnique({ where: { Product_id: Number(productId) } })
      : await findOrCreateExpensePlaceholder(tx, name.trim(), entrepriseId);
    if (productId && (!product || product.Entreprise_id !== entrepriseId)) {
      throw new PostingError("Investment product not found");
    }

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(amount),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: product.Product_id,
      quantity: 1,
      amount: round2(amount),
      businessEvent: "PURCHASE",
      cycleType: "INVESTMENT",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("investment"),
      entrepriseId,
    });

    const journal = await postJournalPair(tx, {
      debitAccount: investmentsAccount,
      creditAccount: paymentAccount,
      amount: round2(amount),
      catalogueId: catalogue.Catalogue_id,
      transactionId: transaction.Transactions_id,
      productId: product.Product_id,
      periodId: openPeriod.Structures_id,
      administrationId,
      description: `PURCHASE INVESTMENT: ${name.trim()} for ${amount} (${paymentMethod})`,
      entrepriseId,
    });

    const money = await tx.Money.create({
      data: {
        Account_id: investmentsAccount.Account_id,
        Product_id: product.Product_id,
        Transactions_id: transaction.Transactions_id,
        Instrument_type: "MONEY_MARKET",
        Instrument_Class: interestRate ? "AMORTIZED_COST" : "FAIR_VALUE_OCI",
        Accounting_Treatment: interestRate ? "AMORTIZED_COST_EIR" : "FAIR_VALUE_MARKET",
        Money_Status: "ACTIVE",
        Risk_Level: "MEDIUM",
        Money_Name: name.trim(),
        Principal_amount: round2(amount),
        Interest_rate: interestRate,
        Outstanding_Amount: round2(amount),
        Start_date: new Date(),
        Maturity_date: maturityDate ? new Date(maturityDate) : null,
        Entreprise_id: entrepriseId,
      },
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Product_Name: name.trim(),
      Amount: amount.toFixed(2),
    }, entrepriseId);

    return { transaction, journal, money, narrative };
  });
}

/**
 * postInvestmentSale — sells or redeems an existing Money instrument. DR
 * the receiving account (Cash/Mobile/Bank), CR Investments (1500) at the
 * instrument's carrying amount, with any difference posted as a realised
 * gain or loss against the same Gain/Loss on Disposal account used for
 * fixed-asset disposals.
 */
async function postInvestmentSale(input) {
  const { moneyId, proceeds, paymentMethod = "CASH", administrationId = null, businessUnit = "INVESTMENTS", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required — every posting must belong to a specific business.");
  if (!moneyId) throw new PostingError("moneyId is required");
  if (proceeds == null || proceeds < 0) throw new PostingError("Proceeds must be zero or positive");
  if (!["CASH", "MOBILE", "BANK"].includes(paymentMethod)) throw new PostingError('paymentMethod must be "CASH", "MOBILE", or "BANK"');

  return prisma.$transaction(async (tx) => {
    const openPeriod = await tx.Structures.findFirst({
      where: { Structures_Type: "ACCOUNTING_PERIOD", Period_Status: "OPEN", Entreprise_id: entrepriseId },
      orderBy: { Structures_id: "desc" },
    });
    if (!openPeriod) throw new PostingError("No OPEN accounting period found. Open today's period before posting.");

    const money = await tx.Money.findUnique({ where: { Money_id: Number(moneyId) } });
    if (!money || money.Entreprise_id !== entrepriseId || money.Instrument_type !== "MONEY_MARKET") {
      throw new PostingError("Investment not found");
    }
    if (money.Money_Status !== "ACTIVE") {
      throw new PostingError(`This investment is already ${money.Money_Status.toLowerCase()} — nothing further to sell.`);
    }

    const carryingAmount = Number(money.Principal_amount || 0);
    const gainLoss = round2(proceeds - carryingAmount);

    const catalogue = await mustFindOrCreateCatalogue(tx, {
      eventName: "SELL_INVESTMENT",
      description: "Sell or redeem a financial instrument. DR Cash/Mobile/Bank CR Investments (1500) at carrying amount, with any difference posted as a realised gain or loss. IFRS 9.",
      debitCode: "1000",
      creditCode: "1500",
      cashFlowCategory: "INVESTING",
      riskLevel: "MEDIUM",
      cycleType: "INVESTMENT",
      alertRequired: 1,
      narrativeTemplate: "Sold {Product_Name} for KES {Amount}. {GainLossLabel}: KES {GainLossAmount}.",
      reportSections: "BALANCE_SHEET:Investments|CASH_FLOW:Investing|INCOME_STATEMENT:GainLossOnDisposal",
      businessUnit,
      entrepriseId,
    });

    const investmentsAccount = await mustFindOrCreateAccount(tx, "1500", "Investments", "ASSET", "DEBIT", "NON_CURRENT_ASSET", entrepriseId);
    const paymentAccount = await resolvePaymentAccount(tx, paymentMethod, "receive", entrepriseId);

    let gainLossCodeRow = await tx.Account_codes.findFirst({ where: { Code: "4500", Entreprise_id: entrepriseId } });
    if (!gainLossCodeRow) {
      gainLossCodeRow = await tx.Account_codes.create({
        data: {
          Code: "4500",
          Code_name: "Gain/Loss on Disposal of Assets",
          Code_categories: gainLoss >= 0 ? "INCOME" : "EXPENDITURE",
          Statement_Section: "OTHER_INCOME",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }
    let gainLossAccount = await tx.Account.findFirst({ where: { Account_Code_id: gainLossCodeRow.Account_codes_id, Entreprise_id: entrepriseId } });
    if (!gainLossAccount) {
      gainLossAccount = await tx.Account.create({
        data: {
          Account_Name: "Gain/Loss on Disposal of Assets",
          Account_Type: "INCOME",
          Account_Code_id: gainLossCodeRow.Account_codes_id,
          Normal_Balance: "CREDIT",
          Current_Balance: 0,
          Authoritative_Source: "JOURNAL",
          Is_Active: 1,
          Entreprise_id: entrepriseId,
        },
      });
    }

    const product = money.Product_id ? await tx.Product.findUnique({ where: { Product_id: money.Product_id } }) : null;
    const placeholderProduct = product || (await findOrCreateExpensePlaceholder(tx, money.Money_Name || "Investment", entrepriseId));

    const recordsRow = await tx.Records.create({
      data: {
        Catalogue_id: catalogue.Catalogue_id,
        Records_type: "TRANSACTION_BATCH",
        Records_date: new Date(),
        Period_id: openPeriod.Structures_id,
        Business_Unit: businessUnit,
        Administration_id: administrationId,
        Batch_Status: "OPEN",
        Records_Totals: round2(proceeds),
        Entreprise_id: entrepriseId,
      },
    });

    const transaction = await openTransactionCycle(tx, {
      accountId: paymentAccount.Account_id,
      productId: placeholderProduct.Product_id,
      quantity: 1,
      amount: round2(proceeds),
      businessEvent: "SALE",
      cycleType: "INVESTMENT",
      businessUnit,
      recordsId: recordsRow.Records_id,
      cycleReference: buildCycleReference("investment-sale"),
      entrepriseId,
    });

    const journal = [];
    journal.push(
      ...(await postJournalPair(tx, {
        debitAccount: paymentAccount,
        creditAccount: investmentsAccount,
        amount: carryingAmount,
        catalogueId: catalogue.Catalogue_id,
        transactionId: transaction.Transactions_id,
        productId: placeholderProduct.Product_id,
        periodId: openPeriod.Structures_id,
        administrationId,
        description: `SELL INVESTMENT: ${money.Money_Name} at carrying amount ${carryingAmount} (${paymentMethod})`,
        entrepriseId,
      }))
    );
    if (gainLoss !== 0) {
      journal.push(
        ...(await postJournalPair(tx, {
          debitAccount: gainLoss < 0 ? gainLossAccount : null,
          creditAccount: gainLoss > 0 ? gainLossAccount : null,
          amount: Math.abs(gainLoss),
          catalogueId: catalogue.Catalogue_id,
          transactionId: transaction.Transactions_id,
          productId: placeholderProduct.Product_id,
          periodId: openPeriod.Structures_id,
          administrationId,
          description: `SELL INVESTMENT: ${gainLoss > 0 ? "gain" : "loss"} on sale of ${money.Money_Name}`,
          entrepriseId,
        }))
      );
      if (gainLoss > 0) {
        journal.push(
          ...(await postJournalPair(tx, {
            debitAccount: paymentAccount,
            creditAccount: null,
            amount: gainLoss,
            catalogueId: catalogue.Catalogue_id,
            transactionId: transaction.Transactions_id,
            productId: placeholderProduct.Product_id,
            periodId: openPeriod.Structures_id,
            administrationId,
            description: `SELL INVESTMENT: additional proceeds above carrying amount for ${money.Money_Name}`,
            entrepriseId,
          }))
        );
      }
    }

    await tx.Money.update({
      where: { Money_id: money.Money_id },
      data: { Money_Status: "CLOSED", Outstanding_Amount: 0, Settlement_transaction_id: transaction.Transactions_id },
    });

    const narrative = await writeNarrative(tx, catalogue, transaction, recordsRow, {
      Product_Name: money.Money_Name,
      Amount: proceeds.toFixed(2),
      GainLossLabel: gainLoss >= 0 ? "Gain" : "Loss",
      GainLossAmount: Math.abs(gainLoss).toFixed(2),
    }, entrepriseId);

    return { transaction, journal, gainLoss, narrative };
  });
}

module.exports = { postInvestmentPurchase, postInvestmentSale };
