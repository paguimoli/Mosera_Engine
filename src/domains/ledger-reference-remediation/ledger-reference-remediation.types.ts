import type { AuthorityApprovalRecord } from "../authority-approval/authority-approval.types";
import type { EvidenceStatus } from "../platform-evidence/platform-evidence.types";

export type LedgerReferenceRemediationStatus =
  | "NEW"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "COMPLETED"
  | "EXPIRED";

export type LedgerReferenceRemediationConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export type LedgerReferenceRemediationDecision =
  | "START_REVIEW"
  | "APPROVE"
  | "REJECT"
  | "COMPLETE";

export type LedgerReferenceRemediationCandidate = {
  remediationId: string;
  sourceDomain: "LEDGER_REFERENCE";
  sourceEntityId: string;
  affectedEntities: Array<{
    entityType:
      | "CREDIT_SETTLEMENT_APPLICATION"
      | "SETTLEMENT"
      | "CREDIT_RESERVATION"
      | "TICKET"
      | "LEDGER_ENTRY"
      | "CORRELATION";
    entityId: string;
  }>;
  probableTarget: {
    entityType: "LEDGER_ENTRY" | "UNKNOWN";
    entityId: string | null;
  };
  confidenceScore: number;
  confidence: LedgerReferenceRemediationConfidence;
  discoveryReason: string;
  discoveredAt: string;
  status: LedgerReferenceRemediationStatus;
  latestApproval: AuthorityApprovalRecord | null;
  mutationAllowed: false;
};

export type LedgerReferenceRemediationQueueFilters = {
  status?: LedgerReferenceRemediationStatus;
  confidence?: LedgerReferenceRemediationConfidence;
  search?: string;
};

export type LedgerReferenceRemediationQueue = {
  status: EvidenceStatus;
  appendOnly: true;
  mutationAllowed: false;
  candidates: LedgerReferenceRemediationCandidate[];
  totalCount: number;
  filters: LedgerReferenceRemediationQueueFilters;
  generatedAt: string;
};

export type LedgerReferenceRemediationSummary = {
  status: EvidenceStatus;
  totalCount: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  completedCount: number;
  expiredCount: number;
  averageReviewSeconds: number | null;
  confidenceDistribution: Record<LedgerReferenceRemediationConfidence, number>;
  remediationTrends: Array<{
    date: string;
    discovered: number;
    approved: number;
    rejected: number;
    completed: number;
  }>;
  generatedAt: string;
};

export type LedgerReferenceRemediationExecutionPlan = {
  remediationId: string;
  advisoryOnly: true;
  mutationAllowed: false;
  recordsInvolved: LedgerReferenceRemediationCandidate["affectedEntities"];
  probableRepair: string;
  confidence: LedgerReferenceRemediationConfidence;
  confidenceScore: number;
  dependencies: string[];
  expectedImpact: string[];
  estimatedRisk: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  validationChecklist: string[];
  rollbackConsiderations: string[];
  generatedAt: string;
};

export type LedgerReferenceRemediationApprovalResult = {
  approval: AuthorityApprovalRecord;
  outboxEventId: string;
  idempotent: boolean;
  candidateBefore: LedgerReferenceRemediationCandidate;
  candidateAfter: LedgerReferenceRemediationCandidate;
};
