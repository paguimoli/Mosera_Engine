import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  AccountCommissionAssignment,
  CommissionAssignment,
  CommissionAssignmentStatus,
  CommissionCalculationBasis,
  CommissionPlan,
  CommissionPlanRule,
  CommissionRuleType,
  CommissionRecord,
  CommissionRun,
  CreateCommissionPlanInput,
  CreateCommissionPlanRuleInput,
  CreateWeeklyCommissionRecordInput,
  PersistedCommissionPlan,
  PersistedCommissionPlanStatus,
  WeeklyCommissionRecord,
  WeeklyCommissionRecordStatus,
} from "./commission.types";

type CommissionPlanRow = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  calculation_basis: CommissionCalculationBasis;
  status: PersistedCommissionPlanStatus;
  created_at: string;
  updated_at?: string | null;
};

type CommissionPlanRuleRow = {
  id: string;
  commission_plan_id: string;
  rule_type: CommissionRuleType;
  rate: string | number;
  applies_to_account_type?: "MASTER_AGENT" | "AGENT" | "PLAYER" | null;
  min_amount?: string | number | null;
  max_amount?: string | number | null;
  created_at: string;
};

type AccountCommissionAssignmentRow = {
  id: string;
  account_id: string;
  commission_plan_id: string;
  status: CommissionAssignmentStatus;
  effective_from: string;
  effective_to?: string | null;
  created_at: string;
};

type WeeklyCommissionRecordRow = {
  id: string;
  period_id: string;
  account_id: string;
  commission_plan_id: string;
  calculation_basis: CommissionCalculationBasis;
  gross_basis_amount: string | number;
  commission_amount: string | number;
  status: WeeklyCommissionRecordStatus;
  created_at: string;
  approved_at?: string | null;
  paid_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

const COMMISSION_PLAN_SELECT =
  "id, code, name, description, calculation_basis, status, created_at, updated_at";
const COMMISSION_PLAN_RULE_SELECT =
  "id, commission_plan_id, rule_type, rate, applies_to_account_type, min_amount, max_amount, created_at";
const ACCOUNT_COMMISSION_ASSIGNMENT_SELECT =
  "id, account_id, commission_plan_id, status, effective_from, effective_to, created_at";
const WEEKLY_COMMISSION_RECORD_SELECT =
  "id, period_id, account_id, commission_plan_id, calculation_basis, gross_basis_amount, commission_amount, status, created_at, approved_at, paid_at, metadata";

export class CommissionRepositoryError extends Error {
  constructor(message = "Commission persistence operation failed.") {
    super(message);
    this.name = "CommissionRepositoryError";
  }
}

function mapPersistedCommissionPlanRow(
  row: CommissionPlanRow | null
): PersistedCommissionPlan | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    calculationBasis: row.calculation_basis,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

function mapCommissionPlanRuleRow(
  row: CommissionPlanRuleRow | null
): CommissionPlanRule | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    commissionPlanId: row.commission_plan_id,
    ruleType: row.rule_type,
    rate: Number(row.rate),
    appliesToAccountType: row.applies_to_account_type ?? null,
    minAmount:
      row.min_amount === null || row.min_amount === undefined
        ? null
        : Number(row.min_amount),
    maxAmount:
      row.max_amount === null || row.max_amount === undefined
        ? null
        : Number(row.max_amount),
    createdAt: row.created_at,
  };
}

function mapAccountCommissionAssignmentRow(
  row: AccountCommissionAssignmentRow | null
): AccountCommissionAssignment | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    accountId: row.account_id,
    commissionPlanId: row.commission_plan_id,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to ?? null,
    createdAt: row.created_at,
  };
}

function mapWeeklyCommissionRecordRow(
  row: WeeklyCommissionRecordRow | null
): WeeklyCommissionRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    periodId: row.period_id,
    accountId: row.account_id,
    commissionPlanId: row.commission_plan_id,
    calculationBasis: row.calculation_basis,
    grossBasisAmount: Number(row.gross_basis_amount),
    commissionAmount: Number(row.commission_amount),
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? null,
    paidAt: row.paid_at ?? null,
    metadata: row.metadata ?? {},
  };
}

export async function createCommissionPlan(
  input: CreateCommissionPlanInput
): Promise<PersistedCommissionPlan> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plans")
    .insert({
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      calculation_basis: input.calculationBasis,
      status: input.status ?? "ACTIVE",
    })
    .select(COMMISSION_PLAN_SELECT)
    .single();

  if (error) {
    throw new CommissionRepositoryError();
  }

  const plan = mapPersistedCommissionPlanRow(data as CommissionPlanRow | null);

  if (!plan) {
    throw new CommissionRepositoryError();
  }

  return plan;
}

export async function createCommissionPlanRule(
  input: CreateCommissionPlanRuleInput
): Promise<CommissionPlanRule> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plan_rules")
    .insert({
      commission_plan_id: input.commissionPlanId,
      rule_type: input.ruleType,
      rate: input.rate,
      applies_to_account_type: input.appliesToAccountType ?? null,
      min_amount: input.minAmount ?? null,
      max_amount: input.maxAmount ?? null,
    })
    .select(COMMISSION_PLAN_RULE_SELECT)
    .single();

  if (error) {
    throw new CommissionRepositoryError();
  }

  const rule = mapCommissionPlanRuleRow(data as CommissionPlanRuleRow | null);

  if (!rule) {
    throw new CommissionRepositoryError();
  }

  return rule;
}

async function findPersistedCommissionPlanById(
  id: string
): Promise<PersistedCommissionPlan | null> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plans")
    .select(COMMISSION_PLAN_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new CommissionRepositoryError();
  }

  return mapPersistedCommissionPlanRow(data as CommissionPlanRow | null);
}

export async function findCommissionPlanByCode(
  code: string
): Promise<PersistedCommissionPlan | null> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plans")
    .select(COMMISSION_PLAN_SELECT)
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();

  if (error) {
    throw new CommissionRepositoryError();
  }

  return mapPersistedCommissionPlanRow(data as CommissionPlanRow | null);
}

export async function listCommissionPlans(): Promise<PersistedCommissionPlan[]> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plans")
    .select(COMMISSION_PLAN_SELECT)
    .order("code", { ascending: true });

  if (error) {
    throw new CommissionRepositoryError();
  }

  return ((data ?? []) as CommissionPlanRow[])
    .map(mapPersistedCommissionPlanRow)
    .filter((plan): plan is PersistedCommissionPlan => Boolean(plan));
}

export async function disableCommissionPlan(
  id: string
): Promise<PersistedCommissionPlan> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plans")
    .update({ status: "DISABLED" })
    .eq("id", id)
    .select(COMMISSION_PLAN_SELECT)
    .single();

  if (error) {
    throw new CommissionRepositoryError();
  }

  const plan = mapPersistedCommissionPlanRow(data as CommissionPlanRow | null);

  if (!plan) {
    throw new CommissionRepositoryError();
  }

  return plan;
}

export async function listCommissionPlanRules(
  commissionPlanId: string
): Promise<CommissionPlanRule[]> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_plan_rules")
    .select(COMMISSION_PLAN_RULE_SELECT)
    .eq("commission_plan_id", commissionPlanId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new CommissionRepositoryError();
  }

  return ((data ?? []) as CommissionPlanRuleRow[])
    .map(mapCommissionPlanRuleRow)
    .filter((rule): rule is CommissionPlanRule => Boolean(rule));
}

export async function assignCommissionPlan(
  input: {
    accountId: string;
    commissionPlanId: string;
    status?: CommissionAssignmentStatus;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }
): Promise<AccountCommissionAssignment> {
  const { data, error } = await supabaseServerAdmin
    .from("account_commission_assignments")
    .insert({
      account_id: input.accountId,
      commission_plan_id: input.commissionPlanId,
      status: input.status ?? "ACTIVE",
      effective_from: input.effectiveFrom ?? new Date().toISOString(),
      effective_to: input.effectiveTo ?? null,
    })
    .select(ACCOUNT_COMMISSION_ASSIGNMENT_SELECT)
    .single();

  if (error) {
    throw new CommissionRepositoryError();
  }

  const assignment = mapAccountCommissionAssignmentRow(
    data as AccountCommissionAssignmentRow | null
  );

  if (!assignment) {
    throw new CommissionRepositoryError();
  }

  return assignment;
}

export async function findActiveCommissionAssignment(
  accountId: string
): Promise<AccountCommissionAssignment | null> {
  const { data, error } = await supabaseServerAdmin
    .from("account_commission_assignments")
    .select(ACCOUNT_COMMISSION_ASSIGNMENT_SELECT)
    .eq("account_id", accountId)
    .eq("status", "ACTIVE")
    .is("effective_to", null)
    .order("effective_from", { ascending: false })
    .limit(1);

  if (error) {
    throw new CommissionRepositoryError();
  }

  const [row] = (data ?? []) as AccountCommissionAssignmentRow[];

  return mapAccountCommissionAssignmentRow(row ?? null);
}

export async function listCommissionAssignments(
  accountId: string
): Promise<AccountCommissionAssignment[]> {
  const { data, error } = await supabaseServerAdmin
    .from("account_commission_assignments")
    .select(ACCOUNT_COMMISSION_ASSIGNMENT_SELECT)
    .eq("account_id", accountId)
    .order("effective_from", { ascending: false });

  if (error) {
    throw new CommissionRepositoryError();
  }

  return ((data ?? []) as AccountCommissionAssignmentRow[])
    .map(mapAccountCommissionAssignmentRow)
    .filter(
      (assignment): assignment is AccountCommissionAssignment =>
        Boolean(assignment)
    );
}

export async function createWeeklyCommissionRecord(
  input: CreateWeeklyCommissionRecordInput
): Promise<WeeklyCommissionRecord> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_commission_records")
    .insert({
      period_id: input.periodId,
      account_id: input.accountId,
      commission_plan_id: input.commissionPlanId,
      calculation_basis: input.calculationBasis,
      gross_basis_amount: input.grossBasisAmount ?? 0,
      commission_amount: input.commissionAmount ?? 0,
      status: input.status ?? "DRAFT",
      metadata: input.metadata ?? {},
    })
    .select(WEEKLY_COMMISSION_RECORD_SELECT)
    .single();

  if (error) {
    throw new CommissionRepositoryError();
  }

  const record = mapWeeklyCommissionRecordRow(
    data as WeeklyCommissionRecordRow | null
  );

  if (!record) {
    throw new CommissionRepositoryError();
  }

  return record;
}

export async function findWeeklyCommissionRecord(
  periodId: string,
  accountId: string,
  commissionPlanId: string
): Promise<WeeklyCommissionRecord | null> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_commission_records")
    .select(WEEKLY_COMMISSION_RECORD_SELECT)
    .eq("period_id", periodId)
    .eq("account_id", accountId)
    .eq("commission_plan_id", commissionPlanId)
    .maybeSingle();

  if (error) {
    throw new CommissionRepositoryError();
  }

  return mapWeeklyCommissionRecordRow(data as WeeklyCommissionRecordRow | null);
}

export async function listWeeklyCommissionRecords(
  periodId: string
): Promise<WeeklyCommissionRecord[]> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_commission_records")
    .select(WEEKLY_COMMISSION_RECORD_SELECT)
    .eq("period_id", periodId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new CommissionRepositoryError();
  }

  return ((data ?? []) as WeeklyCommissionRecordRow[])
    .map(mapWeeklyCommissionRecordRow)
    .filter((record): record is WeeklyCommissionRecord => Boolean(record));
}

export function saveCommissionPlan(
  plans: CommissionPlan[],
  plan: CommissionPlan
) {
  return [...plans, plan];
}

export function updateCommissionPlan(
  plans: CommissionPlan[],
  plan: CommissionPlan
) {
  return plans.map((createdPlan) =>
    createdPlan.id === plan.id ? plan : createdPlan
  );
}

export function deleteCommissionPlan(plans: CommissionPlan[], planId: string) {
  return plans.filter((plan) => plan.id !== planId);
}

export function saveCommissionAssignment(
  assignments: CommissionAssignment[],
  assignment: CommissionAssignment
) {
  return [...assignments, assignment];
}

export function updateCommissionAssignment(
  assignments: CommissionAssignment[],
  assignment: CommissionAssignment
) {
  return assignments.map((createdAssignment) =>
    createdAssignment.id === assignment.id ? assignment : createdAssignment
  );
}

export function saveCommissionRun(
  runs: CommissionRun[],
  run: CommissionRun
) {
  return [...runs, run];
}

export function updateCommissionRun(
  runs: CommissionRun[],
  run: CommissionRun
) {
  return runs.map((createdRun) =>
    createdRun.id === run.id ? run : createdRun
  );
}

export function saveCommissionRecords(
  records: CommissionRecord[],
  newRecords: CommissionRecord[]
) {
  return [...records, ...newRecords];
}

export function listCommissionRecordsByRunId(
  records: CommissionRecord[],
  commissionRunId: string
) {
  return records.filter((record) => record.commissionRunId === commissionRunId);
}

export function findCommissionPlanById(
  plans: CommissionPlan[],
  planId: string
): CommissionPlan | undefined;
export function findCommissionPlanById(
  id: string
): Promise<PersistedCommissionPlan | null>;
export function findCommissionPlanById(
  plansOrId: CommissionPlan[] | string,
  planId?: string
): CommissionPlan | undefined | Promise<PersistedCommissionPlan | null> {
  if (Array.isArray(plansOrId)) {
    return plansOrId.find((plan) => plan.id === planId);
  }

  return findPersistedCommissionPlanById(plansOrId);
}

export function findCommissionAssignmentByAccountId(
  assignments: CommissionAssignment[],
  accountId: string
) {
  return assignments.find(
    (assignment) => assignment.accountId === accountId && assignment.active
  );
}
