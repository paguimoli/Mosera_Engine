import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import { canonicalHash } from "@/src/domains/operational-governance/operational-governance.repository";
import type {
  OperationalSecurityDecision,
  PrivilegedSessionKind,
  PrivilegedSessionRecord,
} from "./operational-security.types";

let pool: Pool | null = null;

function database() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("Operational Security persistence is unavailable.");
  pool ??= new Pool({ connectionString });
  return pool;
}

function mapSession(row: QueryResultRow): PrivilegedSessionRecord {
  return {
    privilegedSessionId: row.privileged_session_id,
    authenticationSessionId: row.authentication_session_id,
    identityId: row.identity_id,
    identityClass: row.identity_class,
    sessionKind: row.session_kind,
    mfaEvidenceId: row.mfa_evidence_id,
    authorizationCommandId: row.authorization_command_id ?? null,
    reason: row.reason,
    ticketReference: row.ticket_reference,
    correlationId: row.correlation_id,
    activatedAt: new Date(row.activated_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function createPrivilegedSession(input: {
  authContext: AuthContext;
  sessionKind: PrivilegedSessionKind;
  mfaEvidenceId: string;
  mfaEvidenceHash: string;
  reason: string;
  ticketReference: string;
  correlationId: string;
  durationMinutes: number;
  authorizationCommandId?: string | null;
}) {
  const now = new Date();
  const maximum = input.sessionKind === "BREAK_GLASS" ? 15 : 30;
  if (!input.reason.trim() || !input.ticketReference.trim()) {
    throw new Error("Privileged sessions require a reason and ticket reference.");
  }
  if (!input.mfaEvidenceId.trim() || !/^sha256:[0-9a-f]{64}$/.test(input.mfaEvidenceHash)) {
    throw new Error("Durable MFA verification evidence is required.");
  }
  if (input.durationMinutes < 1 || input.durationMinutes > maximum) {
    throw new Error(`Privileged session duration must be between 1 and ${maximum} minutes.`);
  }

  if (process.env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase() === "production") {
    const mfaEvidence = await database().query<{ verified: boolean }>(
      `select exists (
         select 1 from auth_service.authentication_audit_evidence
          where id::text=$1 and actor_identity_id::text=$2
            and action='MFA_VERIFIED' and result='SUCCESS'
            and occurred_at > now() - interval '5 minutes'
       ) verified`,
      [input.mfaEvidenceId, input.authContext.user.id]
    );
    if (!mfaEvidence.rows[0]?.verified) {
      throw new Error("Auth Service MFA evidence is missing, stale, or belongs to another identity.");
    }
    if (input.sessionKind === "BREAK_GLASS") {
      if (!input.authorizationCommandId) {
        throw new Error("Break-glass activation requires an independently approved command.");
      }
      const approval = await database().query<{ authorized: boolean }>(
        `select operational_governance.break_glass_command_authorized($1::uuid,$2) authorized`,
        [input.authorizationCommandId, input.authContext.user.id]
      );
      if (!approval.rows[0]?.authorized) {
        throw new Error("Break-glass activation lacks independent approval.");
      }
    }
  }

  const privilegedSessionId = randomUUID();
  const expiresAt = new Date(now.getTime() + input.durationMinutes * 60_000);
  const evidenceHash = canonicalHash({
    privilegedSessionId,
    authenticationSessionId: input.authContext.session.id,
    identityId: input.authContext.user.id,
    sessionKind: input.sessionKind,
    mfaEvidenceId: input.mfaEvidenceId,
    reason: input.reason,
    ticketReference: input.ticketReference,
    correlationId: input.correlationId,
    activatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    authorizationCommandId: input.authorizationCommandId ?? null,
  });

  const client = await database().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `insert into operational_governance.privileged_sessions (
         privileged_session_id, authentication_session_id, identity_id, identity_class,
         session_kind, mfa_evidence_id, mfa_evidence_hash, reason, ticket_reference,
         correlation_id, activated_at, expires_at, evidence_hash, authorization_command_id
       ) values ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid) returning *`,
      [privilegedSessionId, input.authContext.session.id, input.authContext.user.id,
       input.authContext.user.identityClass, input.sessionKind, input.mfaEvidenceId,
       input.mfaEvidenceHash, input.reason.trim(), input.ticketReference.trim(),
       input.correlationId, now, expiresAt, evidenceHash, input.authorizationCommandId ?? null]
    );
    await client.query(
      `insert into operational_governance.privileged_session_events (
         event_id, privileged_session_id, sequence, event_type, actor_identity_id,
         reason, ticket_reference, correlation_id, occurred_at, effective_expires_at,
         evidence_hash
       ) values ($1::uuid,$2::uuid,1,'ACTIVATED',$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), privilegedSessionId, input.authContext.user.id, input.reason.trim(),
       input.ticketReference.trim(), input.correlationId, now, expiresAt,
       canonicalHash({ privilegedSessionId, eventType: "ACTIVATED", sequence: 1 })]
    );
    await client.query("commit");
    return mapSession(result.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function terminatePrivilegedSession(input: {
  privilegedSessionId: string;
  actorIdentityId: string;
  reason: string;
  ticketReference: string;
  correlationId: string;
  forced?: boolean;
}) {
  const target = await database().query<{
    authentication_session_id: string;
    identity_id: string;
  }>(
    `select authentication_session_id, identity_id
       from operational_governance.privileged_sessions
      where privileged_session_id=$1::uuid`,
    [input.privilegedSessionId]
  );
  if (!target.rows[0]) throw new Error("Privileged session was not found.");
  const current = await database().query<{ next_sequence: number }>(
    `select coalesce(max(sequence),0)::int + 1 next_sequence
       from operational_governance.privileged_session_events
      where privileged_session_id=$1::uuid`, [input.privilegedSessionId]
  );
  const sequence = current.rows[0]?.next_sequence ?? 1;
  const eventType = input.forced ? "FORCED_TERMINATED" : "MANUAL_TERMINATED";
  await database().query(
    `insert into operational_governance.privileged_session_events (
       event_id, privileged_session_id, sequence, event_type, actor_identity_id,
       reason, ticket_reference, correlation_id, occurred_at, evidence_hash
     ) values ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,now(),$9)`,
    [randomUUID(), input.privilegedSessionId, sequence, eventType,
     input.actorIdentityId, input.reason.trim(), input.ticketReference.trim(),
     input.correlationId,
     canonicalHash({ privilegedSessionId: input.privilegedSessionId, sequence, eventType })]
  );
  return {
    authenticationSessionId: target.rows[0].authentication_session_id,
    identityId: target.rows[0].identity_id,
  };
}

export async function validateOperationalCommandSecurity(input: {
  commandId: string;
  privilegedSessionId?: string | null;
  executorIdentityId: string;
  productionEnforced: boolean;
}): Promise<OperationalSecurityDecision> {
  const result = await database().query(
    `select * from operational_governance.validate_command_security(
       $1::uuid,$2::uuid,$3,$4
     )`,
    [input.commandId, input.privilegedSessionId || null,
     input.executorIdentityId, input.productionEnforced]
  );
  const row = result.rows[0];
  return {
    validationId: row.validation_id,
    commandId: row.command_id,
    privilegedSessionId: row.privileged_session_id ?? null,
    decision: row.decision,
    productionEnforced: row.production_enforced,
    mfaVerified: row.mfa_verified,
    sessionVerified: row.session_verified,
    approvalVerified: row.approval_verified,
    separationOfDutiesVerified: row.separation_of_duties_verified,
  };
}

export async function assertActivePrivilegedSession(input: {
  privilegedSessionId: string;
  authContext: AuthContext;
}) {
  const result = await database().query<{ active: boolean }>(
    `select operational_governance.privileged_session_active(
       $1::uuid,$2,$3,now()
     ) active`,
    [input.privilegedSessionId, input.authContext.session.id, input.authContext.user.id]
  );
  if (!result.rows[0]?.active) {
    throw new Error("Privileged session is missing, expired, or revoked.");
  }
}

export async function findOperationalCommandByIdempotencyKey(idempotencyKey: string) {
  const result = await database().query<{
    command_id: string;
    command_type: string;
    actor_identity_id: string;
    correlation_id: string;
    requested_at: Date;
  }>(
    `select command_id, command_type, actor_identity_id, correlation_id, requested_at
       from operational_governance.commands where idempotency_key=$1`, [idempotencyKey]
  );
  const row = result.rows[0];
  return row ? {
    commandId: row.command_id,
    commandType: row.command_type,
    requesterIdentityId: row.actor_identity_id,
    correlationId: row.correlation_id,
    requestedAt: new Date(row.requested_at).toISOString(),
  } : null;
}

export async function checkOperationalSecurityReadiness() {
  const result = await database().query<{ ready: boolean }>(
    `select
       to_regclass('operational_governance.security_policy_versions') is not null
       and to_regclass('operational_governance.privileged_sessions') is not null
       and to_regprocedure('operational_governance.validate_command_security(uuid,uuid,text,boolean)') is not null
       and exists(select 1 from operational_governance.security_policy_versions where effective_to is null)
       as ready`
  );
  return result.rows[0]?.ready === true;
}

export async function closeOperationalSecurityPool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
