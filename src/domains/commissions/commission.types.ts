export type CommissionModel =
  | "revenue_share"
  | "weekly_figure_percentage"
  | "tiered_percentage"
  | "flat_weekly_fee"
  | "hybrid";

export type CommissionPlanStatus = "active" | "inactive" | "archived";

export type CommissionPlan = {
  id: string;
  name: string;
  model: CommissionModel;
  percentage?: number | null;
  flatAmount?: number | null;
  status: CommissionPlanStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  createdAt: string;
};

export type CommissionAssignment = {
  id: string;
  accountId: string;
  commissionPlanId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  active: boolean;
  createdAt: string;
};

export type CommissionRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type CommissionRun = {
  id: string;
  accountingPeriodId?: string | null;
  marketId?: string | null;
  status: CommissionRunStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  accountCount: number;
  totalWeeklyFigure: number;
  totalCommission: number;
  notes?: string;
  createdAt: string;
};

export type CommissionRecord = {
  id: string;
  commissionRunId: string;
  accountId: string;
  parentAccountId?: string | null;
  commissionPlanId?: string | null;
  weeklyFigure: number;
  commissionBase: number;
  commissionRate?: number | null;
  commissionAmount: number;
  status: "calculated" | "void" | "adjusted";
  createdAt: string;
};

export type CommissionRollup = {
  accountId: string;
  directWeeklyFigure: number;
  downlineWeeklyFigure: number;
  totalWeeklyFigure: number;
  pendingExposure: number;
};

export type CommissionExecutionInput = {
  accountingPeriodId?: string | null;
  marketId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  notes?: string;
};

export type CommissionCalculationBasis = "NET_LOSS" | "TURNOVER" | "HYBRID";

export type CommissionType = "LOSS_BASED_PERCENTAGE";

export type PersistedCommissionPlanStatus = "ACTIVE" | "DISABLED";

export type CommissionRuleType =
  | "NET_LOSS_PERCENT"
  | "TURNOVER_PERCENT"
  | "FLAT_AMOUNT";

export type CommissionAssignmentStatus = "ACTIVE" | "INACTIVE";

export type WeeklyCommissionRecordStatus =
  | "DRAFT"
  | "APPROVED"
  | "PAID"
  | "VOID";

export type PersistedCommissionPlan = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  calculationBasis: CommissionCalculationBasis;
  status: PersistedCommissionPlanStatus;
  createdAt: string;
  updatedAt?: string | null;
};

export type CommissionPlanRule = {
  id: string;
  commissionPlanId: string;
  ruleType: CommissionRuleType;
  rate: number;
  appliesToAccountType?: "MASTER_AGENT" | "AGENT" | "PLAYER" | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  createdAt: string;
};

export type AccountCommissionAssignment = {
  id: string;
  accountId: string;
  commissionPlanId: string;
  status: CommissionAssignmentStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  createdAt: string;
};

export type WeeklyCommissionRecord = {
  id: string;
  periodId: string;
  accountId: string;
  commissionPlanId: string;
  calculationBasis: CommissionCalculationBasis;
  grossBasisAmount: number;
  commissionAmount: number;
  status: WeeklyCommissionRecordStatus;
  createdAt: string;
  approvedAt?: string | null;
  paidAt?: string | null;
  metadata: Record<string, unknown>;
};

export type CreateCommissionPlanInput = {
  code: string;
  name: string;
  description?: string | null;
  calculationBasis: CommissionCalculationBasis;
  status?: PersistedCommissionPlanStatus;
};

export type CreateCommissionPlanRuleInput = {
  commissionPlanId: string;
  ruleType: CommissionRuleType;
  rate: number;
  appliesToAccountType?: "MASTER_AGENT" | "AGENT" | "PLAYER" | null;
  minAmount?: number | null;
  maxAmount?: number | null;
};

export type AssignCommissionPlanInput = {
  accountId: string;
  commissionPlanId: string;
  status?: CommissionAssignmentStatus;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

export type CreateWeeklyCommissionRecordInput = {
  periodId: string;
  accountId: string;
  commissionPlanId: string;
  calculationBasis: CommissionCalculationBasis;
  grossBasisAmount?: number;
  commissionAmount?: number;
  status?: WeeklyCommissionRecordStatus;
  metadata?: Record<string, unknown>;
};

export type CommissionAccountingRunStatus =
  | "STARTED"
  | "COMPLETED"
  | "FAILED"
  | "REVERSED";

export type CommissionAccountingRun = {
  id: string;
  weekStart: string;
  weekEnd: string;
  currency: string;
  status: CommissionAccountingRunStatus;
  correlationId?: string | null;
  createdAt: string;
  completedAt?: string | null;
  detailCount: number;
  totalCommission: number;
};

export type CommissionRunDetail = {
  id: string;
  runId: string;
  accountId: string;
  snapshotId: string;
  netResult: number;
  commissionPercentageBasisPoints: number;
  commissionAmount: number;
  createdAt: string;
};

export type CommissionAdjustment = {
  id: string;
  accountId: string;
  runId: string;
  adjustmentAmount: number;
  reasonCode: string;
  notes?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
  createdAt: string;
};

export type GenerateCommissionRunInput = {
  weekStart: string;
  weekEnd: string;
  currency: string;
  correlationId?: string | null;
};

export type CreateCommissionAdjustmentInput = {
  accountId: string;
  runId: string;
  adjustmentAmount: number;
  reasonCode: string;
  notes?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
};
