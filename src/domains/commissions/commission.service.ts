import { findAccountById, listAccounts } from "../accounts/account.repository";
import type { PlayerAccount } from "../accounts/account.types";
import type { LedgerTransaction } from "../ledger/ledger.types";
import { findWeeklyAccountingPeriodById } from "../weekly-accounting/weekly-accounting.repository";
import {
  calculateCommissionAmount,
  generateCommissionRecordId,
  generateCommissionRunId,
  getAgentRollup,
  getMasterRollup,
  getSuperMasterRollup,
} from "./commission.helpers";
import {
  assignCommissionPlan,
  createCommissionPlan,
  createCommissionPlanRule,
  createWeeklyCommissionRecord,
  findActiveCommissionAssignment,
  findCommissionPlanByCode,
  findCommissionPlanById,
  findWeeklyCommissionRecord,
  listCommissionAssignments,
  listCommissionPlanRules,
  listCommissionPlans as listCommissionPlanRecords,
  listWeeklyCommissionRecords as listWeeklyCommissionRecordRows,
} from "./commission.repository";
import type {
  AccountCommissionAssignment,
  AssignCommissionPlanInput,
  CommissionAssignment,
  CommissionExecutionInput,
  CommissionPlan,
  CommissionPlanRule,
  CommissionRecord,
  CommissionRollup,
  CommissionRun,
  CreateCommissionPlanInput,
  CreateCommissionPlanRuleInput,
  PersistedCommissionPlan,
  WeeklyCommissionRecord,
} from "./commission.types";

export class CommissionBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionBusinessRuleError";
  }
}

function normalizeCommissionPlanCode(code: string) {
  return code.trim().toUpperCase();
}

function validateCreateCommissionPlanInput(input: CreateCommissionPlanInput) {
  const errors: string[] = [];

  if (!input.code?.trim()) {
    errors.push("Commission plan code is required.");
  }

  if (!input.name?.trim()) {
    errors.push("Commission plan name is required.");
  }

  if (!["NET_LOSS", "TURNOVER", "HYBRID"].includes(input.calculationBasis)) {
    errors.push("Commission calculation basis is invalid.");
  }

  if (input.status && !["ACTIVE", "DISABLED"].includes(input.status)) {
    errors.push("Commission plan status is invalid.");
  }

  if (errors.length > 0) {
    throw new CommissionBusinessRuleError(errors.join(" "));
  }
}

function validateCreateCommissionPlanRuleInput(
  input: CreateCommissionPlanRuleInput
) {
  const errors: string[] = [];

  if (!input.commissionPlanId) {
    errors.push("Commission plan id is required.");
  }

  if (
    !["NET_LOSS_PERCENT", "TURNOVER_PERCENT", "FLAT_AMOUNT"].includes(
      input.ruleType
    )
  ) {
    errors.push("Commission rule type is invalid.");
  }

  if (Number.isNaN(Number(input.rate)) || Number(input.rate) < 0) {
    errors.push("Commission rule rate must be zero or greater.");
  }

  if (
    input.appliesToAccountType &&
    !["MASTER_AGENT", "AGENT", "PLAYER"].includes(input.appliesToAccountType)
  ) {
    errors.push("Commission rule account type is invalid.");
  }

  if (errors.length > 0) {
    throw new CommissionBusinessRuleError(errors.join(" "));
  }
}

export async function createPersistedCommissionPlan(
  input: CreateCommissionPlanInput
): Promise<PersistedCommissionPlan> {
  const normalizedInput = {
    ...input,
    code: normalizeCommissionPlanCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? "ACTIVE",
  };

  validateCreateCommissionPlanInput(normalizedInput);

  const existingPlan = await findCommissionPlanByCode(normalizedInput.code);

  if (existingPlan) {
    throw new CommissionBusinessRuleError("Commission plan code already exists.");
  }

  return createCommissionPlan(normalizedInput);
}

export async function addCommissionPlanRule(
  input: CreateCommissionPlanRuleInput
): Promise<CommissionPlanRule> {
  validateCreateCommissionPlanRuleInput(input);

  const plan = await findCommissionPlanById(input.commissionPlanId);

  if (!plan) {
    throw new CommissionBusinessRuleError("Commission plan not found.");
  }

  return createCommissionPlanRule({
    ...input,
    rate: Number(input.rate),
    minAmount:
      input.minAmount === null || input.minAmount === undefined
        ? null
        : Number(input.minAmount),
    maxAmount:
      input.maxAmount === null || input.maxAmount === undefined
        ? null
        : Number(input.maxAmount),
  });
}

export async function assignCommissionPlanToAccount(
  input: AssignCommissionPlanInput
): Promise<AccountCommissionAssignment> {
  const account = await findAccountById(input.accountId);

  if (!account) {
    throw new CommissionBusinessRuleError("Account not found.");
  }

  if (account.accountType !== "MASTER_AGENT" && account.accountType !== "AGENT") {
    throw new CommissionBusinessRuleError(
      "Commission plans can only be assigned to master agent or agent accounts."
    );
  }

  if (account.operatingMode !== "COMMISSION") {
    throw new CommissionBusinessRuleError(
      "Account operating mode must be COMMISSION before assigning a commission plan."
    );
  }

  const plan = await findCommissionPlanById(input.commissionPlanId);

  if (!plan) {
    throw new CommissionBusinessRuleError("Commission plan not found.");
  }

  if (plan.status !== "ACTIVE") {
    throw new CommissionBusinessRuleError(
      "Only active commission plans can be assigned."
    );
  }

  const activeAssignment = await findActiveCommissionAssignment(input.accountId);

  if (activeAssignment) {
    if (activeAssignment.commissionPlanId === input.commissionPlanId) {
      return activeAssignment;
    }

    throw new CommissionBusinessRuleError(
      "Account already has an active commission assignment."
    );
  }

  return assignCommissionPlan({
    ...input,
    status: input.status ?? "ACTIVE",
    effectiveFrom: input.effectiveFrom ?? new Date().toISOString(),
    effectiveTo: input.effectiveTo ?? null,
  });
}

export async function listPersistedCommissionPlans(): Promise<
  PersistedCommissionPlan[]
> {
  return listCommissionPlanRecords();
}

export async function listRulesForCommissionPlan(
  commissionPlanId: string
): Promise<CommissionPlanRule[]> {
  return listCommissionPlanRules(commissionPlanId);
}

export async function getActiveCommissionAssignment(
  accountId: string
): Promise<AccountCommissionAssignment | null> {
  return findActiveCommissionAssignment(accountId);
}

export async function listAssignmentsForAccount(
  accountId: string
): Promise<AccountCommissionAssignment[]> {
  return listCommissionAssignments(accountId);
}

export async function generateWeeklyCommissionRecords(
  periodId: string,
  options: { allowOpenPeriod?: boolean } = {}
): Promise<WeeklyCommissionRecord[]> {
  const period = await findWeeklyAccountingPeriodById(periodId);

  if (!period) {
    throw new CommissionBusinessRuleError("Weekly accounting period not found.");
  }

  if (period.status !== "CLOSED" && !options.allowOpenPeriod) {
    throw new CommissionBusinessRuleError(
      "Weekly commission records can only be generated for closed periods."
    );
  }

  const accounts = await listAccounts();
  const records: WeeklyCommissionRecord[] = [];

  for (const account of accounts) {
    if (account.accountType !== "MASTER_AGENT" && account.accountType !== "AGENT") {
      continue;
    }

    const activeAssignment = await findActiveCommissionAssignment(account.id);

    if (!activeAssignment) {
      continue;
    }

    const plan = await findCommissionPlanById(activeAssignment.commissionPlanId);

    if (!plan) {
      continue;
    }

    const existingRecord = await findWeeklyCommissionRecord(
      periodId,
      account.id,
      plan.id
    );

    if (existingRecord) {
      records.push(existingRecord);
      continue;
    }

    records.push(
      await createWeeklyCommissionRecord({
        periodId,
        accountId: account.id,
        commissionPlanId: plan.id,
        calculationBasis: plan.calculationBasis,
        grossBasisAmount: 0,
        commissionAmount: 0,
        status: "DRAFT",
        metadata: {
          placeholder: true,
          source: "weekly_accounting_foundation",
        },
      })
    );
  }

  return records;
}

export async function listWeeklyCommissionRecords(
  periodId: string
): Promise<WeeklyCommissionRecord[]> {
  return listWeeklyCommissionRecordRows(periodId);
}

export function createCommissionPlanPayload(form: {
  name: string;
  model: CommissionPlan["model"];
  percentage?: string | number | null;
  flatAmount?: string | number | null;
  status: CommissionPlan["status"];
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
}): CommissionPlan {
  return {
    id: `COMMISSION-PLAN-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    name: form.name.trim(),
    model: form.model,
    percentage:
      form.percentage === "" ||
      form.percentage === undefined ||
      form.percentage === null
        ? null
        : Number(form.percentage),
    flatAmount:
      form.flatAmount === "" ||
      form.flatAmount === undefined ||
      form.flatAmount === null
        ? null
        : Number(form.flatAmount),
    status: form.status,
    effectiveFrom: form.effectiveFrom,
    effectiveTo: form.effectiveTo || null,
    notes: form.notes?.trim() || "",
    createdAt: new Date().toISOString(),
  };
}

export function createCommissionAssignmentPayload(form: {
  accountId: string;
  commissionPlanId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  active: boolean;
}): CommissionAssignment {
  return {
    id: `COMMISSION-ASSIGNMENT-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    accountId: form.accountId,
    commissionPlanId: form.commissionPlanId,
    effectiveFrom: form.effectiveFrom,
    effectiveTo: form.effectiveTo || null,
    active: form.active,
    createdAt: new Date().toISOString(),
  };
}

export function createCommissionRunPayload(
  input: CommissionExecutionInput
): CommissionRun {
  return {
    id: generateCommissionRunId(),
    accountingPeriodId: input.accountingPeriodId || null,
    marketId: input.marketId || null,
    status: "pending",
    startedAt: null,
    completedAt: null,
    accountCount: 0,
    totalWeeklyFigure: 0,
    totalCommission: 0,
    notes: input.notes?.trim() || "",
    createdAt: new Date().toISOString(),
  };
}

function getRollupForAccount({
  account,
  accounts,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  account: PlayerAccount;
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}): CommissionRollup {
  if (account.accountType === "super_master") {
    return getSuperMasterRollup({
      account,
      accounts,
      ledgerTransactions,
      periodStart,
      periodEnd,
    });
  }

  if (account.accountType === "master_agent") {
    return getMasterRollup({
      account,
      accounts,
      ledgerTransactions,
      periodStart,
      periodEnd,
    });
  }

  return getAgentRollup({
    account,
    accounts,
    ledgerTransactions,
    periodStart,
    periodEnd,
  });
}

export function calculateCommissionRollups({
  accounts,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}) {
  return accounts
    .filter((account) => account.accountType !== "player")
    .map((account) =>
      getRollupForAccount({
        account,
        accounts,
        ledgerTransactions,
        periodStart,
        periodEnd,
      })
    );
}

function isAssignmentEffective({
  assignment,
  periodEnd,
}: {
  assignment: CommissionAssignment;
  periodEnd?: string | null;
}) {
  if (!assignment.active) {
    return false;
  }

  if (!periodEnd) {
    return true;
  }

  const periodEndTime = new Date(periodEnd).getTime();
  const effectiveFromTime = new Date(assignment.effectiveFrom).getTime();
  const effectiveToTime = assignment.effectiveTo
    ? new Date(assignment.effectiveTo).getTime()
    : null;

  if (Number.isNaN(periodEndTime) || Number.isNaN(effectiveFromTime)) {
    return true;
  }

  if (effectiveFromTime > periodEndTime) {
    return false;
  }

  return effectiveToTime === null || effectiveToTime >= periodEndTime;
}

function findEffectiveAssignment({
  accountId,
  assignments,
  periodEnd,
}: {
  accountId: string;
  assignments: CommissionAssignment[];
  periodEnd?: string | null;
}) {
  return assignments.find(
    (assignment) =>
      assignment.accountId === accountId &&
      isAssignmentEffective({ assignment, periodEnd })
  );
}

export function executeCommissionRun({
  input,
  accounts,
  ledgerTransactions,
  commissionPlans,
  commissionAssignments,
}: {
  input: CommissionExecutionInput;
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  commissionPlans: CommissionPlan[];
  commissionAssignments: CommissionAssignment[];
}) {
  const startedAt = new Date().toISOString();
  const run = createCommissionRunPayload(input);
  const rollups = calculateCommissionRollups({
    accounts,
    ledgerTransactions,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  const records: CommissionRecord[] = [];

  for (const rollup of rollups) {
    const account = accounts.find(
      (createdAccount) => createdAccount.id === rollup.accountId
    );
    const assignment = findEffectiveAssignment({
      accountId: rollup.accountId,
      assignments: commissionAssignments,
      periodEnd: input.periodEnd,
    });
    const plan = assignment
      ? commissionPlans.find(
          (createdPlan) =>
            createdPlan.id === assignment.commissionPlanId &&
            createdPlan.status === "active"
        )
      : undefined;

    if (!plan || !account) {
      continue;
    }

    const commissionBase = rollup.totalWeeklyFigure;
    // TODO: confirm operator convention for whether commissions apply only to
    // positive house win or to the signed weekly figure.
    const commissionAmount = calculateCommissionAmount({
      plan,
      commissionBase,
    });

    records.push({
      id: generateCommissionRecordId({
        commissionRunId: run.id,
        accountId: rollup.accountId,
      }),
      commissionRunId: run.id,
      accountId: rollup.accountId,
      parentAccountId: account.parentId || null,
      commissionPlanId: plan.id,
      weeklyFigure: rollup.totalWeeklyFigure,
      commissionBase,
      commissionRate: plan.percentage ?? null,
      commissionAmount,
      status: "calculated",
      createdAt: startedAt,
    });
  }

  const completedAt = new Date().toISOString();
  const completedRun: CommissionRun = {
    ...run,
    status: "completed",
    startedAt,
    completedAt,
    accountCount: records.length,
    totalWeeklyFigure: records.reduce(
      (total, record) => total + record.weeklyFigure,
      0
    ),
    totalCommission: records.reduce(
      (total, record) => total + record.commissionAmount,
      0
    ),
  };

  return {
    run: completedRun,
    records,
    rollups,
    warnings: [
      "Tiered and hybrid commission models are placeholders until operator-specific rules are finalized.",
      "Commission payout ledger transactions are intentionally not created in this phase.",
      "Audit and integrity hooks are TODOs for a later commission hardening phase.",
    ],
  };
}
