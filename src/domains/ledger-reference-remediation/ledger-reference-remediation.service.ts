import {
  createAuthorityApprovalRecord,
  findAuthorityApprovalRecordByCorrelationId,
  listAuthorityApprovalRecords,
} from "../authority-approval/authority-approval.repository";
import type { AuthorityApprovalRecord } from "../authority-approval/authority-approval.types";
import { createOutboxEvent } from "../outbox/outbox.repository";
import { getLedgerReferenceRemediationReport } from "../platform-evidence/platform-evidence.service";
import type {
  LedgerReferenceAuditIssue,
  LedgerReferenceRemediationItem,
} from "../platform-evidence/platform-evidence.types";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import type {
  LedgerReferenceRemediationApprovalResult,
  LedgerReferenceRemediationCandidate,
  LedgerReferenceRemediationConfidence,
  LedgerReferenceRemediationDecision,
  LedgerReferenceRemediationExecutionPlan,
  LedgerReferenceRemediationQueue,
  LedgerReferenceRemediationQueueFilters,
  LedgerReferenceRemediationStatus,
  LedgerReferenceRemediationSummary,
} from "./ledger-reference-remediation.types";

const REMEDIATION_APPROVAL_KIND = "LEDGER_REFERENCE_REMEDIATION_APPROVAL";
const REMEDIATION_WORKFLOW = "LEDGER_REFERENCE_REMEDIATION";
const APPROVAL_TYPE = "ROLLBACK_APPROVAL";
const EXPIRATION_MS = 1000 * 60 * 60 * 24 * 90;

export class LedgerReferenceRemediationValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "LedgerReferenceRemediationValidationError";
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stableId(prefix: string, values: Array<string | null | undefined>) {
  const source = values.filter(Boolean).join("|");
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }

  return `${prefix}-${hash.toString(16).padStart(8, "0")}`;
}

function confidenceScore(confidence: LedgerReferenceRemediationConfidence) {
  switch (confidence) {
    case "HIGH":
      return 0.9;
    case "MEDIUM":
      return 0.65;
    case "LOW":
      return 0.35;
    default:
      return 0.1;
  }
}

function latestApprovalForCandidate(
  approvals: AuthorityApprovalRecord[],
  remediationId: string
) {
  return (
    approvals.find(
      (approval) =>
        approval.metadata?.remediationWorkflow === REMEDIATION_WORKFLOW &&
        approval.metadata?.remediationId === remediationId
    ) ?? null
  );
}

function decisionFromApproval(
  approval: AuthorityApprovalRecord | null
): LedgerReferenceRemediationDecision | null {
  const decision = approval?.metadata?.remediationDecision;

  return decision === "START_REVIEW" ||
    decision === "APPROVE" ||
    decision === "REJECT" ||
    decision === "COMPLETE"
    ? decision
    : null;
}

function statusFromApproval(
  approval: AuthorityApprovalRecord | null,
  discoveredAt: string
): LedgerReferenceRemediationStatus {
  const decision = decisionFromApproval(approval);

  if (decision === "COMPLETE") return "COMPLETED";
  if (decision === "REJECT") return "REJECTED";
  if (decision === "APPROVE") return "APPROVED";
  if (decision === "START_REVIEW") return "UNDER_REVIEW";
  if (Date.now() - new Date(discoveredAt).getTime() > EXPIRATION_MS) {
    return "EXPIRED";
  }

  return "NEW";
}

function affectedEntities(item: LedgerReferenceRemediationItem) {
  return [
    item.settlementApplicationId
      ? {
          entityType: "CREDIT_SETTLEMENT_APPLICATION" as const,
          entityId: item.settlementApplicationId,
        }
      : null,
    item.settlementId
      ? { entityType: "SETTLEMENT" as const, entityId: item.settlementId }
      : null,
    item.reservationId
      ? {
          entityType: "CREDIT_RESERVATION" as const,
          entityId: item.reservationId,
        }
      : null,
    item.ticketId ? { entityType: "TICKET" as const, entityId: item.ticketId } : null,
    item.ledgerEntryId
      ? { entityType: "LEDGER_ENTRY" as const, entityId: item.ledgerEntryId }
      : null,
    item.correlationId
      ? { entityType: "CORRELATION" as const, entityId: item.correlationId }
      : null,
  ].filter((entity): entity is NonNullable<typeof entity> => Boolean(entity));
}

function discoveryReasonForIssue(issueKind: LedgerReferenceAuditIssue["kind"]) {
  switch (issueKind) {
    case "MISSING_LEDGER_POSTING":
      return "Settlement application lacks direct or inferred sampled ledger reference evidence.";
    case "MISSING_SETTLEMENT_REFERENCE":
      return "Ledger evidence is inferred, but direct settlement reference coverage is missing.";
    case "ORPHAN_LEDGER_RECORD":
      return "Settlement ledger record lacks a direct settlement reference.";
    case "ORPHAN_SETTLEMENT_REFERENCE":
      return "Settlement reference evidence could not be matched to a ledger record.";
    default:
      return "Ledger reference evidence requires operator review.";
  }
}

function sourceEntityId(item: LedgerReferenceRemediationItem) {
  return (
    item.settlementApplicationId ??
    item.ledgerEntryId ??
    item.settlementId ??
    item.reservationId ??
    item.ticketId ??
    item.correlationId ??
    "unknown"
  );
}

async function listRemediationApprovals() {
  const approvals = await listAuthorityApprovalRecords({ authorityCandidate: "LEDGER" });

  return approvals.filter(
    (approval) => approval.metadata?.remediationWorkflow === REMEDIATION_WORKFLOW
  );
}

async function buildCandidates() {
  const [report, approvals] = await Promise.all([
    getLedgerReferenceRemediationReport(),
    listRemediationApprovals(),
  ]);

  return report.items.map((item): LedgerReferenceRemediationCandidate => {
    const remediationId = stableId("ledger-ref-remediation", [
      item.issueKind,
      item.settlementApplicationId,
      item.ledgerEntryId,
      item.settlementId,
      item.reservationId,
      item.ticketId,
      item.correlationId,
    ]);
    const discoveredAt = report.generatedAt;
    const latestApproval = latestApprovalForCandidate(approvals, remediationId);

    return {
      remediationId,
      sourceDomain: "LEDGER_REFERENCE",
      sourceEntityId: sourceEntityId(item),
      affectedEntities: affectedEntities(item),
      probableTarget: {
        entityType: item.probableLedgerEntryId ? "LEDGER_ENTRY" : "UNKNOWN",
        entityId: item.probableLedgerEntryId,
      },
      confidenceScore: confidenceScore(item.confidence),
      confidence: item.confidence,
      discoveryReason: discoveryReasonForIssue(item.issueKind),
      discoveredAt,
      status: statusFromApproval(latestApproval, discoveredAt),
      latestApproval,
      mutationAllowed: false,
    };
  });
}

function applyFilters(
  candidates: LedgerReferenceRemediationCandidate[],
  filters: LedgerReferenceRemediationQueueFilters
) {
  const search = filters.search?.trim().toLowerCase();

  return candidates.filter((candidate) => {
    if (filters.status && candidate.status !== filters.status) return false;
    if (filters.confidence && candidate.confidence !== filters.confidence) return false;
    if (!search) return true;

    return (
      candidate.remediationId.toLowerCase().includes(search) ||
      candidate.sourceEntityId.toLowerCase().includes(search) ||
      candidate.affectedEntities.some((entity) =>
        entity.entityId.toLowerCase().includes(search)
      ) ||
      (candidate.probableTarget.entityId ?? "").toLowerCase().includes(search)
    );
  });
}

function statusForQueue(candidates: LedgerReferenceRemediationCandidate[]) {
  return candidates.length > 0 ? "WARNING" : "READY";
}

export async function getLedgerReferenceRemediationQueue(
  filters: LedgerReferenceRemediationQueueFilters = {}
): Promise<LedgerReferenceRemediationQueue> {
  const candidates = applyFilters(await buildCandidates(), filters);

  return {
    status: statusForQueue(candidates),
    appendOnly: true,
    mutationAllowed: false,
    candidates,
    totalCount: candidates.length,
    filters,
    generatedAt: nowIso(),
  };
}

export async function getLedgerReferenceRemediationCandidate(remediationId: string) {
  const candidates = await buildCandidates();
  const candidate =
    candidates.find((item) => item.remediationId === remediationId) ?? null;

  if (!candidate) {
    throw new LedgerReferenceRemediationValidationError(
      "Ledger reference remediation candidate was not found.",
      404
    );
  }

  return candidate;
}

export async function getLedgerReferenceRemediationSummary(): Promise<LedgerReferenceRemediationSummary> {
  const candidates = await buildCandidates();
  const approvals = await listRemediationApprovals();
  const confidenceDistribution = {
    HIGH: candidates.filter((candidate) => candidate.confidence === "HIGH").length,
    MEDIUM: candidates.filter((candidate) => candidate.confidence === "MEDIUM")
      .length,
    LOW: candidates.filter((candidate) => candidate.confidence === "LOW").length,
    UNKNOWN: candidates.filter((candidate) => candidate.confidence === "UNKNOWN")
      .length,
  };
  const reviewDurations = candidates
    .filter((candidate) => candidate.latestApproval)
    .map((candidate) =>
      Math.max(
        0,
        Math.floor(
          (new Date(candidate.latestApproval?.createdAt ?? nowIso()).getTime() -
            new Date(candidate.discoveredAt).getTime()) /
            1000
        )
      )
    );
  const byDate = new Map<
    string,
    { date: string; discovered: number; approved: number; rejected: number; completed: number }
  >();

  for (const candidate of candidates) {
    const date = candidate.discoveredAt.slice(0, 10);
    const current =
      byDate.get(date) ??
      { date, discovered: 0, approved: 0, rejected: 0, completed: 0 };

    current.discovered += 1;
    byDate.set(date, current);
  }

  for (const approval of approvals) {
    const date = approval.createdAt.slice(0, 10);
    const current =
      byDate.get(date) ??
      { date, discovered: 0, approved: 0, rejected: 0, completed: 0 };
    const decision = decisionFromApproval(approval);

    if (decision === "APPROVE") current.approved += 1;
    if (decision === "REJECT") current.rejected += 1;
    if (decision === "COMPLETE") current.completed += 1;
    byDate.set(date, current);
  }

  return {
    status: statusForQueue(candidates),
    totalCount: candidates.length,
    pendingCount: candidates.filter(
      (candidate) => candidate.status === "NEW" || candidate.status === "UNDER_REVIEW"
    ).length,
    approvedCount: candidates.filter((candidate) => candidate.status === "APPROVED")
      .length,
    rejectedCount: candidates.filter((candidate) => candidate.status === "REJECTED")
      .length,
    completedCount: candidates.filter(
      (candidate) => candidate.status === "COMPLETED"
    ).length,
    expiredCount: candidates.filter((candidate) => candidate.status === "EXPIRED")
      .length,
    averageReviewSeconds:
      reviewDurations.length > 0
        ? Math.round(
            reviewDurations.reduce((sum, duration) => sum + duration, 0) /
              reviewDurations.length
          )
        : null,
    confidenceDistribution,
    remediationTrends: [...byDate.values()].sort((left, right) =>
      left.date.localeCompare(right.date)
    ),
    generatedAt: nowIso(),
  };
}

export async function getLedgerReferenceRemediationExecutionPlan(
  remediationId: string
): Promise<LedgerReferenceRemediationExecutionPlan> {
  const candidate = await getLedgerReferenceRemediationCandidate(remediationId);

  return {
    remediationId,
    advisoryOnly: true,
    mutationAllowed: false,
    recordsInvolved: candidate.affectedEntities,
    probableRepair:
      candidate.probableTarget.entityId === null
        ? "No direct repair is proposed. Operator review should determine whether a future separately approved remediation phase is warranted."
        : "A future separately approved remediation phase may consider linking the source evidence to the probable ledger target after independent validation.",
    confidence: candidate.confidence,
    confidenceScore: candidate.confidenceScore,
    dependencies: [
      "Operator evidence review",
      "Independent settlement and ledger trace validation",
      "Separate architectural approval before any historical repair",
    ],
    expectedImpact: [
      "Improves audit traceability evidence only if a future approved remediation phase is created.",
      "This plan performs no financial mutation and no reference rewrite.",
    ],
    estimatedRisk:
      candidate.confidence === "HIGH"
        ? "LOW"
        : candidate.confidence === "MEDIUM"
          ? "MEDIUM"
          : candidate.confidence === "LOW"
            ? "HIGH"
            : "UNKNOWN",
    validationChecklist: [
      "Confirm source settlement, reservation, ticket, and ledger evidence.",
      "Confirm no authority, balance, exposure, reservation, settlement, or ledger mutation is performed by this plan.",
      "Confirm any future repair is handled in a separate phase with dedicated authorization.",
      "Preserve all historical evidence and approval records.",
    ],
    rollbackConsiderations: [
      "No rollback is required for this advisory plan because no production data is modified.",
      "If a future repair phase is approved, it must define its own rollback strategy.",
    ],
    generatedAt: nowIso(),
  };
}

function normalizeDecision(value: unknown): LedgerReferenceRemediationDecision {
  if (
    value === "START_REVIEW" ||
    value === "APPROVE" ||
    value === "REJECT" ||
    value === "COMPLETE"
  ) {
    return value;
  }

  throw new LedgerReferenceRemediationValidationError(
    "remediationDecision must be START_REVIEW, APPROVE, REJECT, or COMPLETE."
  );
}

function validateTransition(
  currentStatus: LedgerReferenceRemediationStatus,
  decision: LedgerReferenceRemediationDecision
) {
  if (currentStatus === "COMPLETED") {
    throw new LedgerReferenceRemediationValidationError(
      "Completed remediation investigations are closed."
    );
  }
  if (currentStatus === "EXPIRED") {
    throw new LedgerReferenceRemediationValidationError(
      "Expired remediation investigations cannot be approved."
    );
  }
  if (decision === "COMPLETE" && currentStatus !== "APPROVED") {
    throw new LedgerReferenceRemediationValidationError(
      "Remediation investigation can only be completed after approval."
    );
  }
}

function nextStatus(
  decision: LedgerReferenceRemediationDecision
): LedgerReferenceRemediationStatus {
  if (decision === "START_REVIEW") return "UNDER_REVIEW";
  if (decision === "APPROVE") return "APPROVED";
  if (decision === "REJECT") return "REJECTED";

  return "COMPLETED";
}

export async function captureLedgerReferenceRemediationApproval(input: {
  actor: AuthenticatedUser;
  remediationId: string;
  remediationDecision: unknown;
  justification: unknown;
  correlationId?: unknown;
}): Promise<LedgerReferenceRemediationApprovalResult> {
  if (typeof input.justification !== "string" || input.justification.trim() === "") {
    throw new LedgerReferenceRemediationValidationError("justification is required.");
  }
  if (typeof input.remediationId !== "string" || input.remediationId.trim() === "") {
    throw new LedgerReferenceRemediationValidationError("remediationId is required.");
  }

  const remediationDecision = normalizeDecision(input.remediationDecision);
  const correlationId =
    typeof input.correlationId === "string" && input.correlationId.trim()
      ? input.correlationId.trim()
      : null;

  if (correlationId) {
    const existing = await findAuthorityApprovalRecordByCorrelationId({
      authorityCandidate: "LEDGER",
      approvalType: APPROVAL_TYPE,
      correlationId,
    });

    if (
      existing?.metadata?.remediationWorkflow === REMEDIATION_WORKFLOW &&
      existing.metadata?.remediationId === input.remediationId
    ) {
      const candidateAfter = await getLedgerReferenceRemediationCandidate(
        input.remediationId
      );

      return {
        approval: existing,
        outboxEventId:
          typeof existing.metadata?.outboxEventId === "string"
            ? existing.metadata.outboxEventId
            : "",
        idempotent: true,
        candidateBefore: candidateAfter,
        candidateAfter,
      };
    }
  }

  const candidateBefore = await getLedgerReferenceRemediationCandidate(
    input.remediationId
  );

  validateTransition(candidateBefore.status, remediationDecision);

  const statusAfter = nextStatus(remediationDecision);
  const outboxEvent = await createOutboxEvent({
    eventType: "operations.ledger_reference_remediation.review_recorded",
    aggregateType: "ledger_reference_remediation",
    aggregateId: input.remediationId,
    correlationId,
    payload: {
      remediationId: input.remediationId,
      remediationDecision,
      statusAfter,
      actorUserId: input.actor.id,
      correlationId,
      createdAt: nowIso(),
      mutationAllowed: false,
    },
  });
  const approval = await createAuthorityApprovalRecord({
    authorityCandidate: "LEDGER",
    approvalType: APPROVAL_TYPE,
    approverUserId: input.actor.id,
    approverUsername: input.actor.username,
    justification: input.justification.trim(),
    metadata: {
      approvalSemanticType: REMEDIATION_APPROVAL_KIND,
      remediationWorkflow: REMEDIATION_WORKFLOW,
      remediationId: input.remediationId,
      remediationDecision,
      statusBefore: candidateBefore.status,
      statusAfter,
      correlationId,
      outboxEventId: outboxEvent.id,
      mutationAllowed: false,
      financialRecordMutation: false,
    },
  });
  const candidateAfter = {
    ...candidateBefore,
    status: statusAfter,
    latestApproval: approval,
  };

  return {
    approval,
    outboxEventId: outboxEvent.id,
    idempotent: false,
    candidateBefore,
    candidateAfter,
  };
}
