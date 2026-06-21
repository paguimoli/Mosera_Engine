import type {
  ShadowAnalysisDomain,
  ShadowEvidenceKind,
} from "../shadow-analysis/shadow-analysis.types";

export type ShadowEvidenceLifecycleStatus =
  | "ACTIVE"
  | "EXCLUDED_FROM_PROMOTION"
  | "ARCHIVED"
  | "REVIEW_REQUIRED";

export type ShadowEvidenceLifecycleReasonCode =
  | "QA_INTENTIONAL"
  | "QA_FAILURE_TEST"
  | "LOAD_TEST"
  | "BACKFILL_TEST"
  | "OPERATOR_EXCLUDED"
  | "EXPIRED_TEST_EVIDENCE"
  | "UNEXPLAINED";

export type ShadowEvidenceLifecycleEvent = {
  id: string;
  domain: ShadowAnalysisDomain;
  evidenceType: ShadowEvidenceKind;
  evidenceId: string;
  previousStatus?: ShadowEvidenceLifecycleStatus | null;
  newStatus: ShadowEvidenceLifecycleStatus;
  reasonCode: ShadowEvidenceLifecycleReasonCode;
  reasonNote?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
  createdAt: string;
};

export type ShadowEvidenceLifecycleKey = `${ShadowAnalysisDomain}:${ShadowEvidenceKind}:${string}`;

export type ShadowEvidenceLifecycleSummary = {
  totalEvents: number;
  effectiveStatusCounts: Record<ShadowEvidenceLifecycleStatus, number>;
  reasonCounts: Record<ShadowEvidenceLifecycleReasonCode, number>;
  generatedAt: string;
};

export type ShadowEvidenceLifecycleExclusionResult = {
  createdEvents: number;
  skippedExisting: number;
  consideredEvidence: number;
  generatedAt: string;
};
