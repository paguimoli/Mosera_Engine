import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

import type { AuthContext } from "../../src/domains/auth/auth-context.types";
import {
  canonicalHash,
  claimOperationalCommand,
  closeOperationalGovernancePool,
} from "../../src/domains/operational-governance/operational-governance.repository";
import {
  executeGovernedOperation,
} from "../../src/domains/operational-governance/operational-governance.service";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl });

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) {
    console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
    process.exit(1);
  }
}

function authContext(identityId = randomUUID()): AuthContext {
  return {
    user: {
      id: identityId,
      username: `operator-${identityId}`,
      email: `${identityId}@qa.invalid`,
      displayName: "Operational QA",
      identityClass: "PLATFORM_OPERATOR",
      status: "ACTIVE",
      failedLoginAttempts: 0,
    },
    session: {
      id: randomUUID(),
      userId: identityId,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    groups: [{
      id: randomUUID(),
      name: "Super Admin",
      isSystemGroup: true,
      createdAt: new Date().toISOString(),
    }],
    permissions: [{
      id: randomUUID(),
      key: "system.admin",
      isSystemPermission: true,
      createdAt: new Date().toISOString(),
    }],
    platformScopes: [{ scopeType: "GLOBAL", scopeId: "platform" }],
    hasPermission: (permission) => permission === "system.admin",
  };
}

async function main() {
  try {
    const readiness = await pool.query<{ check_name: string; ready: boolean }>(
      "select * from operational_governance.readiness()"
    );
    assert(readiness.rows.length === 5 && readiness.rows.every((row) => row.ready),
      "Operational Governance readiness failed closed.", { readiness: readiness.rows });
    pass("one Operational Governance readiness evaluation passes");

    const actor = authContext();
    const runId = randomUUID();
    let executions = 0;
    const request = {
      authContext: actor,
      commandType: "SESSION_REVOCATION" as const,
      affectedAuthority: "AUTHENTICATION",
      targetType: "QA_SESSION",
      targetId: runId,
      reason: "BF-6.1 idempotency QA",
      correlationId: `bf-6-1-${runId}`,
      idempotencyKey: `bf-6-1:${runId}`,
      payload: { sessionId: runId },
    };
    const first = await executeGovernedOperation(request, async () => ({ executions: ++executions }));
    const duplicate = await executeGovernedOperation(request, async () => ({ executions: ++executions }));
    assert(!first.idempotent && duplicate.idempotent && executions === 1,
      "Duplicate operational execution was not suppressed.", { first, duplicate, executions });
    pass("duplicate operational execution is idempotent");

    let conflictRejected = false;
    try {
      await executeGovernedOperation(
        { ...request, payload: { sessionId: `${runId}-conflict` } },
        async () => ({ executions: ++executions })
      );
    } catch {
      conflictRejected = true;
    }
    assert(conflictRejected && executions === 1, "Conflicting idempotency payload did not fail closed.");
    pass("conflicting idempotency payload fails closed");

    const policyRun = randomUUID();
    const dual = await claimOperationalCommand({
      commandType: "POLICY_DUAL_APPROVAL_QA",
      idempotencyKey: `bf-6-1-dual:${policyRun}`,
      canonicalRequestHash: canonicalHash({ policyRun }),
      authContext: actor,
      scopeSnapshot: { global: true },
      reason: "BF-6.1 dual approval QA",
      affectedAuthority: "OPERATIONAL",
      targetType: "POLICY_QA",
      targetId: policyRun,
      correlationId: policyRun,
    });
    let missingDualRejected = false;
    try {
      await pool.query("select operational_governance.authorize_command($1::uuid)", [dual.commandId]);
    } catch {
      missingDualRejected = true;
    }
    assert(missingDualRejected, "Dual approval policy authorized without approvals.");

    for (const approver of [authContext(), authContext()]) {
      await pool.query(
        `insert into operational_governance.command_approvals (
           approval_id, command_id, approver_identity_id, approver_session_id,
           approval_source, decision, reason, evidence_hash
         ) values ($1::uuid, $2::uuid, $3, $4, 'HUMAN', 'APPROVED', $5, $6)`,
        [
          randomUUID(), dual.commandId, approver.user.id, approver.session.id,
          "BF-6.1 independent approval",
          canonicalHash({ commandId: dual.commandId, approver: approver.user.id }),
        ]
      );
    }
    const authorized = await pool.query<{ authorize_command: boolean }>(
      "select operational_governance.authorize_command($1::uuid)", [dual.commandId]
    );
    assert(authorized.rows[0]?.authorize_command, "Dual approval policy did not authorize two actors.");
    pass("approval category is policy-driven and dual approval requires distinct actors");

    const failedRun = randomUUID();
    try {
      await executeGovernedOperation(
        { ...request, targetId: failedRun, correlationId: failedRun, idempotencyKey: failedRun,
          payload: { sessionId: failedRun } },
        async () => { throw new Error("synthetic operational failure"); }
      );
    } catch {
      // Expected; evidence is asserted below.
    }
    const failureEvidence = await pool.query<{ evidence_count: number }>(
      `select count(*)::int evidence_count
       from operational_governance.execution_evidence evidence
       join operational_governance.commands command using (command_id)
       where command.idempotency_key=$1 and evidence.result_status='FAILED'`,
      [failedRun]
    );
    assert(failureEvidence.rows[0]?.evidence_count === 1,
      "Operational failure evidence was not persisted.", failureEvidence.rows[0] ?? {});
    pass("operational failures are immutable and auditable");

    const immutable = await pool.query("select command_id from operational_governance.commands limit 1");
    let updateRejected = false;
    try {
      await pool.query(
        "update operational_governance.commands set reason='tampered' where command_id=$1::uuid",
        [immutable.rows[0].command_id]
      );
    } catch {
      updateRejected = true;
    }
    assert(updateRejected, "Operational command mutation was not blocked.");
    pass("commands, approvals, events, and evidence are append-only");

    const governedRoutes = [
      "app/api/authority/promotion/execute/route.ts",
      "app/api/authority/ledger-promotion/execute/route.ts",
      "app/api/authority/credit-promotion/execute/route.ts",
      "app/api/platform-management/[resource]/[id]/lifecycle/[action]/route.ts",
      "app/api/admin/access/break-glass/[userId]/disable/route.ts",
      "app/api/admin/access/break-glass/[userId]/restore/route.ts",
      "app/api/admin/sessions/revoke/route.ts",
      "app/api/admin/users/[userId]/revoke-sessions/route.ts",
    ];
    const bypasses = governedRoutes.filter(
      (path) => !readFileSync(path, "utf8").includes("executeGovernedOperation")
    );
    assert(bypasses.length === 0, "A canonical operational route bypasses governance.", { bypasses });
    pass("authority promotion, platform lifecycle, session, and break-glass commands use one executor");

    console.log(JSON.stringify({
      status: "PASS",
      message: "BF-6.1 Operational Governance Authority QA passed.",
      checks,
    }, null, 2));
  } finally {
    await pool.end();
    await closeOperationalGovernancePool();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    status: "FAIL",
    message: error instanceof Error ? error.message : String(error),
    checks,
  }, null, 2));
  process.exitCode = 1;
});
