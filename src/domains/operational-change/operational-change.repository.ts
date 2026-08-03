import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { canonicalHash } from "../operational-governance/operational-governance.repository";
import type {
  OperationalChangeRecord,
  OperationalChangeType,
  OperationalChangeVerification,
} from "./operational-change.types";

let pool: Pool | null = null;

function database() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("Operational Change persistence is unavailable.");
  pool ??= new Pool({ connectionString });
  return pool;
}

export async function claimOperationalChange(input: {
  commandId: string;
  changeType: OperationalChangeType;
  idempotencyKey: string;
  expectedState: Record<string, unknown>;
}) {
  const canonicalChangeHash = canonicalHash({
    commandId: input.commandId,
    changeType: input.changeType,
    expectedState: input.expectedState,
  });
  const result = await database().query<{
    change_id: string;
    command_id: string;
    change_type: OperationalChangeType;
    idempotency_key: string;
    canonical_change_hash: string;
    correlation_id: string;
  }>(
    "select * from operational_governance.request_change($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)",
    [randomUUID(), input.commandId, input.changeType, input.idempotencyKey,
      canonicalChangeHash, JSON.stringify(input.expectedState)]
  );
  const row = result.rows[0];
  return {
    changeId: row.change_id,
    commandId: row.command_id,
    changeType: row.change_type,
    idempotencyKey: row.idempotency_key,
    canonicalChangeHash: row.canonical_change_hash,
    correlationId: row.correlation_id,
  } satisfies OperationalChangeRecord;
}

export async function beginOperationalChange(input: {
  change: OperationalChangeRecord;
  executorIdentityId: string;
}) {
  const result = await database().query<{ attempt: number }>(
    "select operational_governance.begin_change_execution($1::uuid,$2::uuid,$3,$4) attempt",
    [input.change.changeId, input.change.commandId, input.executorIdentityId, input.change.changeType]
  );
  return Number(result.rows[0]?.attempt ?? 0);
}

export async function completeOperationalChange(input: {
  change: OperationalChangeRecord;
  attempt: number;
  executorIdentityId: string;
  result: unknown;
  verification: OperationalChangeVerification;
  failureCode?: string | null;
  failureReason?: string | null;
}) {
  const completed = await database().query<{ decision: "VERIFIED" | "FAILED" }>(
    `select completed.* from operational_governance.complete_change_execution(
       $1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11
     ) completed`,
    [input.change.changeId, input.attempt, input.executorIdentityId,
      JSON.stringify(input.result ?? {}), JSON.stringify(input.verification.observedState),
      input.verification.expectedStateReached, input.verification.authorityAccepted,
      input.verification.readinessMaintained, input.verification.auditRecorded,
      input.failureCode ?? null, input.failureReason ?? null]
  );
  return completed.rows[0]?.decision;
}

export async function recordMaintenanceEvent(input: {
  change: OperationalChangeRecord;
  websiteId: string;
  action: "BEGIN" | "END";
  actorIdentityId: string;
  reason: string;
}) {
  await database().query(
    `insert into operational_governance.maintenance_events (
       maintenance_event_id, change_id, website_id, action, actor_identity_id,
       reason, correlation_id, evidence_hash
     ) values ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) on conflict (change_id) do nothing`,
    [randomUUID(), input.change.changeId, input.websiteId, input.action,
      input.actorIdentityId, input.reason, input.change.correlationId,
      canonicalHash({ changeId: input.change.changeId, websiteId: input.websiteId,
        action: input.action, actorIdentityId: input.actorIdentityId, reason: input.reason })]
  );
}

export async function getOperationalChangeReadiness() {
  const result = await database().query<{ check_name: string; ready: boolean; issue_count: number }>(
    "select * from operational_governance.operational_change_readiness()"
  );
  return result.rows.map((row) => ({ checkName: row.check_name, ready: row.ready,
    issueCount: Number(row.issue_count) }));
}

export async function findOperationalChange(changeId: string) {
  const result = await database().query<{
    change_id: string;
    command_id: string;
    change_type: OperationalChangeType;
    idempotency_key: string;
    canonical_change_hash: string;
    correlation_id: string;
    actor_identity_id: string;
  }>("select * from operational_governance.change_requests where change_id=$1::uuid", [changeId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    changeId: row.change_id,
    commandId: row.command_id,
    changeType: row.change_type,
    idempotencyKey: row.idempotency_key,
    canonicalChangeHash: row.canonical_change_hash,
    correlationId: row.correlation_id,
    actorIdentityId: row.actor_identity_id,
  };
}

export async function closeOperationalChangePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
