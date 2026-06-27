import type { AuthorityBaselineStatus } from "../authority-baseline/authority-baseline.types";
import type { QueueHealthSummary } from "../operations/queue-health.types";
import type {
  OperationsMetricsSummary,
  OutboxObservabilitySummary,
  WorkerObservabilitySummary,
} from "../operations/worker-observability.types";

export type EvidenceStatus = "READY" | "WARNING" | "ACTION_REQUIRED";

export type LedgerReferenceAuditIssue = {
  kind:
    | "MISSING_LEDGER_POSTING"
    | "MISSING_SETTLEMENT_REFERENCE"
    | "ORPHAN_LEDGER_RECORD"
    | "ORPHAN_SETTLEMENT_REFERENCE";
  severity: EvidenceStatus;
  settlementApplicationId?: string | null;
  settlementId?: string | null;
  reservationId?: string | null;
  ticketId?: string | null;
  ledgerEntryId?: string | null;
  correlationId?: string | null;
  message: string;
};

export type LedgerReferenceAuditSummary = {
  status: EvidenceStatus;
  sampledCreditBackedSettlements: number;
  matchedLedgerPostings: number;
  directReferenceMatches: number;
  inferredReferenceMatches: number;
  missingLedgerPostingCount: number;
  orphanLedgerRecordCount: number;
  orphanSettlementReferenceCount: number;
  issues: LedgerReferenceAuditIssue[];
  generatedAt: string;
};

export type LedgerReferenceRemediationItem = {
  issueKind: LedgerReferenceAuditIssue["kind"];
  settlementApplicationId?: string | null;
  settlementId?: string | null;
  reservationId?: string | null;
  ticketId?: string | null;
  ledgerEntryId?: string | null;
  correlationId?: string | null;
  probableLedgerEntryId: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  recommendedRemediation: string;
  mutationAllowed: false;
};

export type LedgerReferenceRemediationReport = {
  status: EvidenceStatus;
  reportId: string;
  appendOnly: true;
  persistence: {
    mode: "GENERATED_REPORT";
    persisted: false;
    reason: string;
  };
  itemCount: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  unknownConfidenceCount: number;
  items: LedgerReferenceRemediationItem[];
  generatedAt: string;
};

export type LedgerImmutabilityReport = {
  status: EvidenceStatus;
  ledgerEntryCount: number;
  enforcementMode: "DATABASE_ENFORCED" | "APPLICATION_ENFORCED" | "UNKNOWN";
  appendOnlyEnforcement: {
    status: EvidenceStatus;
    databaseProtected: boolean;
    applicationProtected: boolean;
    message: string;
  };
  updateDetection: {
    status: EvidenceStatus;
    message: string;
    updatedAtColumnPresent: boolean;
    protectedByDatabase: boolean;
  };
  deleteDetection: {
    status: EvidenceStatus;
    message: string;
    tombstoneOrAuditTablePresent: boolean;
    protectedByDatabase: boolean;
  };
  reversalIntegrity: {
    status: EvidenceStatus;
    reversalEntryCount: number;
    missingOriginalCount: number;
    missingOriginalLedgerEntryIds: string[];
  };
  adjustmentChains: {
    status: EvidenceStatus;
    adjustmentEntryCount: number;
    brokenChainCount: number;
    brokenLedgerEntryIds: string[];
  };
  databaseTriggers: {
    status: EvidenceStatus;
    detected: boolean;
    unavailable: boolean;
    triggers: string[];
    message: string;
  };
  warnings: string[];
  generatedAt: string;
};

export type LedgerImmutabilityVerificationReport = LedgerImmutabilityReport & {
  verificationScope: "EVIDENCE_ONLY";
  destructiveProbeAttempted: false;
  destructiveTriggerCreated: false;
  guarantees: {
    updateImpossibleOrProtected: boolean;
    deleteImpossibleOrProtected: boolean;
    appendOnlyEnforced: boolean;
    reversalChainIntact: boolean;
    adjustmentChainIntact: boolean;
  };
};

export type OutboxHardeningReport = OutboxObservabilitySummary & {
  oldestPendingEvents: Array<{
    id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    status: string;
    attempt_count: number;
    next_attempt_at: string | null;
    correlation_id: string | null;
    created_at: string;
    published_at: string | null;
  }>;
  retryCandidates: Array<{
    id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    status: string;
    attempt_count: number;
    next_attempt_at: string | null;
    correlation_id: string | null;
    created_at: string;
    published_at: string | null;
  }>;
  status: EvidenceStatus;
  recommendation: EvidenceStatus;
  warnings: string[];
  generatedAt: string;
};

export type QueueHardeningReport = QueueHealthSummary & {
  evidenceState: "HEALTHY" | "UNKNOWN" | "UNHEALTHY";
  status: EvidenceStatus;
  recommendation: EvidenceStatus;
  warnings: string[];
};

export type WorkerHardeningReport = WorkerObservabilitySummary & {
  evidenceState: "HEALTHY" | "IDLE" | "UNKNOWN" | "UNHEALTHY";
  status: EvidenceStatus;
  recommendation: EvidenceStatus;
  heartbeatStaleSeconds: number;
  warnings: string[];
};

export type PlatformEvidenceReport = {
  status: EvidenceStatus;
  authorityBaseline: AuthorityBaselineStatus;
  financialInvariants: AuthorityBaselineStatus["financialInvariants"];
  ledgerReferenceAudit: LedgerReferenceAuditSummary;
  ledgerReferenceRemediation: LedgerReferenceRemediationReport;
  ledgerImmutability: LedgerImmutabilityReport;
  outboxHealth: OutboxHardeningReport;
  workerHealth: WorkerHardeningReport;
  queueHealth: QueueHardeningReport;
  operationsMetrics: OperationsMetricsSummary;
  blockers: string[];
  warnings: string[];
  generatedAt: string;
};
