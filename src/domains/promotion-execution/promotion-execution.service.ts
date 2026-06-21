import {
  getAuthorityStatus,
  validateRollbackReadiness,
} from "../authority-control/authority-control.service";
import { setRuntimeAuthorityDomainConfiguration } from "../authority-control/authority-control.repository";
import type { AuthorityDomain } from "../authority-control/authority-control.types";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import { createOutboxEvent, listRecentOutboxEvents } from "../outbox/outbox.service";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
import {
  assertSupportedPromotionExecutionDomain,
} from "./promotion-execution.repository";
import type {
  PromotionExecutionInput,
  PromotionExecutionValidationResult,
  PromotionSimulationInput,
  RollbackSimulationInput,
  SettlementAuthorityPromotion,
  SettlementPromotionStatus,
  SettlementPromotionSimulation,
  SettlementRollbackSimulation,
} from "./promotion-execution.types";

export class PromotionExecutionValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PromotionExecutionValidationError";
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCorrelationId(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parsePromotionExecutionDomain(
  value: unknown
): AuthorityDomain {
  if (value === "SETTLEMENT") return "SETTLEMENT";
  if (value === "LEDGER") return "LEDGER";
  if (value === "CREDIT") return "CREDIT";

  throw new PromotionExecutionValidationError("A supported domain is required.");
}

function validationResult(
  name: string,
  passed: boolean,
  message: string
): PromotionExecutionValidationResult {
  return { name, passed, message };
}

function collectBlockers(results: PromotionExecutionValidationResult[]) {
  return results
    .filter((result) => !result.passed)
    .map((result) => result.message);
}

function getPromotionMetadata() {
  return {
    promotedAt: process.env.SETTLEMENT_PROMOTED_AT || null,
    promotionApprovalId: process.env.SETTLEMENT_PROMOTION_APPROVAL_ID || null,
  };
}

async function getLatestPromotionEventMetadata() {
  const events = await listRecentOutboxEvents({ limit: 100 });
  const promotionEvent = events.find(
    (event) =>
      event.eventType === "authority.promoted" &&
      event.aggregateType === "authority_candidate" &&
      event.aggregateId === "SETTLEMENT"
  );
  const payload = promotionEvent?.payload ?? {};

  return {
    promotedAt:
      typeof payload.promotedAt === "string"
        ? payload.promotedAt
        : promotionEvent?.createdAt ?? null,
    promotionApprovalId:
      typeof payload.promotionApprovalId === "string"
        ? payload.promotionApprovalId
        : null,
  };
}

export async function simulateSettlementPromotion(
  input: PromotionSimulationInput
): Promise<SettlementPromotionSimulation> {
  assertSupportedPromotionExecutionDomain(input.domain);

  const correlationId = normalizeCorrelationId(input.correlationId);
  const [promotionDecision, rollbackReadiness] = await Promise.all([
    getPromotionDecision({ domain: "SETTLEMENT" }),
    validateRollbackReadiness(),
  ]);
  const settlementRollback = rollbackReadiness.settlement;
  const validationResults = [
    validationResult(
      "PROMOTION_DECISION_READY",
      promotionDecision.decision === "READY_FOR_CONTROLLED_PROMOTION",
      "Promotion decision must be READY_FOR_CONTROLLED_PROMOTION."
    ),
    validationResult(
      "DRY_RUN_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.dryRunApproval),
      "DRY_RUN_APPROVAL must exist."
    ),
    validationResult(
      "PROMOTION_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.promotionApproval),
      "PROMOTION_APPROVAL must exist."
    ),
    validationResult(
      "ROLLBACK_READY",
      promotionDecision.rollbackReadiness === "READY" &&
        settlementRollback.rollbackStatus === "READY",
      "Rollback readiness must be READY."
    ),
    validationResult(
      "AUTHORITY_MONOLITH",
      promotionDecision.currentAuthority === "MONOLITH",
      "Settlement authority must remain MONOLITH before controlled promotion."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      promotionDecision.comparisonMode === "ENABLED",
      "Settlement comparison mode must be ENABLED."
    ),
    validationResult(
      "SERVICE_HEALTHY",
      settlementRollback.serviceHealth.available,
      "Settlement Service health must be available."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = [...promotionDecision.warnings];
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.promotion.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId,
    payload: {
      domain: "SETTLEMENT",
      currentAuthority: promotionDecision.currentAuthority,
      proposedAuthority: "SERVICE",
      comparisonMode: promotionDecision.comparisonMode,
      rollbackReadiness: promotionDecision.rollbackReadiness,
      promotionAllowed: blockers.length === 0,
      blockers,
      warnings,
      simulatedAt,
    },
  });

  return {
    domain: "SETTLEMENT",
    currentAuthority: promotionDecision.currentAuthority,
    proposedAuthority: "SERVICE",
    comparisonMode: promotionDecision.comparisonMode,
    promotionDecision: promotionDecision.decision,
    rollbackReadiness: promotionDecision.rollbackReadiness,
    serviceHealth: settlementRollback.serviceHealth,
    validationResults,
    blockers,
    warnings,
    promotionAllowed: blockers.length === 0,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
    simulatedAt,
  };
}

export async function simulateSettlementRollback(
  input: RollbackSimulationInput
): Promise<SettlementRollbackSimulation> {
  assertSupportedPromotionExecutionDomain(input.domain);

  const correlationId = normalizeCorrelationId(input.correlationId);
  const rollbackReadiness = await validateRollbackReadiness();
  const settlementRollback = rollbackReadiness.settlement;
  const validationResults = [
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      settlementRollback.monolithPathAvailable,
      "Monolith path must be available."
    ),
    validationResult(
      "COMPARISON_MODE_AVAILABLE",
      settlementRollback.comparisonMode === "ENABLED",
      "Comparison mode must be ENABLED."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      settlementRollback.authority === "MONOLITH" ||
        settlementRollback.authority === "SERVICE",
      "Authority controls must be available."
    ),
    validationResult(
      "ROLLBACK_READY",
      settlementRollback.rollbackStatus === "READY",
      "Rollback readiness must be READY."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = settlementRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.rollback.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId,
    payload: {
      domain: "SETTLEMENT",
      authorityState: settlementRollback.authority,
      comparisonMode: settlementRollback.comparisonMode,
      rollbackReadiness: settlementRollback.rollbackStatus,
      rollbackAllowed: blockers.length === 0,
      blockers,
      warnings,
      simulatedAt,
    },
  });

  return {
    domain: "SETTLEMENT",
    authorityState: settlementRollback.authority,
    comparisonMode: settlementRollback.comparisonMode,
    rollbackReadiness: settlementRollback.rollbackStatus,
    serviceHealth: settlementRollback.serviceHealth,
    monolithPathAvailable: settlementRollback.monolithPathAvailable,
    validationResults,
    blockers,
    warnings,
    rollbackAllowed: blockers.length === 0,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
    simulatedAt,
  };
}

export async function promoteSettlementAuthority({
  actor,
  domain,
  correlationId,
}: PromotionExecutionInput & {
  actor: AuthenticatedUser;
}): Promise<SettlementAuthorityPromotion> {
  assertSupportedPromotionExecutionDomain(domain);

  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const authorityStatusBefore = getAuthorityStatus().settlement;
  const promotionDecisionBefore = await getPromotionDecision({ domain: "SETTLEMENT" });
  const promotionApproval =
    promotionDecisionBefore.approvalState.promotionApproval;

  if (authorityStatusBefore.authority === "SERVICE") {
    const rollbackReadiness = await validateRollbackReadiness();
    const metadata = getPromotionMetadata();

    return {
      domain: "SETTLEMENT",
      previousAuthority: "SERVICE",
      newAuthority: "SERVICE",
      comparisonMode: "ENABLED",
      rollbackReadiness: rollbackReadiness.settlement.rollbackStatus,
      promotionApprovalId:
        metadata.promotionApprovalId ?? promotionApproval?.id ?? null,
      promotedAt: metadata.promotedAt ?? nowIso(),
      correlationId: normalizedCorrelationId,
      idempotent: true,
      auditEvent: null,
    };
  }

  const simulation = await simulateSettlementPromotion({
    domain,
    correlationId: normalizedCorrelationId,
  });

  if (!simulation.promotionAllowed) {
    throw new PromotionExecutionValidationError(
      "Settlement authority promotion preconditions are not satisfied.",
      409
    );
  }

  if (!promotionApproval) {
    throw new PromotionExecutionValidationError(
      "PROMOTION_APPROVAL is required before controlled promotion.",
      409
    );
  }

  const promotedAt = nowIso();
  setRuntimeAuthorityDomainConfiguration({
    domain: "SETTLEMENT",
    authority: "SERVICE",
    comparisonMode: "ENABLED",
  });
  process.env.SETTLEMENT_PROMOTED_AT = promotedAt;
  process.env.SETTLEMENT_PROMOTION_APPROVAL_ID = promotionApproval.id;

  const auditEvent = await createOutboxEvent({
    eventType: "authority.promoted",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "SETTLEMENT",
      previousAuthority: authorityStatusBefore.authority,
      newAuthority: "SERVICE",
      actorUserId: actor.id,
      promotionApprovalId: promotionApproval.id,
      correlationId: normalizedCorrelationId,
      promotedAt,
    },
  });

  return {
    domain: "SETTLEMENT",
    previousAuthority: authorityStatusBefore.authority,
    newAuthority: "SERVICE",
    comparisonMode: "ENABLED",
    rollbackReadiness: simulation.rollbackReadiness,
    promotionApprovalId: promotionApproval.id,
    promotedAt,
    correlationId: normalizedCorrelationId,
    idempotent: false,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
  };
}

export async function getSettlementPromotionStatus(): Promise<SettlementPromotionStatus> {
  const [authorityStatus, rollbackReadiness, promotionDecision, eventMetadata] =
    await Promise.all([
      Promise.resolve(getAuthorityStatus()),
      validateRollbackReadiness(),
      getPromotionDecision({ domain: "SETTLEMENT" }),
      getLatestPromotionEventMetadata(),
    ]);
  const settlementAuthority = authorityStatus.settlement;
  const settlementRollback = rollbackReadiness.settlement;
  const metadata = getPromotionMetadata();

  return {
    domain: "SETTLEMENT",
    authority: settlementAuthority.authority,
    comparisonMode: settlementAuthority.comparisonMode,
    promotedAt:
      settlementAuthority.authority === "SERVICE"
        ? metadata.promotedAt ?? eventMetadata.promotedAt
        : null,
    rollbackReady: settlementRollback.rollbackStatus === "READY",
    rollbackReadiness: settlementRollback.rollbackStatus,
    promotionApprovalId:
      metadata.promotionApprovalId ??
      eventMetadata.promotionApprovalId ??
      promotionDecision.approvalState.promotionApproval?.id ??
      null,
    evaluatedAt: nowIso(),
  };
}
