/**
 * nav/index.js — barrel that mounts every nav route sub-module.
 *
 * This used to be one 1700-line nav.js file with 41 routes. It's now
 * split by domain, matching the app's own sidebar structure:
 *
 *   operations.js    — switch-unit, dashboard, products, journal, ledger,
 *                       transactions, accounts
 *   reports.js        — reports + the 4 report-generation endpoints
 *   assets.js         — the asset register page
 *   claims.js         — expense, claims, payables, liability,
 *                       leases-provisions, risks-insurance
 *   money.js          — money, cash-flow, funds, investments
 *   resources.js      — resources, inventory, services, utility
 *   settings.js        — settings, alerts, profile, rules, all
 *                       settings/* POST endpoints
 *   organisation.js   — business, stakeholders, management
 *   knowledge.js      — knowledge, narrative
 *
 * Every sub-module exports a plain express.Router() with its own routes
 * registered at the top level (not nested under a prefix) — this file
 * just mounts each one at "/" in turn, so the resulting route table is
 * identical to what the single nav.js file used to provide. Nothing
 * outside this folder needed to change: index.js mounts this barrel
 * exactly where it used to mount nav.js.
 */

const express = require("express");
const router = express.Router();

router.use(require("./operations"));
router.use(require("./reports"));
router.use(require("./assets"));
router.use(require("./claims"));
router.use(require("./money"));
router.use(require("./resources"));
router.use(require("./settings"));
router.use(require("./organisation"));
router.use(require("./government"));
router.use(require("./knowledge"));
router.use(require("./documents"));
router.use(require("./interest-rates"));

module.exports = router;
