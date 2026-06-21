import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  ShadowEvidenceLifecycleEvent,
  ShadowEvidenceLifecycleKey,
  ShadowEvidenceLifecycleReasonCode,
  ShadowEvidenceLifecycleStatus,
} from "./shadow-evidence-lifecycle.types";
import type {
  ShadowAnalysisDomain,
  ShadowEvidenceKind,
} from "../shadow-analysis/shadow-analysis.types";

type ShadowEvidenceLifecycleEventRow = {
  id: string;
  domain: ShadowAnalysisDomain;
  evidence_type: ShadowEvidenceKind;
  evidence_id: string;
  previous_status?: ShadowEvidenceLifecycleStatus | null;
  new_status: ShadowEvidenceLifecycleStatus;
  reason_code: ShadowEvidenceLifecycleReasonCode;
  reason_note?: string | null;
  actor_user_id?: string | null;
  correlation_id?: string | null;
  created_at: string;
};

type CreateLifecycleEventInput = {
  domain: ShadowAnalysisDomain;
  evidenceType: ShadowEvidenceKind;
  evidenceId: string;
  previousStatus?: ShadowEvidenceLifecycleStatus | null;
  newStatus: ShadowEvidenceLifecycleStatus;
  reasonCode: ShadowEvidenceLifecycleReasonCode;
  reasonNote?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
};

const LIFECYCLE_SELECT =
  "id, domain, evidence_type, evidence_id, previous_status, new_status, reason_code, reason_note, actor_user_id, correlation_id, created_at";

export class ShadowEvidenceLifecycleRepositoryError extends Error {
  constructor(message = "Shadow evidence lifecycle persistence failed.") {
    super(message);
    this.name = "ShadowEvidenceLifecycleRepositoryError";
  }
}

function isMissingTableError(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.message?.includes("shadow_evidence_lifecycle_events") ||
    error.message?.toLowerCase().includes("does not exist")
  );
}

function sanitizeSupabaseError(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}) {
  return JSON.stringify({
    code: error.code ?? null,
    message: error.message ?? "Unknown Supabase error.",
    details: error.details ?? null,
    hint: error.hint ?? null,
  });
}

export function getLifecycleKey({
  domain,
  evidenceType,
  evidenceId,
}: {
  domain: ShadowAnalysisDomain;
  evidenceType: ShadowEvidenceKind;
  evidenceId: string;
}): ShadowEvidenceLifecycleKey {
  return `${domain}:${evidenceType}:${evidenceId}`;
}

function mapLifecycleEvent(
  row: ShadowEvidenceLifecycleEventRow
): ShadowEvidenceLifecycleEvent {
  return {
    id: row.id,
    domain: row.domain,
    evidenceType: row.evidence_type,
    evidenceId: row.evidence_id,
    previousStatus: row.previous_status ?? null,
    newStatus: row.new_status,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note ?? null,
    actorUserId: row.actor_user_id ?? null,
    correlationId: row.correlation_id ?? null,
    createdAt: row.created_at,
  };
}

export async function listShadowEvidenceLifecycleEvents(): Promise<
  ShadowEvidenceLifecycleEvent[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("shadow_evidence_lifecycle_events")
    .select(LIFECYCLE_SELECT)
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) {
    if (isMissingTableError(error)) return [];

    throw new ShadowEvidenceLifecycleRepositoryError(error.message);
  }

  return ((data ?? []) as ShadowEvidenceLifecycleEventRow[]).map(
    mapLifecycleEvent
  );
}

export async function getEffectiveLifecycleStatusMap(): Promise<
  Map<ShadowEvidenceLifecycleKey, ShadowEvidenceLifecycleEvent>
> {
  const events = await listShadowEvidenceLifecycleEvents();
  const effective = new Map<
    ShadowEvidenceLifecycleKey,
    ShadowEvidenceLifecycleEvent
  >();

  for (const event of [...events].reverse()) {
    effective.set(
      getLifecycleKey({
        domain: event.domain,
        evidenceType: event.evidenceType,
        evidenceId: event.evidenceId,
      }),
      event
    );
  }

  return effective;
}

export async function createShadowEvidenceLifecycleEvent(
  input: CreateLifecycleEventInput
): Promise<ShadowEvidenceLifecycleEvent> {
  const { data, error } = await supabaseServerAdmin
    .from("shadow_evidence_lifecycle_events")
    .insert({
      domain: input.domain,
      evidence_type: input.evidenceType,
      evidence_id: input.evidenceId,
      previous_status: input.previousStatus ?? null,
      new_status: input.newStatus,
      reason_code: input.reasonCode,
      reason_note: input.reasonNote ?? null,
      actor_user_id: input.actorUserId ?? null,
      correlation_id: input.correlationId ?? null,
    })
    .select(LIFECYCLE_SELECT)
    .single();

  if (error) {
    throw new ShadowEvidenceLifecycleRepositoryError(
      sanitizeSupabaseError(error)
    );
  }

  return mapLifecycleEvent(data as ShadowEvidenceLifecycleEventRow);
}
