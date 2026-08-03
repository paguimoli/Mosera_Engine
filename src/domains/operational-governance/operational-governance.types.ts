import type { AuthContext } from "../auth/auth-context.types";

export type OperationalApprovalCategory =
  | "NO_APPROVAL"
  | "SINGLE_APPROVAL"
  | "DUAL_APPROVAL"
  | "SYSTEM_APPROVAL";

export type OperationalCommandType =
  | "AUTHORITY_APPROVAL_CAPTURE"
  | "AUTHORITY_CERTIFICATION_CAPTURE"
  | "AUTHORITY_PROMOTION_EXECUTION"
  | "PLATFORM_LIFECYCLE"
  | "BREAK_GLASS_LIFECYCLE"
  | "SESSION_REVOCATION"
  | "LEDGER_REMEDIATION_APPROVAL_CAPTURE"
  | "GAME_ENGINE_PRODUCTION_ACTIVATION"
  | "MANUAL_CERTIFIED_SUBMISSION"
  | "OUTCOME_RECOVERY_EXECUTION"
  | "CONFIGURATION_PUBLICATION"
  | "PRODUCT_PUBLICATION"
  | "PROVIDER_ACTIVATION"
  | "PROVIDER_DEACTIVATION"
  | "DRAW_SCHEDULE_PUBLICATION"
  | "PLATFORM_MAINTENANCE"
  | "RECOVERY_EXECUTION"
  | "PRODUCTION_RELEASE";

export type OperationalCommandRequest<TPayload extends Record<string, unknown>> = {
  authContext: AuthContext;
  privilegedSessionId?: string | null;
  commandType: OperationalCommandType;
  affectedAuthority: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  causationId?: string | null;
  idempotencyKey: string;
  payload: TPayload;
};

export type OperationalCommandRecord = {
  commandId: string;
  commandType: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  correlationId: string;
  causationId: string | null;
  policyId: string;
  policyVersion: number;
};

export type GovernedOperationResult<TResult> = {
  command: OperationalCommandRecord;
  result: TResult;
  idempotent: boolean;
};
