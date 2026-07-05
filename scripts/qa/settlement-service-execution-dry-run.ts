import { randomUUID } from "node:crypto";
import {
  evaluateFinancialAuthorityGuardrail,
} from "@/src/domains/financial-authority/financial-authority-guardrails";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

const checks: Check[] = [];
const settlementServiceUrl = trimTrailingSlash(
  process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400"
);

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function fail(message: string, metadata: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata, checks }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) fail(message, metadata);
}

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

async function readJson(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${settlementServiceUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": `qa-settlement-service-execution-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await readJson(response),
  };
}

function baseRun({
  id = `qa-settlement-exec-run-${randomUUID()}`,
  drawingId = `qa-settlement-exec-drawing-${randomUUID()}`,
  status = "running",
}: {
  id?: string;
  drawingId?: string;
  status?: string;
} = {}) {
  return {
    id,
    drawingId,
    gameId: `qa-game-${randomUUID()}`,
    status,
    expectedTicketCount: 2,
    expectedLineCount: 3,
    startedAt: new Date().toISOString(),
    completedAt: null,
    executionId: null,
    processedTicketCount: 0,
    processedLineCount: 0,
    winCount: 0,
    lossCount: 0,
    pushCount: 0,
    failedCount: 0,
    totalStake: 0,
    totalPayout: 0,
    totalNet: 0,
    durationMs: 0,
    ticketsPerSecond: 0,
    linesPerSecond: 0,
    drawToSettlementMs: 250,
    peakConcurrentSettlements: 1,
    notes: "qa:settlement-service-execution-dry-run",
    recordHash: null,
    previousHash: null,
    hashVersion: null,
    createdAt: new Date().toISOString(),
  };
}

function ticketLines(run: ReturnType<typeof baseRun>) {
  const accountId = `qa-account-${randomUUID()}`;
  const winningTicketId = `qa-ticket-${randomUUID()}`;

  return [
    {
      ticketId: winningTicketId,
      ticketLineId: "line-win",
      accountId,
      gameId: run.gameId,
      drawingId: run.drawingId,
      wagerTypeId: "qa-wager-win",
      wagerOptionId: "qa-option-win",
      stake: 100,
      payout: 250,
    },
    {
      ticketId: winningTicketId,
      ticketLineId: "line-loss",
      accountId,
      gameId: run.gameId,
      drawingId: run.drawingId,
      wagerTypeId: "qa-wager-loss",
      wagerOptionId: "qa-option-loss",
      stake: 100,
      payout: 0,
    },
    {
      ticketId: `qa-ticket-${randomUUID()}`,
      ticketLineId: "line-push",
      accountId,
      gameId: run.gameId,
      drawingId: run.drawingId,
      wagerTypeId: "qa-wager-push",
      wagerOptionId: "qa-option-push",
      stake: 50,
      payout: 50,
    },
  ];
}

async function verifyHealth() {
  const result = await request("/health/ready");

  assert(result.response.ok, "Settlement Service readiness should pass.", {
    status: result.response.status,
    body: result.body,
  });
  assert(result.body?.capabilities?.durablePersistenceConfigured === true, "Durable persistence marker should be enabled.", {
    body: result.body,
  });
  assert(result.body?.capabilities?.mutationCapabilityEnabled === false, "Production mutation capability must remain disabled.", {
    body: result.body,
  });
  assert(
    ["executionDryRunOnly", "integrationDryRunOnly"].includes(result.body?.capabilities?.idempotencySupportScope),
    "Idempotency scope should advertise execution dry run capability.",
    { body: result.body }
  );
  assert(
    ["settlement-service-execution-dry-run", "settlement-service-integration-dry-run"].includes(result.body?.capabilities?.qaCapabilityMarker),
    "QA marker should advertise settlement execution dry run capability.",
    { body: result.body }
  );
  pass("Settlement Service health reports durable execution dry-run markers");
}

async function createRun(payload: Record<string, unknown>) {
  return request("/v1/settlement/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function executeRun(runId: string, body: Record<string, unknown>) {
  return request(`/v1/settlement/runs/${encodeURIComponent(runId)}/execute`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function verifyExecutionDryRun() {
  const run = baseRun();
  const created = await createRun(run);
  assert(created.response.ok && created.body?.run?.id === run.id, "Create run before execution should persist.", {
    status: created.response.status,
    body: created.body,
  });
  pass("create run then execute setup persists", { runId: run.id });

  const executionBody = {
    executionId: `qa-execution-${run.id}`,
    ticketLines: ticketLines(run),
  };
  const executed = await executeRun(run.id, executionBody);

  assert(executed.response.ok, "Execution dry run should return 200.", {
    status: executed.response.status,
    body: executed.body,
  });
  assert(executed.body?.executionMode === "DRY_RUN", "Execution mode should be DRY_RUN.", {
    body: executed.body,
  });
  assert(executed.body?.authoritativeLedgerPosted === false, "Execution must not post authoritative ledger entries.", {
    body: executed.body,
  });
  assert(executed.body?.creditSettlementApplied === false, "Execution must not apply credit settlement.", {
    body: executed.body,
  });
  assert(Array.isArray(executed.body?.records) && executed.body.records.length === 3, "Execution should create three settlement records.", {
    body: executed.body,
  });
  assert(
    Array.isArray(executed.body?.ledgerEffects) && executed.body.ledgerEffects.length === 3,
    "Execution should create three internal ledger effects.",
    { body: executed.body }
  );
  assert(executed.body?.run?.status === "completed", "Execution should update the durable run summary.", {
    body: executed.body,
  });
  pass("execution creates records", { runId: run.id });
  pass("execution creates ledger effects", { runId: run.id });

  const duplicate = await executeRun(run.id, executionBody);
  assert(duplicate.response.ok, "Duplicate execution should be idempotent.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });

  const firstRecordIds = executed.body.records.map((record: { id: string }) => record.id).sort();
  const duplicateRecordIds = duplicate.body.records.map((record: { id: string }) => record.id).sort();
  const firstEffectKeys = executed.body.ledgerEffects.map((effect: { idempotencyKey: string }) => effect.idempotencyKey).sort();
  const duplicateEffectKeys = duplicate.body.ledgerEffects.map((effect: { idempotencyKey: string }) => effect.idempotencyKey).sort();
  assert(JSON.stringify(firstRecordIds) === JSON.stringify(duplicateRecordIds), "Duplicate execution should return the same records.", {
    firstRecordIds,
    duplicateRecordIds,
  });
  assert(JSON.stringify(firstEffectKeys) === JSON.stringify(duplicateEffectKeys), "Duplicate execution should return the same ledger effects.", {
    firstEffectKeys,
    duplicateEffectKeys,
  });
  pass("duplicate execute is idempotent", { runId: run.id });

  const records = await request(`/v1/settlement/runs/${run.id}/records`);
  assert(
    records.response.ok && Array.isArray(records.body?.records) && records.body.records.length >= 3,
    "Records remain queryable after execution.",
    { body: records.body }
  );

  return run.id;
}

async function verifyRecoveryStateQueryable() {
  const recoveryRun = baseRun({ status: "recovering" });
  const created = await createRun({
    ...recoveryRun,
    notes: "qa:settlement-service-execution-dry-run recovery state",
  });
  assert(created.response.ok, "Recovering run should persist.", {
    status: created.response.status,
    body: created.body,
  });

  const incomplete = await request("/v1/settlement/runs/incomplete");
  assert(
    incomplete.response.ok &&
      Array.isArray(incomplete.body?.runs) &&
      incomplete.body.runs.some((item: { id: string; status: string }) => item.id === recoveryRun.id && item.status === "recovering"),
    "Incomplete/recovery run lookup should include recovering run.",
    { body: incomplete.body }
  );
  pass("incomplete/failed run recovery state remains queryable", { runId: recoveryRun.id });
}

function verifySettlementAuthorityRemainsMonolith() {
  const authority = String(process.env.SETTLEMENT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "SETTLEMENT_AUTHORITY must not be SERVICE in execution dry-run QA.", {
    authority,
  });

  const guardrail = evaluateFinancialAuthorityGuardrail({
    config: {
      domain: "SETTLEMENT",
      authority: "MONOLITH",
      comparisonMode: "ENABLED",
      mismatchAlertThreshold: 0.001,
      serviceUrl: settlementServiceUrl,
    },
    serviceReachable: true,
    readinessHealthy: true,
    mutationCapabilityEnabled: false,
    durablePersistenceConfigured: true,
    idempotencySupportConfigured: true,
    qaCapabilityMarkerPresent: true,
  });

  assert(guardrail.productionStatus === "MONOLITH_ALLOWED", "Settlement guardrail should keep MONOLITH allowed.", {
    guardrail,
  });
  assert(!guardrail.productionReady, "Settlement Service execution dry run must not report production-ready authority.", {
    guardrail,
  });
  pass("guardrails still keep SETTLEMENT authority MONOLITH");
}

async function main() {
  await verifyHealth();
  await verifyExecutionDryRun();
  await verifyRecoveryStateQueryable();
  verifySettlementAuthorityRemainsMonolith();

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Settlement Service execution dry-run QA failed.");
});
