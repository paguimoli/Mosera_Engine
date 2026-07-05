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
      "x-correlation-id": `qa-settlement-service-durable-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await readJson(response),
  };
}

function baseRun({
  id = `qa-settlement-service-run-${randomUUID()}`,
  drawingId = `qa-settlement-drawing-${randomUUID()}`,
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
    expectedTicketCount: 1,
    expectedLineCount: 1,
    startedAt: new Date().toISOString(),
    completedAt: status === "completed" ? new Date().toISOString() : null,
    executionId: `qa-execution-${randomUUID()}`,
    processedTicketCount: status === "completed" ? 1 : 0,
    processedLineCount: status === "completed" ? 1 : 0,
    winCount: status === "completed" ? 1 : 0,
    lossCount: 0,
    pushCount: 0,
    failedCount: 0,
    totalStake: 100,
    totalPayout: status === "completed" ? 250 : 0,
    totalNet: status === "completed" ? 150 : 0,
    durationMs: status === "completed" ? 25 : 0,
    ticketsPerSecond: 1,
    linesPerSecond: 1,
    drawToSettlementMs: 500,
    peakConcurrentSettlements: 1,
    notes: "qa:settlement-service-durable-baseline",
    recordHash: null,
    previousHash: null,
    hashVersion: null,
    createdAt: new Date().toISOString(),
  };
}

function recordPayload(run: ReturnType<typeof baseRun>, id = `qa-settlement-record-${randomUUID()}`) {
  return {
    id,
    ticketId: `qa-ticket-${randomUUID()}`,
    ticketLineId: `qa-ticket-line-${randomUUID()}`,
    accountId: `qa-account-${randomUUID()}`,
    gameId: run.gameId,
    drawingId: run.drawingId,
    wagerTypeId: "qa-wager-type",
    wagerOptionId: null,
    stake: 100,
    payout: 250,
    netAmount: 150,
    outcome: "win",
    status: "settled",
    version: 1,
    previousSettlementRecordId: null,
    reversalOfSettlementRecordId: null,
    ledgerTransactionIds: [],
    recordHash: null,
    previousHash: null,
    hashVersion: null,
    createdAt: new Date().toISOString(),
  };
}

function ledgerEffectPayload(run: ReturnType<typeof baseRun>, record: ReturnType<typeof recordPayload>) {
  return {
    id: `qa-settlement-ledger-effect-${randomUUID()}`,
    settlementRecordId: record.id,
    ticketId: record.ticketId,
    ticketLineId: record.ticketLineId,
    drawingId: record.drawingId,
    accountId: record.accountId,
    effectType: "WIN_PAYOUT",
    transactionType: "SETTLEMENT_CREDIT",
    direction: "CREDIT",
    amount: 250,
    idempotencyKey: `qa-settlement-effect:${run.id}:${record.id}`,
    postingStatus: "READY",
    referenceType: "settlement_record",
    referenceId: record.id,
    reversalOfLedgerEffectId: null,
    metadata: { qa: "settlement-service-durable-baseline" },
    createdAt: new Date().toISOString(),
  };
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
  assert(result.body?.capabilities?.mutationCapabilityEnabled === false, "Mutation capability must remain disabled.", {
    body: result.body,
  });
  assert(result.body?.capabilities?.idempotencySupportConfigured === true, "Persistence idempotency marker should be enabled.", {
    body: result.body,
  });
  assert(result.body?.capabilities?.qaCapabilityMarkerPresent === true, "QA capability marker should be present.", {
    body: result.body,
  });
  pass("Settlement Service health reports durable persistence baseline markers");
}

async function createRun(payload: Record<string, unknown>) {
  return request("/v1/settlement/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function verifyRunPersistence() {
  const run = baseRun();
  const result = await createRun(run);

  assert(result.response.ok, "Create run should persist.", {
    status: result.response.status,
    body: result.body,
  });
  assert(result.body?.run?.id === run.id, "Create run should return the persisted run.", {
    body: result.body,
  });

  const fetched = await request(`/v1/settlement/runs/${run.id}`);
  assert(fetched.response.ok && fetched.body?.run?.id === run.id, "Get run by id should return persisted run.", {
    status: fetched.response.status,
    body: fetched.body,
  });

  const listed = await request(`/v1/settlement/runs?drawingId=${encodeURIComponent(run.drawingId)}`);
  assert(
    listed.response.ok &&
      Array.isArray(listed.body?.runs) &&
      listed.body.runs.some((item: { id: string }) => item.id === run.id),
    "List runs by drawing should include persisted run.",
    { body: listed.body }
  );

  pass("create run persists", { runId: run.id });
  return run;
}

async function verifyDuplicateCompletedRun() {
  const drawingId = `qa-settlement-completed-drawing-${randomUUID()}`;
  const firstRun = baseRun({ drawingId, status: "completed" });
  const first = await createRun(firstRun);
  const duplicateSameId = await createRun(firstRun);
  const duplicateScope = await createRun(baseRun({ drawingId, status: "completed" }));

  assert(first.response.ok, "Initial completed run should persist.", { body: first.body });
  assert(duplicateSameId.response.ok && duplicateSameId.body?.run?.id === firstRun.id, "Duplicate completed run by id should be idempotent.", {
    body: duplicateSameId.body,
  });
  assert(duplicateScope.response.status === 409, "Duplicate completed run by drawing should be blocked.", {
    status: duplicateScope.response.status,
    body: duplicateScope.body,
  });
  pass("duplicate completed run blocked/idempotent", { runId: firstRun.id });
}

async function verifyRecordsAndEffects() {
  const run = baseRun({ status: "completed" });
  const record = recordPayload(run);
  const effect = ledgerEffectPayload(run, record);
  const result = await createRun({
    ...run,
    records: [record],
    ledgerEffects: [effect],
  });

  assert(result.response.ok, "Create run with record/effect should persist.", {
    status: result.response.status,
    body: result.body,
  });
  assert(result.body?.records?.[0]?.id === record.id, "Create record should return persisted record.", {
    body: result.body,
  });
  assert(result.body?.ledgerEffects?.[0]?.idempotencyKey === effect.idempotencyKey, "Ledger effect persistence should return persisted effect.", {
    body: result.body,
  });

  const records = await request(`/v1/settlement/runs/${run.id}/records`);
  assert(
    records.response.ok &&
      Array.isArray(records.body?.records) &&
      records.body.records.some((item: { id: string }) => item.id === record.id),
    "List records by run should include persisted record.",
    { body: records.body }
  );

  const duplicateSameRecord = await createRun({
    ...run,
    records: [record],
    ledgerEffects: [effect],
  });
  assert(duplicateSameRecord.response.ok, "Duplicate record/effect by id/idempotency should be idempotent.", {
    body: duplicateSameRecord.body,
  });

  const duplicateScopeRecord = {
    ...record,
    id: `qa-settlement-record-${randomUUID()}`,
  };
  const duplicateScope = await createRun({
    ...run,
    records: [duplicateScopeRecord],
  });
  assert(duplicateScope.response.status === 409, "Duplicate completed ticket/draw/line should be blocked.", {
    status: duplicateScope.response.status,
    body: duplicateScope.body,
  });

  pass("create record persists", { recordId: record.id });
  pass("duplicate completed ticket/draw/line blocked/idempotent", { recordId: record.id });
  pass("ledger effect persistence works", { idempotencyKey: effect.idempotencyKey });
}

async function verifyIncompleteLookup(runId: string) {
  const result = await request("/v1/settlement/runs/incomplete");

  assert(
    result.response.ok &&
      Array.isArray(result.body?.runs) &&
      result.body.runs.some((item: { id: string }) => item.id === runId),
    "Incomplete run lookup should include running run.",
    { body: result.body }
  );
  pass("incomplete run lookup works", { runId });
}

function verifySettlementAuthorityRemainsMonolith() {
  const authority = String(process.env.SETTLEMENT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "SETTLEMENT_AUTHORITY must not be SERVICE in durable baseline QA.", {
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
  assert(!guardrail.productionReady, "Settlement Service durable baseline must not report production-ready authority.", {
    guardrail,
  });
  pass("guardrails still keep SETTLEMENT authority MONOLITH");
}

async function main() {
  await verifyHealth();
  const runningRun = await verifyRunPersistence();
  await verifyDuplicateCompletedRun();
  await verifyRecordsAndEffects();
  await verifyIncompleteLookup(runningRun.id);
  verifySettlementAuthorityRemainsMonolith();

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Settlement Service durable baseline QA failed.");
});
