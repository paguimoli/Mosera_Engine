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

export type LedgerImmutabilityReport = {
  status: EvidenceStatus;
  ledgerEntryCount: number;
  updateDetection: {
    status: EvidenceStatus;
    message: string;
    updatedAtColumnPresent: boolean;
  };
  deleteDetection: {
    status: EvidenceStatus;
    message: string;
    tombstoneOrAuditTablePresent: boolean;
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

export type OutboxHardeningReport = OutboxObservabilitySummary & {
  status: EvidenceStatus;
  recommendation: EvidenceStatus;
  warnings: string[];
  generatedAt: string;
};

export type QueueHardeningReport = QueueHealthSummary & {
  status: EvidenceStatus;
  recommendation: EvidenceStatus;
  warnings: string[];
};

export type WorkerHardeningReport = WorkerObservabilitySummary & {
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
  ledgerImmutability: LedgerImmutabilityReport;
  outboxHealth: OutboxHardeningReport;
  workerHealth: WorkerHardeningReport;
  queueHealth: QueueHardeningReport;
  operationsMetrics: OperationsMetricsSummary;
  blockers: string[];
  warnings: string[];
  generatedAt: string;
};
