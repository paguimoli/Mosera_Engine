import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

import type { AuthContext } from "../auth/auth-context.types";
import type { OperationalCommandRecord } from "./operational-governance.types";

let pool: Pool | null = null;

function databasePool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new OperationalGovernanceRepositoryError(
      "Operational Governance database is not configured."
    );
  }
  pool ??= new Pool({ connectionString });
  return pool;
}

export class OperationalGovernanceRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalGovernanceRepositoryError";
  }
}

type CommandRow = {
  command_id: string;
  command_type: string;
  idempotency_key: string;
  canonical_request_hash: string;
  correlation_id: string;
  causation_id: string | null;
  policy_id: string;
  policy_version: number;
};

function mapCommand(row: CommandRow): OperationalCommandRecord {
  return {
    commandId: row.command_id,
    commandType: row.command_type,
    idempotencyKey: row.idempotency_key,
    canonicalRequestHash: row.canonical_request_hash,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
  };
}

export function canonicalHash(value: unknown) {
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)])
      );
    }
    return input;
  }

  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex")}`;
}

export async function claimOperationalCommand(input: {
  commandType: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  authContext: AuthContext;
  scopeSnapshot: Record<string, unknown>;
  reason: string;
  affectedAuthority: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  causationId?: string | null;
}) {
  const result = await databasePool().query<CommandRow>(
    `select * from operational_governance.request_command(
       $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
       $11, $12, $13, $14, $15, $16
     )`,
    [
      randomUUID(),
      input.commandType,
      input.idempotencyKey,
      input.canonicalRequestHash,
      input.authContext.user.id,
      input.authContext.session.id,
      input.authContext.user.identityClass,
      JSON.stringify(input.authContext.groups.map((group) => group.name)),
      JSON.stringify(
        Object.fromEntries(input.authContext.permissions.map((permission) => [permission.key, true]))
      ),
      JSON.stringify(input.scopeSnapshot),
      input.reason,
      input.affectedAuthority,
      input.targetType,
      input.targetId,
      input.correlationId,
      input.causationId ?? null,
    ]
  );
  return mapCommand(result.rows[0]);
}

export async function authorizeOperationalCommand(commandId: string) {
  await databasePool().query(
    "select operational_governance.authorize_command($1::uuid)",
    [commandId]
  );
}

export async function withOperationalExecutionLock<T>(
  commandId: string,
  callback: () => Promise<T>
) {
  const client = await databasePool().connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [commandId]);
    return await callback();
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtextextended($1, 0))", [commandId])
      .finally(() => client.release());
  }
}

export async function findSuccessfulOperationalResult<TResult>(commandId: string) {
  const result = await databasePool().query<{ result_payload: TResult }>(
    `select result_payload
     from operational_governance.execution_evidence
     where command_id = $1::uuid and result_status = 'SUCCEEDED'
     order by attempt desc limit 1`,
    [commandId]
  );
  return result.rows[0]?.result_payload ?? null;
}

export async function appendOperationalEvent(input: {
  command: OperationalCommandRecord;
  actorIdentityId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}) {
  const eventId = randomUUID();
  await databasePool().query(
    `with next_event as (
       select coalesce(max(sequence), 0) + 1 as sequence
       from operational_governance.command_events where command_id = $2::uuid
     )
     insert into operational_governance.command_events (
       event_id, command_id, sequence, event_type, actor_identity_id,
       correlation_id, causation_id, metadata, evidence_hash
     )
     select $1::uuid, $2::uuid, sequence, $3, $4, $5, $6, $7::jsonb,
       'sha256:' || encode(digest($2::text || ':' || $3::text || ':' || sequence::text || ':' || $8::text, 'sha256'), 'hex')
     from next_event`,
    [
      eventId, input.command.commandId, input.eventType, input.actorIdentityId,
      input.command.correlationId, input.command.causationId,
      JSON.stringify(input.metadata ?? {}), canonicalHash(input.metadata ?? {}),
    ]
  );
}

export async function appendExecutionEvidence(input: {
  command: OperationalCommandRecord;
  status: "SUCCEEDED" | "FAILED";
  result: unknown;
  failureCode?: string | null;
  failureReason?: string | null;
}) {
  const payload = input.result ?? null;
  await databasePool().query(
    `with next_attempt as (
       select coalesce(max(attempt), 0) + 1 as attempt
       from operational_governance.execution_evidence where command_id = $2::uuid
     )
     insert into operational_governance.execution_evidence (
       evidence_id, command_id, attempt, result_status, result_payload, result_hash,
       failure_code, failure_reason, correlation_id, causation_id
     )
     select $1::uuid, $2::uuid, attempt, $3, $4::jsonb,
       'sha256:' || encode(digest($2::text || ':' || attempt::text || ':' || $3::text || ':' || $5::text, 'sha256'), 'hex'),
       $6, $7, $8, $9 from next_attempt`,
    [
      randomUUID(), input.command.commandId, input.status, JSON.stringify(payload),
      canonicalHash(payload), input.failureCode ?? null, input.failureReason ?? null,
      input.command.correlationId, input.command.causationId,
    ]
  );
}

export async function appendOperationalApproval(input: {
  commandId: string;
  approver: AuthContext;
  source: "HUMAN" | "SYSTEM";
  decision: "APPROVED" | "REJECTED";
  reason: string;
}) {
  const evidenceHash = canonicalHash({
    commandId: input.commandId,
    approverIdentityId: input.approver.user.id,
    source: input.source,
    decision: input.decision,
    reason: input.reason,
  });
  await databasePool().query(
    `insert into operational_governance.command_approvals (
       approval_id, command_id, approver_identity_id, approver_session_id,
       approval_source, decision, reason, evidence_hash
     ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
     on conflict (command_id, approver_identity_id, approval_source) do nothing`,
    [
      randomUUID(), input.commandId, input.approver.user.id, input.approver.session.id,
      input.source, input.decision, input.reason, evidenceHash,
    ]
  );
}

export async function getOperationalGovernanceReadiness() {
  const result = await databasePool().query<{
    check_name: string;
    ready: boolean;
    issue_count: number;
  }>("select * from operational_governance.readiness()");
  return result.rows.map((row) => ({
    checkName: row.check_name,
    ready: row.ready,
    issueCount: Number(row.issue_count),
  }));
}

export async function closeOperationalGovernancePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
