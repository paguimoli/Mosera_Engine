import type { AuthContext } from "../auth/auth-context.types";
import {
  listShadowAnalysisFailures,
  listShadowAnalysisMismatches,
} from "../shadow-analysis/shadow-analysis.service";
import type {
  ClassifiedShadowEvidence,
  ShadowEvidenceKind,
} from "../shadow-analysis/shadow-analysis.types";
import {
  createShadowEvidenceLifecycleEvent,
  getEffectiveLifecycleStatusMap,
  getLifecycleKey,
  listShadowEvidenceLifecycleEvents,
} from "./shadow-evidence-lifecycle.repository";
import type {
  ShadowEvidenceLifecycleEvent,
  ShadowEvidenceLifecycleExclusionResult,
  ShadowEvidenceLifecycleReasonCode,
  ShadowEvidenceLifecycleStatus,
  ShadowEvidenceLifecycleSummary,
} from "./shadow-evidence-lifecycle.types";

const LIFECYCLE_STATUSES: ShadowEvidenceLifecycleStatus[] = [
  "ACTIVE",
  "EXCLUDED_FROM_PROMOTION",
  "ARCHIVED",
  "REVIEW_REQUIRED",
];

const REASON_CODES: ShadowEvidenceLifecycleReasonCode[] = [
  "QA_INTENTIONAL",
  "QA_FAILURE_TEST",
  "LOAD_TEST",
  "BACKFILL_TEST",
  "OPERATOR_EXCLUDED",
  "EXPIRED_TEST_EVIDENCE",
  "UNEXPLAINED",
];

function emptyStatusCounts() {
  return LIFECYCLE_STATUSES.reduce(
    (counts, status) => {
      counts[status] = 0;

      return counts;
    },
    {} as Record<ShadowEvidenceLifecycleStatus, number>
  );
}

function emptyReasonCounts() {
  return REASON_CODES.reduce(
    (counts, reasonCode) => {
      counts[reasonCode] = 0;

      return counts;
    },
    {} as Record<ShadowEvidenceLifecycleReasonCode, number>
  );
}

function isQaEvidence(evidence: ClassifiedShadowEvidence) {
  return (
    evidence.evidenceClass === "QA_INTENTIONAL_MISMATCH" ||
    evidence.evidenceClass === "QA_INTENTIONAL_FAILURE"
  );
}

function getActorUserId(actor?: AuthContext | null) {
  return actor?.user.id ?? null;
}

function getActorUsername(actor?: AuthContext | null) {
  return actor?.user.username ?? null;
}

async function getAllClassifiedQaEvidence() {
  const [mismatches, failures] = await Promise.all([
    listShadowAnalysisMismatches("all"),
    listShadowAnalysisFailures("all"),
  ]);

  return [...mismatches, ...failures].filter(isQaEvidence);
}

export async function getShadowEvidenceLifecycleEvents(): Promise<
  ShadowEvidenceLifecycleEvent[]
> {
  return listShadowEvidenceLifecycleEvents();
}

export async function getShadowEvidenceLifecycleSummary(): Promise<ShadowEvidenceLifecycleSummary> {
  const events = await listShadowEvidenceLifecycleEvents();
  const effective = await getEffectiveLifecycleStatusMap();
  const effectiveStatusCounts = emptyStatusCounts();
  const reasonCounts = emptyReasonCounts();

  for (const event of effective.values()) {
    effectiveStatusCounts[event.newStatus] += 1;
  }

  for (const event of events) {
    reasonCounts[event.reasonCode] += 1;
  }

  return {
    totalEvents: events.length,
    effectiveStatusCounts,
    reasonCounts,
    generatedAt: new Date().toISOString(),
  };
}

export async function excludeClassifiedQaShadowEvidence({
  actor,
  correlationId,
}: {
  actor?: AuthContext | null;
  correlationId?: string | null;
} = {}): Promise<ShadowEvidenceLifecycleExclusionResult> {
  const evidence = await getAllClassifiedQaEvidence();
  const effective = await getEffectiveLifecycleStatusMap();
  let createdEvents = 0;
  let skippedExisting = 0;

  for (const item of evidence) {
    const key = getLifecycleKey({
      domain: item.domain,
      evidenceType: item.kind as ShadowEvidenceKind,
      evidenceId: item.id,
    });
    const currentStatus = effective.get(key)?.newStatus ?? "ACTIVE";

    if (currentStatus === "EXCLUDED_FROM_PROMOTION") {
      skippedExisting += 1;
      continue;
    }

    const event = await createShadowEvidenceLifecycleEvent({
      domain: item.domain,
      evidenceType: item.kind as ShadowEvidenceKind,
      evidenceId: item.id,
      previousStatus: currentStatus,
      newStatus: "EXCLUDED_FROM_PROMOTION",
      reasonCode: "QA_INTENTIONAL",
      reasonNote: `Automatically excluded ${item.evidenceClass} from promotion readiness.`,
      actorUserId: getActorUserId(actor),
      correlationId: correlationId ?? item.correlationId ?? null,
    });

    effective.set(key, event);
    createdEvents += 1;
  }

  return {
    createdEvents,
    skippedExisting,
    consideredEvidence: evidence.length,
    generatedAt: new Date().toISOString(),
  };
}

export function getLifecycleActorMetadata(actor?: AuthContext | null) {
  return {
    actorUserId: getActorUserId(actor),
    actorUsername: getActorUsername(actor),
  };
}
