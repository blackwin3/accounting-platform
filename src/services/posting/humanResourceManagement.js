/**
 * humanResourceManagement.js — Human Resource Management posting module.
 *
 * Handles:
 *   1. Team management — roles, access levels, arrangement types
 *   2. Payroll — salary payments, commission, profit-share, owner drawings
 *   3. Workforce tracking — casual/seasonal workers, time-based billing
 *
 * This module treats people the same way assets.js treats fixed assets:
 * each person has a lifecycle (hired → active → promoted → retired/exited),
 * an arrangement (salary, commission, profit-share, family contribution),
 * and an ongoing cost structure that hits the P&L.
 *
 * The difference from the existing postSeasonalLabour in
 * AgricultureAndLivestock.js: that function handles ad-hoc daily workers
 * with no Management record. This module handles people who ARE in the
 * Management table — named team members with ongoing roles.
 */

const {
  prisma, PostingError, round2,
  mustFindOrCreateAccount, mustFindOrCreateCatalogue,
  findOrCreateExpensePlaceholder,
  runCatalogueEvent,
} = require("./core");

// ── SECTION 1: TEAM MANAGEMENT ───────────────────────────────────────

/**
 * addTeamMember — creates a Management row for a new team member
 * (employee, family helper, partner, cashier). Does NOT post a
 * journal entry — hiring someone is an operational event, not an
 * accounting event. The accounting happens when they get paid.
 */
async function addTeamMember(input) {
  const {
    stakeholderId, name, role, accessLevel = "CASHIER",
    arrangementType = "SALARY", arrangementRate = null,
    monthlyCost = null, businessUnit = "SHOP", entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!name || !name.trim()) throw new PostingError("Name is required.");
  if (!role) throw new PostingError("Role is required (e.g. Cashier, Manager, Salesperson, Driver).");

  const validArrangements = ["SALARY", "COMMISSION", "PROFIT_SHARE", "FAMILY_CONTRIBUTION", "OWNER_DRAWINGS", "VOLUNTEER"];
  if (!validArrangements.includes(arrangementType)) {
    throw new PostingError(`Arrangement type must be one of: ${validArrangements.join(", ")}`);
  }

  const validAccess = ["OWNER_FULL", "MANAGER", "CASHIER", "VIEWER", "ACCOUNTANT", "ADVISOR"];
  if (!validAccess.includes(accessLevel)) {
    throw new PostingError(`Access level must be one of: ${validAccess.join(", ")}`);
  }

  // Check for duplicate
  const existing = await prisma.Management.findFirst({
    where: { Management_Name: name.trim(), Entreprise_id: entrepriseId, Lifecycle_Status: { not: "EXITED" } },
  });
  if (existing) {
    throw new PostingError(`A team member named "${name.trim()}" already exists (Admin #${existing.Administration_id}).`);
  }

  // Need a catalogue row to satisfy the NOT NULL FK
  const catalogue = await prisma.Catalogue.findFirst({ where: { Entreprise_id: entrepriseId } });
  if (!catalogue) throw new PostingError("No Catalogue found — run the setup wizard first.");

  const member = await prisma.Management.create({
    data: {
      Catalogue_id: catalogue.Catalogue_id,
      Stakeholder_id: stakeholderId ? Number(stakeholderId) : null,
      Management_Name: name.trim(),
      Management_Role: role,
      Access_Level: accessLevel,
      Arrangement_Type: arrangementType,
      Arrangement_Rate: arrangementRate != null ? Number(arrangementRate) : null,
      Management_Cost: monthlyCost != null ? Number(monthlyCost) : null,
      Administration_type: role === "Owner" ? "Owner" : "Worker",
      Inheritance_Status: role === "Owner" ? "CURRENT_OWNER" : null,
      Lifecycle_Status: "ACTIVE",
      Business_Unit: businessUnit,
      Entreprise_id: entrepriseId,
    },
  });

  return { member, adminId: member.Administration_id };
}

/**
 * updateTeamRole — changes a team member's role, access level, or
 * arrangement type. Creates an Account_History record for audit trail.
 */
async function updateTeamRole(input) {
  const { adminId, newRole, newAccessLevel, newArrangementType, newRate, reason, entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!adminId) throw new PostingError("adminId is required.");

  const member = await prisma.Management.findUnique({ where: { Administration_id: Number(adminId) } });
  if (!member || member.Entreprise_id !== entrepriseId) throw new PostingError("Team member not found.");

  const updates = {};
  const changes = [];

  if (newRole && newRole !== member.Management_Role) {
    changes.push(`Role: ${member.Management_Role} → ${newRole}`);
    updates.Management_Role = newRole;
  }
  if (newAccessLevel && newAccessLevel !== member.Access_Level) {
    changes.push(`Access: ${member.Access_Level} → ${newAccessLevel}`);
    updates.Access_Level = newAccessLevel;
  }
  if (newArrangementType && newArrangementType !== member.Arrangement_Type) {
    changes.push(`Arrangement: ${member.Arrangement_Type} → ${newArrangementType}`);
    updates.Arrangement_Type = newArrangementType;
  }
  if (newRate != null) {
    changes.push(`Rate: ${member.Arrangement_Rate || 0}% → ${newRate}%`);
    updates.Arrangement_Rate = Number(newRate);
  }

  if (changes.length === 0) throw new PostingError("No changes specified.");

  const updated = await prisma.Management.update({
    where: { Administration_id: member.Administration_id },
    data: updates,
  });

  // Audit trail via Knowledge entry
  await prisma.Knowledge.create({
    data: {
      Knowledge_type: "DECISION_REASON",
      Explanation: `Role change for ${member.Management_Name}: ${changes.join("; ")}. Reason: ${reason || "not stated"}.`,
      Context: "MANAGEMENT",
      Confidence_Level: 4,
      Language: "en",
      Entry_date: new Date(),
      Entreprise_id: entrepriseId,
    },
  });

  return { member: updated, changes };
}

/**
 * exitTeamMember — marks a team member as exited (resigned, terminated,
 * or deceased). Revokes their access level to VIEWER. Does not delete
 * the record — the audit trail must survive.
 */
async function exitTeamMember(input) {
  const { adminId, exitReason = "RESIGNED", notes = "", entrepriseId } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");

  const member = await prisma.Management.findUnique({ where: { Administration_id: Number(adminId) } });
  if (!member || member.Entreprise_id !== entrepriseId) throw new PostingError("Team member not found.");
  if (member.Lifecycle_Status === "EXITED") throw new PostingError("This person has already exited.");
  if (member.Access_Level === "OWNER_FULL") {
    throw new PostingError("Cannot exit the Owner — use the Succession transfer instead.");
  }

  const updated = await prisma.Management.update({
    where: { Administration_id: member.Administration_id },
    data: {
      Lifecycle_Status: "EXITED",
      Access_Level: "VIEWER",
      Succession_Notes: notes || `Exited: ${exitReason}`,
    },
  });

  return { member: updated, exitReason };
}

// ── SECTION 2: PAYROLL ───────────────────────────────────────────────

/**
 * postSalaryPayment — pay a named team member their salary or wage.
 * DR Salaries Expense (5200) CR Cash/Mobile/Bank.
 *
 * This is different from postSeasonalLabour:
 * - Seasonal labour = anonymous day workers, no Management record
 * - Salary payment = named team members in the Management table
 *
 * For commission and profit-share arrangements, the amount is
 * calculated from the Arrangement_Rate if not specified explicitly.
 */
async function postSalaryPayment(input) {
  const {
    adminId, amount = null, period = "",
    paymentMethod = "MOBILE", notes = "",
    businessUnit = "SHOP", entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!adminId) throw new PostingError("adminId is required — which team member to pay.");

  return prisma.$transaction(async (tx) => {
    const member = await tx.Management.findUnique({ where: { Administration_id: Number(adminId) } });
    if (!member || member.Entreprise_id !== entrepriseId) throw new PostingError("Team member not found.");
    if (member.Lifecycle_Status === "EXITED") throw new PostingError("Cannot pay an exited team member.");

    // Determine the amount based on arrangement type
    let payAmount = amount ? round2(Number(amount)) : null;

    if (!payAmount && member.Management_Cost) {
      payAmount = round2(Number(member.Management_Cost));
    }
    if (!payAmount) {
      throw new PostingError("Amount is required — either specify it directly or set a monthly cost on the team member's record.");
    }
    if (payAmount <= 0) throw new PostingError("Amount must be positive.");

    // Choose the right event and account based on arrangement type
    let eventName = "PAY_SALARY";
    let accountCode = "5200";
    let accountName = "Salaries Expense";

    if (member.Arrangement_Type === "COMMISSION") {
      eventName = "PAY_COMMISSION";
      accountCode = "5220";
      accountName = "Commission Expense";
    } else if (member.Arrangement_Type === "OWNER_DRAWINGS") {
      eventName = "CAPITAL_WITHDRAWAL";
      accountCode = "3100";
      accountName = "Owner Capital";
    }

    await mustFindOrCreateAccount(tx, accountCode, accountName,
      accountCode.startsWith("3") ? "EQUITY" : "EXPENDITURE",
      accountCode.startsWith("3") ? "CREDIT" : "DEBIT",
      accountCode.startsWith("3") ? "EQUITY" : "OPERATING_EXPENSE",
      entrepriseId
    );

    await mustFindOrCreateCatalogue(tx, {
      eventName,
      description: `Pay ${member.Arrangement_Type || "SALARY"} to ${member.Management_Name}. DR ${accountName} (${accountCode}) CR Cash/Mobile/Bank.`,
      debitCode: accountCode, creditCode: "1000",
      cashFlowCategory: "OPERATING", riskLevel: "LOW", cycleType: "PAYROLL",
      alertRequired: 0,
      narrativeTemplate: `${member.Arrangement_Type || "Salary"} payment to {Employee_Name}: KES {Amount} for {Period}.`,
      reportSections: `INCOME_STATEMENT:${accountName.replace(/\s/g, "")}|CASH_FLOW:Operating`,
      businessUnit, entrepriseId,
    });

    const product = await findOrCreateExpensePlaceholder(tx, accountName, entrepriseId);

    const result = await runCatalogueEvent(tx, {
      eventName,
      amount: payAmount,
      productId: product.Product_id,
      businessUnit,
      administrationId: member.Administration_id,
      paymentMethod,
      paymentDirection: "pay",
      paymentSide: "credit",
      narrativeValues: { Employee_Name: member.Management_Name, Period: period },
      entrepriseId,
    });

    // Create an Expenditure snapshot
    const catalogue = await tx.Catalogue.findFirst({ where: { Event_Name: eventName, Entreprise_id: entrepriseId } });
    const account = await tx.Account.findFirst({ where: { Account_Name: accountName, Entreprise_id: entrepriseId } });
    if (catalogue && account) {
      await tx.Expenditure.create({
        data: {
          Catalogue_id: catalogue.Catalogue_id,
          Account_id: account.Account_id,
          Records_id: result.recordsId,
          Transactions_id: result.transaction.Transactions_id,
          Expenditure_type: member.Arrangement_Type || "SALARY",
          Expenditure_Category: "SALARIES",
          Net_Amount: payAmount,
          Expenditure_Paid: payAmount,
          Expenditure_Outstanding: 0,
          Business_Unit: businessUnit,
          Period: new Date(),
          Entreprise_id: entrepriseId,
        },
      });
    }

    return {
      transaction: result.transaction,
      journal: result.journal,
      paidTo: member.Management_Name,
      arrangement: member.Arrangement_Type,
      amount: payAmount,
    };
  });
}

/**
 * postCommissionPayment — calculate and pay commission based on the
 * team member's Arrangement_Rate applied to a specified revenue base.
 * Example: a salesperson with 5% commission on KES 100,000 monthly sales
 * earns KES 5,000.
 */
async function postCommissionPayment(input) {
  const {
    adminId, revenueBase, period = "",
    paymentMethod = "MOBILE", notes = "",
    businessUnit = "SHOP", entrepriseId,
  } = input;

  if (!entrepriseId) throw new PostingError("entrepriseId is required.");
  if (!adminId) throw new PostingError("adminId is required.");
  if (!revenueBase || Number(revenueBase) <= 0) throw new PostingError("revenueBase must be positive — the revenue amount to calculate commission on.");

  const member = await prisma.Management.findUnique({ where: { Administration_id: Number(adminId) } });
  if (!member || member.Entreprise_id !== entrepriseId) throw new PostingError("Team member not found.");
  if (!member.Arrangement_Rate) throw new PostingError(`${member.Management_Name} has no Arrangement_Rate set — update their record with a commission percentage first.`);

  const commission = round2(Number(revenueBase) * Number(member.Arrangement_Rate) / 100);

  return postSalaryPayment({
    adminId, amount: commission, period,
    paymentMethod, notes: notes || `Commission: ${member.Arrangement_Rate}% on KES ${revenueBase}`,
    businessUnit, entrepriseId,
  });
}

/**
 * getTeamSummary — read-only summary of all team members, their roles,
 * arrangements, costs, and status. Used by the Management page.
 */
async function getTeamSummary(entrepriseId) {
  if (!entrepriseId) throw new PostingError("entrepriseId is required.");

  const members = await prisma.Management.findMany({
    where: { Entreprise_id: entrepriseId },
    orderBy: [{ Lifecycle_Status: "asc" }, { Management_Role: "asc" }],
  });

  // Calculate total payroll cost
  const activeMembers = members.filter(m => m.Lifecycle_Status !== "EXITED");
  const monthlyPayroll = round2(activeMembers.reduce((sum, m) => sum + Number(m.Management_Cost || 0), 0));

  // Count by role
  const byRole = {};
  activeMembers.forEach(m => {
    const role = m.Management_Role || "Unknown";
    byRole[role] = (byRole[role] || 0) + 1;
  });

  // Count by arrangement type
  const byArrangement = {};
  activeMembers.forEach(m => {
    const arr = m.Arrangement_Type || "UNSPECIFIED";
    byArrangement[arr] = (byArrangement[arr] || 0) + 1;
  });

  return {
    totalMembers: members.length,
    activeMembers: activeMembers.length,
    exitedMembers: members.length - activeMembers.length,
    monthlyPayroll,
    annualPayrollEstimate: round2(monthlyPayroll * 12),
    byRole,
    byArrangement,
    members: members.map(m => ({
      adminId: m.Administration_id,
      name: m.Management_Name,
      role: m.Management_Role,
      accessLevel: m.Access_Level,
      arrangementType: m.Arrangement_Type,
      arrangementRate: m.Arrangement_Rate ? Number(m.Arrangement_Rate) : null,
      monthlyCost: m.Management_Cost ? Number(m.Management_Cost) : null,
      status: m.Lifecycle_Status || "ACTIVE",
      inheritanceStatus: m.Inheritance_Status,
      businessUnit: m.Business_Unit,
    })),
  };
}

module.exports = {
  addTeamMember,
  updateTeamRole,
  exitTeamMember,
  postSalaryPayment,
  postCommissionPayment,
  getTeamSummary,
};
