import { randomUUID } from "node:crypto";
import type { SettlementExecutionInput } from "@/src/domains/settlement/settlement-executor.service";
import {
  evaluateSettlementServiceAuthorityEvidenceFromHealth,
  getSettlementServiceAuthorityEvidence,
  SettlementServiceAuthorityError,
} from "@/src/domains/settlement/settlement-service-client";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

const checks: Check[] = [];
const originalSettlementAuthority = process.env.SETTLEMENT_AUTHORITY;
const originalSettlementServiceUrl = process.env.SETTLEMENT_SERVICE_URL;
const originalLedgerAuthority = process.env.LEDGER_AUTHORITY;
const originalCreditAuthority = process.env.CREDIT_AUTHORITY;

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

function restoreEnvironment() {
  if (originalSettlementAuthority === undefined) {
    delete process.env.SETTLEMENT_AUTHORITY;
  } else {
    process.env.SETTLEMENT_AUTHORITY = originalSettlementAuthority;
  }

  if (originalSettlementServiceUrl === undefined) {
    delete process.env.SETTLEMENT_SERVICE_URL;
  } else {
    process.env.SETTLEMENT_SERVICE_URL = originalSettlementServiceUrl;
  }

  if (originalLedgerAuthority === undefined) {
    delete process.env.LEDGER_AUTHORITY;
  } else {
    process.env.LEDGER_AUTHORITY = originalLedgerAuthority;
  }

  if (originalCreditAuthority === undefined) {
    delete process.env.CREDIT_AUTHORITY;
  } else {
    process.env.CREDIT_AUTHORITY = originalCreditAuthority;
  }
}

function buildSettlementInput(label: string): SettlementExecutionInput {
  const suffix = randomUUID();
  const drawingId = `qa-settlement-authority-${label}-drawing-${suffix}`;
  const gameId = `qa-settlement-authority-${label}-game`;
  const ticketId = `qa-settlement-authority-${label}-ticket-${suffix}`;
  const ticketLineId = `qa-settlement-authority-${label}-line-${suffix}`;
  const runId = `qa-settlement-authority-${label}-run-${suffix}`;
  const createdAt = new Date().toISOString();

  return {
    settlementRun: {
      id: runId,
      drawingId,
      gameId,
      status: "pending",
      expectedTicketCount: 1,
      expectedLineCount: 1,
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
      peakConcurrentSettlements: 0,
      notes: "qa:settlement-authority-switch",
      createdAt,
    },
    drawingId,
    gameId,
    tickets: [
      {
        id: ticketId,
        ticketNumber: `QA-${suffix.slice(0, 8)}`,
        accountId: randomUUID(),
        gameId,
        drawingId,
        totalStake: 10,
        potentialPayout: 25,
        fundingType: "cash",
        status: "accepted",
        createdAt,
        acceptedAt: createdAt,
        ledgerTransactionIds: [],
      },
    ],
    ticketLines: [
      {
        id: ticketLineId,
        ticketId,
        wagerTypeId: "qa-authority-switch-wager",
        stake: 10,
        potentialPayout: 25,
        status: "pending",
        resultAmount: 25,
        createdAt,
      },
    ],
    wagerTypes: [],
    wagerOptions: [],
    payTableRows: [],
    winningNumbers: [1, 2, 3],
    executionId: `qa-settlement-authority-${label}-execution-${suffix}`,
  };
}

async function importSettlementEntryPoints() {
  process.env.SUPABASE_URL ??= "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy-service-role-key";

  return import("@/src/domains/settlement/settlement.entrypoints");
}

async function verifyMonolithMode() {
  process.env.SETTLEMENT_AUTHORITY = "MONOLITH";
  process.env.SETTLEMENT_SERVICE_URL = "http://127.0.0.1:1";

  const settlement = await importSettlementEntryPoints();
  const result = await settlement.executeSettlement(buildSettlementInput("monolith"));

  assert(result.summary.settlementRunId.includes("monolith"), "MONOLITH execution should use local run id.", {
    summary: result.summary,
  });
  assert(result.settlementRecords.length === 1, "MONOLITH execution should produce one local record.", {
    records: result.settlementRecords,
  });
  pass("MONOLITH mode uses monolith path", { settlementRunId: result.summary.settlementRunId });
}

async function verifyServiceModeAndIdempotency() {
  process.env.SETTLEMENT_AUTHORITY = "SERVICE";
  process.env.SETTLEMENT_SERVICE_URL =
    originalSettlementServiceUrl ?? "http://settlement-service:8080";

  const settlement = await importSettlementEntryPoints();
  const input = buildSettlementInput("service");
  const first = await settlement.executeSettlement(input);
  const duplicate = await settlement.executeSettlement(input);

  assert(first.summary.settlementRunId === input.settlementRun.id, "SERVICE execution should preserve run id.", {
    first: first.summary,
    inputRunId: input.settlementRun.id,
  });
  assert(first.settlementRecords.length === 1, "SERVICE execution should return one persisted record.", {
    records: first.settlementRecords,
  });
  assert(
    duplicate.settlementRecords.map((record) => record.id).join(",") ===
      first.settlementRecords.map((record) => record.id).join(","),
    "Duplicate SERVICE execution should return the same persisted record ids.",
    { first: first.settlementRecords, duplicate: duplicate.settlementRecords }
  );
  pass("SERVICE mode uses Settlement Service path", { settlementRunId: first.summary.settlementRunId });
  pass("duplicate execution remains idempotent", { settlementRunId: first.summary.settlementRunId });
}

async function verifyMissingReadinessFailsClosed() {
  process.env.SETTLEMENT_AUTHORITY = "SERVICE";
  process.env.SETTLEMENT_SERVICE_URL = "http://127.0.0.1:1";

  const settlement = await importSettlementEntryPoints();

  try {
    await settlement.executeSettlement(buildSettlementInput("missing-readiness"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    assert(
      error instanceof SettlementServiceAuthorityError ||
        message.includes("Settlement Service authority guardrails failed") ||
        message.includes("Settlement Service is not reachable"),
      "Missing Settlement Service readiness should fail closed with guardrail error.",
      { message }
    );
    pass("missing readiness fails closed");
    return;
  }

  fail("Missing Settlement Service readiness should not execute settlement.");
}

function verifyMissingCapabilityFailsClosed() {
  const evidence = evaluateSettlementServiceAuthorityEvidenceFromHealth({
    responseOk: true,
    body: {
      capabilities: {
        durablePersistenceConfigured: true,
        idempotencySupportConfigured: true,
        qaCapabilityMarkerPresent: true,
        executionCapabilityPresent: true,
        integrationDryRunCapabilityPresent: true,
        recoveryResumeCapabilityPresent: true,
        resettlementCapabilityPresent: false,
        qaCapabilityMarkers: ["settlement-service-authority-switch"],
      },
    },
  });

  assert(evidence.blockers.some((blocker) => blocker.includes("resettlement")), "Missing capability should fail closed.", {
    evidence,
  });
  pass("unsupported/missing capability fails closed");
}

async function verifyRollbackToMonolith() {
  process.env.SETTLEMENT_AUTHORITY = "MONOLITH";
  process.env.SETTLEMENT_SERVICE_URL = "http://127.0.0.1:1";

  const settlement = await importSettlementEntryPoints();
  const result = await settlement.executeSettlement(buildSettlementInput("rollback"));

  assert(result.summary.settlementRunId.includes("rollback"), "Rollback should restore monolith execution.", {
    summary: result.summary,
  });
  pass("rollback to MONOLITH works", { settlementRunId: result.summary.settlementRunId });
}

async function verifyServiceAllowedOnlyWithAllMarkers() {
  process.env.SETTLEMENT_SERVICE_URL =
    originalSettlementServiceUrl ?? "http://settlement-service:8080";

  const evidence = await getSettlementServiceAuthorityEvidence();

  assert(evidence.ready, "Settlement Service readiness should be healthy.", { evidence });
  assert(evidence.blockers.length === 0, "Settlement Service should be allowed only when all markers are present.", {
    evidence,
  });
  assert(evidence.capabilities.durablePersistenceConfigured, "Durable persistence marker should be present.", {
    evidence,
  });
  assert(evidence.capabilities.executionCapabilityPresent, "Execution marker should be present.", { evidence });
  assert(evidence.capabilities.integrationDryRunCapabilityPresent, "Integration dry-run marker should be present.", {
    evidence,
  });
  assert(evidence.capabilities.recoveryResumeCapabilityPresent, "Recovery/resume marker should be present.", {
    evidence,
  });
  assert(evidence.capabilities.resettlementCapabilityPresent, "Resettlement marker should be present.", { evidence });
  assert(evidence.capabilities.idempotencySupportConfigured, "Idempotency marker should be present.", { evidence });
  assert(
    evidence.capabilities.qaCapabilityMarkers.includes("settlement-service-authority-switch"),
    "Authority switch QA marker should be present.",
    { evidence }
  );
  pass("guardrails report SERVICE allowed only when all markers are present");
}

async function main() {
  try {
    await verifyMonolithMode();
    await verifyServiceModeAndIdempotency();
    await verifyMissingReadinessFailsClosed();
    verifyMissingCapabilityFailsClosed();
    await verifyRollbackToMonolith();
    await verifyServiceAllowedOnlyWithAllMarkers();

    assert(
      process.env.LEDGER_AUTHORITY === originalLedgerAuthority,
      "Settlement authority switch QA must not change Ledger authority.",
      { ledgerAuthority: process.env.LEDGER_AUTHORITY ?? null }
    );
    assert(
      process.env.CREDIT_AUTHORITY === originalCreditAuthority,
      "Settlement authority switch QA must not change Credit authority.",
      { creditAuthority: process.env.CREDIT_AUTHORITY ?? null }
    );
    pass("Ledger and Credit authority defaults remain unchanged");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    restoreEnvironment();
  }
}

main().catch((error: unknown) => {
  restoreEnvironment();
  fail("Settlement authority switch QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
