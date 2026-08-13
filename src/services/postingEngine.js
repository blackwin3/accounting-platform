/**
 * postingEngine.js — barrel re-export.
 *
 * This file used to contain the entire posting engine as one ~2400-line
 * file with 25 functions. It's now split by domain into ./posting/:
 *
 *   posting/core.js                — shared infrastructure every domain uses
 *   posting/basket.js              — postBasket (POS sell/buy), formerly till.js
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
const basket = require("./posting/basket");
const assets = require("./posting/assets");
const claims = require("./posting/claims");
const funds = require("./posting/funds");
const InsuranceAndProvisions = require("./posting/InsuranceAndProvisions");
const LeasesAndLessors = require("./posting/LeasesAndLessors");
const accounting_practice = require("./posting/accounting_practice");
const investments = require("./posting/investments");
const interpreter = require("./posting/interpreter");
const ProductionAndCosting = require("./posting/ProductionAndCosting");
const AgricultureAndLivestock = require("./posting/AgricultureAndLivestock");
const capitalManagement = require("./posting/capital_management");
const assetsManagement = require("./posting/assets_management");
const riskManagement = require("./posting/risk_management");

module.exports = {
  // basket.js (formerly till.js) — postBasket (POS sell/buy), an
  // orchestrator over many per-line Catalogue events.
  postBasket: basket.postBasket,

  // assets.js
  postAssetPurchase: assets.postAssetPurchase,
  postAssetDisposal: assets.postAssetDisposal,
  postDepreciationRun: assets.postDepreciationRun,
  postAssetImpairment: assets.postAssetImpairment,
  postAssetRevaluation: assets.postAssetRevaluation,

  // InsuranceAndProvisions.js — merged from risks.js and the Provisions
  // half of leasesAndProvisions.js.
  postInsurancePolicy: InsuranceAndProvisions.postInsurancePolicy,
  closeInsurancePolicy: InsuranceAndProvisions.closeInsurancePolicy,
  postInsuranceClaim: InsuranceAndProvisions.postInsuranceClaim,
  postProvision: InsuranceAndProvisions.postProvision,
  postProvisionUtilisation: InsuranceAndProvisions.postProvisionUtilisation,

  // LeasesAndLessors.js — merged from the Leases half of leasesAndProvisions.js
  // and the entirety of lessor.js.
  postLeaseCommencement: LeasesAndLessors.postLeaseCommencement,
  postLeasePayment: LeasesAndLessors.postLeasePayment,
  postLeaseTermination: LeasesAndLessors.postLeaseTermination,
  leaseOutInventory: LeasesAndLessors.leaseOutInventory,
  returnLeasedInventory: LeasesAndLessors.returnLeasedInventory,
  hireOutEquipment: LeasesAndLessors.hireOutEquipment,
  endEquipmentHire: LeasesAndLessors.endEquipmentHire,

  // claims.js
  postExpense: claims.postExpense,
  postReceivableSettlement: claims.postReceivableSettlement,
  postPayableSettlement: claims.postPayableSettlement,
  EXPENSE_CATEGORIES: claims.EXPENSE_CATEGORIES,

  // funds.js
  postFunding: funds.postFunding,
  postUnitIncome: funds.postUnitIncome,
  postFundTransfer: funds.postFundTransfer,
  postCapitalWithdrawal: funds.postCapitalWithdrawal,
  postLoanRepayment: funds.postLoanRepayment,
  postLoanClosure: funds.postLoanClosure,
  postRentArrears: funds.postRentArrears,
  postSettleRentArrears: funds.postSettleRentArrears,
  INCOME_TYPES: funds.INCOME_TYPES,

  // core.js
  PAYMENT_METHODS: core.PAYMENT_METHODS,
  PostingError: core.PostingError,
  prisma: core.prisma,
  computeAccountBalance: core.computeAccountBalance,

  // accounting_practice.js — merged from periods.js, corrections.js, and
  // replay.js: the three administrative domains of accounting practice.
  PERIOD_STATUS_PROGRESSION: accounting_practice.PERIOD_STATUS_PROGRESSION,
  openAccountingPeriod: accounting_practice.openAccountingPeriod,
  advancePeriodStatus: accounting_practice.advancePeriodStatus,
  getPeriodCalendar: accounting_practice.getPeriodCalendar,
  postCorrection: accounting_practice.postCorrection,
  replayAccountBalances: accounting_practice.replayAccountBalances,
  replayResourceQuantities: accounting_practice.replayResourceQuantities,
  verifyResourceQuantities: accounting_practice.verifyResourceQuantities,
  computeIndirectCashFlow: accounting_practice.computeIndirectCashFlow,
  getPeriodEndChecklist: accounting_practice.getPeriodEndChecklist,
  postSuccession: accounting_practice.postSuccession,

  // investments.js
  postInvestmentPurchase: investments.postInvestmentPurchase,
  postInvestmentSale: investments.postInvestmentSale,
  postInterestAccrual: investments.postInterestAccrual,
  postCouponReceipt: investments.postCouponReceipt,

  // interpreter.js — Catalogue-driven posting engine.
  executeCatalogueEvent: interpreter.executeCatalogueEvent,

  // ProductionAndCosting.js — merged from processing.js and serviceWip.js.
  postRepackaging: ProductionAndCosting.postRepackaging,
  startServiceEngagement: ProductionAndCosting.startServiceEngagement,
  logServiceHours: ProductionAndCosting.logServiceHours,
  billServiceEngagement: ProductionAndCosting.billServiceEngagement,
  hireTemporaryLabour: ProductionAndCosting.hireTemporaryLabour,
  logDaysWorked: ProductionAndCosting.logDaysWorked,
  payTemporaryLabour: ProductionAndCosting.payTemporaryLabour,

  // AgricultureAndLivestock.js — merged from livestock.js and rentalInvestments.js.
  registerAnimal: AgricultureAndLivestock.registerAnimal,
  bulkPlanting: AgricultureAndLivestock.bulkPlanting,
  recordMonthlyReview: AgricultureAndLivestock.recordMonthlyReview,
  recordAnimalLoss: AgricultureAndLivestock.recordAnimalLoss,
  recordBirth: AgricultureAndLivestock.recordBirth,
  recordHarvest: AgricultureAndLivestock.recordHarvest,
  postSeasonalLabour: AgricultureAndLivestock.postSeasonalLabour,
  postBiologicalAssetRevaluation: AgricultureAndLivestock.postBiologicalAssetRevaluation,
  postRentalPropertyPurchase: AgricultureAndLivestock.postRentalPropertyPurchase,
  assignTenant: AgricultureAndLivestock.assignTenant,

  // accounting_practice.js — includes succession
  postSuccession: accounting_practice.postSuccession,

  // capital_management.js — reporting layer over funds/investments/rentalInvestments.
  getCapitalPosition: capitalManagement.getCapitalPosition,

  // assets_management.js — reporting layer over assets.js.
  getAssetsSummary: assetsManagement.getAssetsSummary,
  getDisposalHistory: assetsManagement.getDisposalHistory,
  getDepreciationScheduleOverview: assetsManagement.getDepreciationScheduleOverview,

  // risk_management.js — reporting layer over InsuranceAndProvisions.js.
  getRiskPosition: riskManagement.getRiskPosition,
};
