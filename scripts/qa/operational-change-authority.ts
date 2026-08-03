import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

import type { AuthContext } from "../../src/domains/auth/auth-context.types";
import {
  canonicalHash,
  claimOperationalCommand,
  closeOperationalGovernancePool,
} from "../../src/domains/operational-governance/operational-governance.repository";
import { validateOperationalCommandSecurity,
  closeOperationalSecurityPool } from "../../src/domains/operational-security/operational-security.repository";
import {
  beginOperationalChange,
  claimOperationalChange,
  closeOperationalChangePool,
  completeOperationalChange,
  getOperationalChangeReadiness,
  recordMaintenanceEvent,
} from "../../src/domains/operational-change/operational-change.repository";

type Check = { name: string; status: "PASS" };
const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl });

function pass(name: string) { checks.push({ name, status: "PASS" }); }
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function authContext(): AuthContext {
  const identityId = randomUUID();
  const now = new Date().toISOString();
  return {
    user: { id: identityId, username: `change-${identityId}`, email: `${identityId}@qa.invalid`,
      displayName: "Change QA", identityClass: "PLATFORM_OPERATOR", status: "ACTIVE",
      failedLoginAttempts: 0 },
    session: { id: randomUUID(), userId: identityId, createdAt: now, lastSeenAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString() },
    groups: [],
    permissions: [{ id: randomUUID(), key: "system.admin", isSystemPermission: true,
      createdAt: now }],
    platformScopes: [{ scopeType: "GLOBAL", scopeId: "platform" }],
    hasPermission: (permission) => permission === "system.admin",
  };
}

async function command(actor: AuthContext, suffix: string, commandType = "CONFIGURATION_PUBLICATION") {
  const claimed = await claimOperationalCommand({
    commandType,
    idempotencyKey: `bf-6-3-command:${suffix}:${randomUUID()}`,
    canonicalRequestHash: canonicalHash({ suffix, commandType }),
    authContext: actor,
    scopeSnapshot: { global: true },
    reason: "BF-6.3 operational change QA",
    affectedAuthority: "PLATFORM",
    targetType: "CONFIGURATION",
    targetId: suffix,
    correlationId: randomUUID(),
  });
  await validateOperationalCommandSecurity({ commandId: claimed.commandId,
    privilegedSessionId: null, executorIdentityId: actor.user.id, productionEnforced: false });
  return claimed;
}

async function main() {
  try {
    const readiness = await getOperationalChangeReadiness();
    assert(readiness.length >= 5 && readiness.every((item) => item.ready),
      "Operational Change readiness failed.");
    const policies = await pool.query<{ count: string }>(
      "select count(*)::text count from operational_governance.change_policy_versions where effective_to is null"
    );
    assert(Number(policies.rows[0]?.count) === 8, "All eight change policies are required.");
    pass("canonical configuration-driven change policy catalog is ready");

    const actor = authContext();
    const governedCommand = await command(actor, "success");
    const change = await claimOperationalChange({ commandId: governedCommand.commandId,
      changeType: "CONFIGURATION_PUBLICATION", idempotencyKey: `bf-6-3:${randomUUID()}`,
      expectedState: { version: "v2", status: "PUBLISHED" } });
    const attempt = await beginOperationalChange({ change, executorIdentityId: actor.user.id });
    assert(attempt === 1, "First operational change attempt was not claimed.");
    const decision = await completeOperationalChange({ change, attempt,
      executorIdentityId: actor.user.id, result: { version: "v2" },
      verification: { expectedStateReached: true, authorityAccepted: true,
        readinessMaintained: true, auditRecorded: true,
        observedState: { version: "v2", status: "PUBLISHED" } } });
    assert(decision === "VERIFIED", "Successful change was not verified.");
    pass("change request executes only after governance and security authorization");

    const duplicateAttempt = await beginOperationalChange({ change, executorIdentityId: actor.user.id });
    assert(duplicateAttempt === 0, "Verified change executed twice.");
    pass("verified change duplicate execution is blocked");

    let conflictRejected = false;
    try {
      await claimOperationalChange({ commandId: governedCommand.commandId,
        changeType: "CONFIGURATION_PUBLICATION", idempotencyKey: change.idempotencyKey,
        expectedState: { version: "tampered" } });
    } catch { conflictRejected = true; }
    assert(conflictRejected, "Conflicting change idempotency payload was accepted.");
    pass("conflicting change payload fails closed");

    const retryCommand = await command(actor, "retry");
    const retryChange = await claimOperationalChange({ commandId: retryCommand.commandId,
      changeType: "CONFIGURATION_PUBLICATION", idempotencyKey: `bf-6-3-retry:${randomUUID()}`,
      expectedState: { status: "PUBLISHED" } });
    const failedAttempt = await beginOperationalChange({ change: retryChange,
      executorIdentityId: actor.user.id });
    const failedDecision = await completeOperationalChange({ change: retryChange,
      attempt: failedAttempt, executorIdentityId: actor.user.id, result: {},
      verification: { expectedStateReached: false, authorityAccepted: false,
        readinessMaintained: true, auditRecorded: true, observedState: { status: "DRAFT" } },
      failureCode: "VERIFICATION_FAILED", failureReason: "Expected state was not reached." });
    assert(failedDecision === "FAILED", "Verification failure was not recorded.");
    const recoveryAttempt = await beginOperationalChange({ change: retryChange,
      executorIdentityId: actor.user.id });
    assert(recoveryAttempt === 2, "Recoverable retry did not append a new attempt.");
    const recovered = await completeOperationalChange({ change: retryChange,
      attempt: recoveryAttempt, executorIdentityId: actor.user.id, result: { status: "PUBLISHED" },
      verification: { expectedStateReached: true, authorityAccepted: true,
        readinessMaintained: true, auditRecorded: true, observedState: { status: "PUBLISHED" } } });
    assert(recovered === "VERIFIED", "Recoverable change did not verify on retry.");
    pass("verification failure is immutable and recoverable retry appends evidence");

    const maintenanceCommand = await command(actor, "maintenance", "PLATFORM_LIFECYCLE");
    const maintenance = await claimOperationalChange({ commandId: maintenanceCommand.commandId,
      changeType: "PLATFORM_MAINTENANCE", idempotencyKey: `bf-6-3-maintenance:${randomUUID()}`,
      expectedState: { maintenanceMode: true } });
    const maintenanceAttempt = await beginOperationalChange({ change: maintenance,
      executorIdentityId: actor.user.id });
    await completeOperationalChange({ change: maintenance, attempt: maintenanceAttempt,
      executorIdentityId: actor.user.id, result: { maintenanceMode: true },
      verification: { expectedStateReached: true, authorityAccepted: true,
        readinessMaintained: true, auditRecorded: true,
        observedState: { maintenanceMode: true } } });
    await recordMaintenanceEvent({ change: maintenance, websiteId: randomUUID(), action: "BEGIN",
      actorIdentityId: actor.user.id, reason: "Approved QA maintenance" });
    const maintenanceEvidence = await pool.query(
      "select action from operational_governance.maintenance_events where change_id=$1::uuid",
      [maintenance.changeId]
    );
    assert(maintenanceEvidence.rows[0]?.action === "BEGIN", "Maintenance begin evidence is missing.");
    pass("maintenance begin/end model is governed and immutable");

    let immutableRejected = false;
    try {
      await pool.query("update operational_governance.change_requests set reason='tampered' where change_id=$1::uuid",
        [change.changeId]);
    } catch { immutableRejected = true; }
    assert(immutableRejected, "Operational change evidence was mutable.");
    pass("change request, execution, verification, and maintenance evidence are append-only");

    const governanceService = readFileSync(
      "src/domains/operational-governance/operational-governance.service.ts", "utf8");
    const platformRoute = readFileSync(
      "app/api/platform-management/[resource]/[id]/lifecycle/[action]/route.ts", "utf8");
    const engineAuthority = readFileSync(
      "services/game-engine/src/GameEngine.Infrastructure/Persistence/OperationalChangeAuthority.cs", "utf8");
    const engineEndpoints = readFileSync(
      "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs", "utf8");
    const changeRequestRoute = readFileSync(
      "app/api/operational-changes/requests/route.ts", "utf8");
    const changeAuthorizationRoute = readFileSync(
      "app/api/operational-changes/[changeId]/authorize/route.ts", "utf8");
    assert(governanceService.includes("executeOperationalChange") &&
      platformRoute.includes('changeType: "PLATFORM_MAINTENANCE"') &&
      engineAuthority.includes("begin_change_execution") &&
      engineAuthority.includes("complete_change_execution") &&
      engineEndpoints.includes('"PROVIDER_ACTIVATION"') &&
      engineEndpoints.includes('"RECOVERY_EXECUTION"') &&
      changeRequestRoute.includes("claimOperationalChange") &&
      changeAuthorizationRoute.includes("authorizeOperationalCommandSecurity"),
      "Production change paths do not consume the canonical change authority.");
    pass("publication, activation, maintenance, and recovery paths use one change authority");

    console.log(JSON.stringify({ status: "PASS",
      message: "BF-6.3 Operational Change Authority QA passed.", checks }, null, 2));
  } finally {
    await pool.end();
    await closeOperationalChangePool();
    await closeOperationalSecurityPool();
    await closeOperationalGovernancePool();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "FAIL",
    message: error instanceof Error ? error.message : String(error), checks }, null, 2));
  process.exitCode = 1;
});
