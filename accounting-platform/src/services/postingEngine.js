/**
 * postingEngine.js — barrel re-export.
 *
 * This file used to contain the entire posting engine as one ~2400-line
 * file with 25 functions. It's now split by domain into ./posting/:
 *
 *   posting/core.js                — shared infrastructure every domain uses
 *   posting/till.js                — postBasket (POS sell/buy)
 *   posting/assets.js              — purchase, disposal, depreciation, impairment
 *   posting/claims.js              — expenses, receivable/payable settlement
 *   posting/funds.js               — capital/loan funding, unit income
 *   posting/leasesAndProvisions.js — IFRS 16 leases, IAS 37 provisions
 *
 * This file exists purely so every existing
 * `require("../services/postingEngine")` across routes and other services
 * keeps working unchanged — nothing outside this folder needed to know the
 * split happened. If you're adding a new posting function, put it in the
 * domain module it belongs to (or a new one, if it's a genuinely new
 * domain) and add it to the re-export list below — don't add it here.
 */

const core = require("./posting/core");
const till = require("./posting/till");
const assets = require("./posting/assets");
const claims = require("./posting/claims");
const funds = require("./posting/funds");
const leasesAndProvisions = require("./posting/leasesAndProvisions");
const periods = require("./posting/periods");
const investments = require("./posting/investments");
const risks = require("./posting/risks");
const interpreter = require("./posting/interpreter");
const replay = require("./posting/replay");
const processing = require("./posting/processing");
const corrections = require("./posting/corrections");

module.exports = {
  // till.js
  postBasket: till.postBasket,

  // assets.js
  postAssetPurchase: assets.postAssetPurchase,
  postAssetDisposal: assets.postAssetDisposal,
  postDepreciationRun: assets.postDepreciationRun,
  postAssetImpairment: assets.postAssetImpairment,
  postAssetRevaluation: assets.postAssetRevaluation,

  // leasesAndProvisions.js
  postLeaseCommencement: leasesAndProvisions.postLeaseCommencement,
  postLeasePayment: leasesAndProvisions.postLeasePayment,
  postProvision: leasesAndProvisions.postProvision,
  postProvisionUtilisation: leasesAndProvisions.postProvisionUtilisation,

  // claims.js
  postExpense: claims.postExpense,
  postReceivableSettlement: claims.postReceivableSettlement,
  postPayableSettlement: claims.postPayableSettlement,
  EXPENSE_CATEGORIES: claims.EXPENSE_CATEGORIES,

  // funds.js
  postFunding: funds.postFunding,
  postUnitIncome: funds.postUnitIncome,
  postFundTransfer: funds.postFundTransfer,
  INCOME_TYPES: funds.INCOME_TYPES,

  // core.js
  PAYMENT_METHODS: core.PAYMENT_METHODS,
  PostingError: core.PostingError,
  prisma: core.prisma,
  computeAccountBalance: core.computeAccountBalance,

  // periods.js
  openAccountingPeriod: periods.openAccountingPeriod,
  advancePeriodStatus: periods.advancePeriodStatus,
  getPeriodCalendar: periods.getPeriodCalendar,
  PERIOD_STATUS_PROGRESSION: periods.PERIOD_STATUS_PROGRESSION,

  // investments.js
  postInvestmentPurchase: investments.postInvestmentPurchase,
  postInvestmentSale: investments.postInvestmentSale,

  // risks.js
  postInsurancePolicy: risks.postInsurancePolicy,
  closeInsurancePolicy: risks.closeInsurancePolicy,

  // interpreter.js — Phase 1 of the Catalogue-driven posting engine.
  // Additive only: none of the 20 functions above have been migrated
  // onto this yet. See interpreter.js's own header comment for what it
  // currently does and does not support.
  executeCatalogueEvent: interpreter.executeCatalogueEvent,

  // replay.js — rebuild derived state from the transactional record.
  replayAccountBalances: replay.replayAccountBalances,
  replayResourceQuantities: replay.replayResourceQuantities,
  verifyResourceQuantities: replay.verifyResourceQuantities,
  computeIndirectCashFlow: replay.computeIndirectCashFlow,

  // processing.js — Processing / Repackaging.
  postRepackaging: processing.postRepackaging,

  // corrections.js — genuine correction entries, original never touched.
  postCorrection: corrections.postCorrection,
};
