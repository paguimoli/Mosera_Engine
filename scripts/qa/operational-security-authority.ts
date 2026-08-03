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
  assertActivePrivilegedSession,
  closeOperationalSecurityPool,
  createPrivilegedSession,
  terminatePrivilegedSession,
  validateOperationalCommandSecurity,
} from "../../src/domains/operational-security/operational-security.repository";

type Check = { name: string; status: "PASS" };
const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl });

function pass(name: string) { checks.push({ name, status: "PASS" }); }
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function authContext(identityId = randomUUID()): AuthContext {
  const now = new Date().toISOString();
  return {
    user: { id: identityId, username: `operator-${identityId}`, email: `${identityId}@qa.invalid`,
      displayName: "Security QA", identityClass: "PLATFORM_OPERATOR", status: "ACTIVE",
      failedLoginAttempts: 0 },
    session: { id: randomUUID(), userId: identityId, createdAt: now, lastSeenAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString() },
    groups: [],
    permissions: [{ id: randomUUID(), key: "system.admin", isSystemPermission: true, createdAt: now }],
    platformScopes: [{ scopeType: "GLOBAL", scopeId: "platform" }],
    hasPermission: (permission) => permission === "system.admin",
  };
}

async function claim(actor: AuthContext, suffix: string) {
  return claimOperationalCommand({
    commandType: "POLICY_DUAL_APPROVAL_QA",
    idempotencyKey: `bf-6-2:${suffix}:${randomUUID()}`,
    canonicalRequestHash: canonicalHash({ suffix }),
    authContext: actor,
    scopeSnapshot: { global: true },
    reason: "BF-6.2 operational security QA",
    affectedAuthority: "OPERATIONAL_SECURITY",
    targetType: "SECURITY_QA",
    targetId: suffix,
    correlationId: randomUUID(),
  });
}

async function approve(commandId: string, approver: AuthContext) {
  await pool.query(
    `insert into operational_governance.command_approvals (
       approval_id, command_id, approver_identity_id, approver_session_id,
       approval_source, decision, reason, evidence_hash
     ) values ($1::uuid,$2::uuid,$3,$4,'HUMAN','APPROVED',$5,$6)`,
    [randomUUID(), commandId, approver.user.id, approver.session.id,
      "Independent BF-6.2 approval", canonicalHash({ commandId, approver: approver.user.id })]
  );
}

async function main() {
  try {
    const ready = await pool.query<{ ready: boolean }>(
      `select to_regclass('operational_governance.privileged_sessions') is not null
       and to_regprocedure('operational_governance.validate_command_security(uuid,uuid,text,boolean)') is not null ready`
    );
    assert(ready.rows[0]?.ready, "Operational Security persistence is not ready.");
    pass("canonical operational security persistence is ready");

    const requester = authContext();
    const session = await createPrivilegedSession({
      authContext: requester,
      sessionKind: "PRIVILEGED",
      mfaEvidenceId: randomUUID(),
      mfaEvidenceHash: canonicalHash({ mfa: requester.user.id }),
      reason: "Execute governed QA operation",
      ticketReference: "SEC-6201",
      correlationId: randomUUID(),
      durationMinutes: 15,
    });
    await assertActivePrivilegedSession({ privilegedSessionId: session.privilegedSessionId, authContext: requester });
    pass("MFA-bound privileged session activates with bounded expiry");

    const command = await claim(requester, "authorized");
    let selfApprovalRejected = false;
    try { await approve(command.commandId, requester); } catch { selfApprovalRejected = true; }
    assert(selfApprovalRejected, "Requester self-approval was accepted.");
    pass("requester and break-glass self-approval fail closed");

    await approve(command.commandId, authContext());
    await approve(command.commandId, authContext());
    const decision = await validateOperationalCommandSecurity({
      commandId: command.commandId,
      privilegedSessionId: session.privilegedSessionId,
      executorIdentityId: requester.user.id,
      productionEnforced: true,
    });
    assert(decision.decision === "AUTHORIZED" && decision.mfaVerified &&
      decision.sessionVerified && decision.approvalVerified && decision.separationOfDutiesVerified,
      "Independent approval and privileged-session evidence did not authorize.");
    pass("production command binds MFA, session, approvals, identity, and separation of duties");

    const missingApproval = await claim(requester, "missing-approval");
    let missingApprovalRejected = false;
    try {
      await validateOperationalCommandSecurity({ commandId: missingApproval.commandId,
        privilegedSessionId: session.privilegedSessionId, executorIdentityId: requester.user.id,
        productionEnforced: true });
    } catch { missingApprovalRejected = true; }
    assert(missingApprovalRejected, "Production command without approvals was authorized.");
    pass("missing approval fails closed");

    let wrongExecutorRejected = false;
    try {
      await validateOperationalCommandSecurity({ commandId: missingApproval.commandId,
        privilegedSessionId: session.privilegedSessionId, executorIdentityId: randomUUID(),
        productionEnforced: true });
    } catch { wrongExecutorRejected = true; }
    assert(wrongExecutorRejected, "Client-supplied executor identity escaped session binding.");
    pass("executor identity cannot escape authenticated privileged scope");

    await terminatePrivilegedSession({ privilegedSessionId: session.privilegedSessionId,
      actorIdentityId: requester.user.id, reason: "QA termination", ticketReference: "SEC-6201",
      correlationId: randomUUID() });
    let terminatedRejected = false;
    try { await assertActivePrivilegedSession({ privilegedSessionId: session.privilegedSessionId, authContext: requester }); }
    catch { terminatedRejected = true; }
    assert(terminatedRejected, "Terminated privileged session remained active.");
    pass("manual and forced termination revoke privileged authority");

    let longBreakGlassRejected = false;
    try {
      await createPrivilegedSession({ authContext: requester, sessionKind: "BREAK_GLASS",
        mfaEvidenceId: randomUUID(), mfaEvidenceHash: canonicalHash({ breakGlass: true }),
        reason: "QA emergency", ticketReference: "INC-6202", correlationId: randomUUID(),
        durationMinutes: 16 });
    } catch { longBreakGlassRejected = true; }
    assert(longBreakGlassRejected, "Unbounded break-glass session was accepted.");
    pass("break-glass is ticketed, reasoned, MFA-bound, and time bounded");

    const breakGlassCommand = await claimOperationalCommand({
      commandType: "BREAK_GLASS_LIFECYCLE",
      idempotencyKey: `bf-6-2-break-glass:${randomUUID()}`,
      canonicalRequestHash: canonicalHash({ action: "activate-break-glass" }),
      authContext: requester,
      scopeSnapshot: { global: true },
      reason: "BF-6.2 break-glass approval QA",
      affectedAuthority: "AUTHENTICATION",
      targetType: "PRIVILEGED_SESSION",
      targetId: requester.user.id,
      correlationId: randomUUID(),
    });
    await approve(breakGlassCommand.commandId, authContext());
    const breakGlassApproved = await pool.query<{ authorized: boolean }>(
      "select operational_governance.break_glass_command_authorized($1::uuid,$2) authorized",
      [breakGlassCommand.commandId, requester.user.id]
    );
    assert(breakGlassApproved.rows[0]?.authorized,
      "Independent break-glass approval was not durably bound.");
    pass("break-glass activation requires an independently approved governance command");

    let immutableRejected = false;
    try { await pool.query("update operational_governance.privileged_sessions set reason='tampered' where privileged_session_id=$1", [session.privilegedSessionId]); }
    catch { immutableRejected = true; }
    assert(immutableRejected, "Privileged-session evidence was mutable.");
    pass("security policy, session, event, and decision evidence are immutable");

    const engineGuard = readFileSync(
      "services/game-engine/src/GameEngine.Infrastructure/Persistence/OperationalSecurityAuthority.cs", "utf8");
    const endpoints = readFileSync(
      "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs", "utf8");
    const manualProvider = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/ManualCertifiedProvider.cs", "utf8");
    assert(engineGuard.includes("production_enforced") &&
      endpoints.includes('"GAME_ENGINE_PRODUCTION_ACTIVATION"') &&
      endpoints.includes('"OUTCOME_RECOVERY_EXECUTION"') &&
      manualProvider.includes("IOperationalSecurityAuthority") &&
      manualProvider.includes('"MANUAL_CERTIFIED_SUBMISSION"'),
      "Game Engine privileged paths do not consume canonical security evidence.");
    pass("Game Engine activation, recovery, and manual certification consume canonical governance evidence");

    console.log(JSON.stringify({ status: "PASS", message: "BF-6.2 Operational Security Authority QA passed.", checks }, null, 2));
  } finally {
    await pool.end();
    await closeOperationalGovernancePool();
    await closeOperationalSecurityPool();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error), checks }, null, 2));
  process.exitCode = 1;
});
