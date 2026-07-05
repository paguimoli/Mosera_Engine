import type {
  SettlementExecutionInput,
  SettlementExecutionResult,
} from "./settlement-executor.service";
import { executeSettlementRun } from "./settlement-executor.service";

const SETTLEMENT_SERVICE_TIMEOUT_MS = 2_000;
const REQUIRED_QA_MARKER = "settlement-service-authority-switch";

type SettlementServiceCapabilities = {
  durablePersistenceConfigured: boolean;
  mutationCapabilityEnabled: boolean;
  idempotencySupportConfigured: boolean;
  idempotencySupportScope: string;
  qaCapabilityMarkerPresent: boolean;
  qaCapabilityMarker: string | null;
  executionCapabilityPresent: boolean;
  integrationDryRunCapabilityPresent: boolean;
  recoveryResumeCapabilityPresent: boolean;
  resettlementCapabilityPresent: boolean;
  qaCapabilityMarkers: string[];
};

type SettlementHealthDto = {
  status?: string;
  capabilities?: Partial<SettlementServiceCapabilities>;
};

type SettlementRunDto = {
  id: string;
  drawingId: string;
  gameId: string;
  status: string;
  expectedTicketCount: number;
  expectedLineCount: number;
  processedTicketCount: number;
  processedLineCount: number;
  winCount: number;
  lossCount: number;
  pushCount: number;
  failedCount: number;
  totalStake: number;
  totalPayout: number;
  totalNet: number;
  startedAt?: string | null;
  completedAt?: string | null;
  executionId?: string | null;
  durationMs: number;
  ticketsPerSecond: number;
  linesPerSecond: number;
  drawToSettlementMs?: number | null;
  peakConcurrentSettlements: number;
};

type SettlementRecordDto = {
  id: string;
  settlementRunId: string;
  ticketId: string;
  ticketLineId: string;
  accountId: string;
  gameId: string;
  drawingId: string;
  wagerTypeId: string;
  wagerOptionId?: string | null;
  stake: number;
  payout: number;
  netAmount: number;
  outcome: "win" | "loss" | "push" | "void" | "failed";
  status: "pending" | "settled" | "reversed" | "failed" | "void";
  version: number;
  previousSettlementRecordId?: string | null;
  reversalOfSettlementRecordId?: string | null;
  ledgerTransactionIds?: string[];
  recordHash?: string | null;
  previousHash?: string | null;
  hashVersion?: string | null;
  createdAt: string;
};

type SettlementExecutionResponseDto = {
  run: SettlementRunDto;
  records: SettlementRecordDto[];
};

export type SettlementServiceAuthorityEvidence = {
  reachable: boolean;
  ready: boolean;
  capabilities: SettlementServiceCapabilities;
  blockers: string[];
};

export class SettlementServiceAuthorityError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Settlement Service authority guardrails failed: ${blockers.join(" ")}`);
    this.name = "SettlementServiceAuthorityError";
    this.blockers = blockers;
  }
}

export class SettlementServiceClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementServiceClientError";
  }
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getSettlementServiceUrl() {
  return trimTrailingSlash(
    process.env.SETTLEMENT_SERVICE_URL?.trim() || "http://settlement-service:8080"
  );
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SETTLEMENT_SERVICE_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function defaultCapabilities(): SettlementServiceCapabilities {
  return {
    durablePersistenceConfigured: false,
    mutationCapabilityEnabled: false,
    idempotencySupportConfigured: false,
    idempotencySupportScope: "none",
    qaCapabilityMarkerPresent: false,
    qaCapabilityMarker: null,
    executionCapabilityPresent: false,
    integrationDryRunCapabilityPresent: false,
    recoveryResumeCapabilityPresent: false,
    resettlementCapabilityPresent: false,
    qaCapabilityMarkers: [],
  };
}

function capabilityEvidence(body: unknown): SettlementServiceCapabilities {
  const capabilities =
    typeof body === "object" && body !== null && "capabilities" in body
      ? ((body as SettlementHealthDto).capabilities ?? {})
      : {};

  return {
    durablePersistenceConfigured: capabilities.durablePersistenceConfigured === true,
    mutationCapabilityEnabled: capabilities.mutationCapabilityEnabled === true,
    idempotencySupportConfigured: capabilities.idempotencySupportConfigured === true,
    idempotencySupportScope:
      typeof capabilities.idempotencySupportScope === "string"
        ? capabilities.idempotencySupportScope
        : "none",
    qaCapabilityMarkerPresent: capabilities.qaCapabilityMarkerPresent === true,
    qaCapabilityMarker:
      typeof capabilities.qaCapabilityMarker === "string"
        ? capabilities.qaCapabilityMarker
        : null,
    executionCapabilityPresent: capabilities.executionCapabilityPresent === true,
    integrationDryRunCapabilityPresent:
      capabilities.integrationDryRunCapabilityPresent === true,
    recoveryResumeCapabilityPresent: capabilities.recoveryResumeCapabilityPresent === true,
    resettlementCapabilityPresent: capabilities.resettlementCapabilityPresent === true,
    qaCapabilityMarkers: Array.isArray(capabilities.qaCapabilityMarkers)
      ? capabilities.qaCapabilityMarkers.filter(
          (marker): marker is string => typeof marker === "string"
        )
      : [],
  };
}

export function evaluateSettlementServiceAuthorityEvidenceFromHealth({
  responseOk,
  body,
}: {
  responseOk: boolean;
  body: unknown;
}): SettlementServiceAuthorityEvidence {
  const capabilities = capabilityEvidence(body);
  const blockers: string[] = [];

  if (!responseOk) {
    blockers.push("Settlement Service readiness endpoint is not healthy.");
  }
  if (!capabilities.durablePersistenceConfigured) {
    blockers.push("Settlement Service durable persistence is not configured.");
  }
  if (!capabilities.executionCapabilityPresent) {
    blockers.push("Settlement Service execution capability is missing.");
  }
  if (!capabilities.integrationDryRunCapabilityPresent) {
    blockers.push("Settlement Service integration dry-run capability is missing.");
  }
  if (!capabilities.recoveryResumeCapabilityPresent) {
    blockers.push("Settlement Service recovery/resume capability is missing.");
  }
  if (!capabilities.resettlementCapabilityPresent) {
    blockers.push("Settlement Service resettlement capability is missing.");
  }
  if (!capabilities.idempotencySupportConfigured) {
    blockers.push("Settlement Service idempotency support is not configured.");
  }
  if (
    !capabilities.qaCapabilityMarkerPresent ||
    !capabilities.qaCapabilityMarkers.includes(REQUIRED_QA_MARKER)
  ) {
    blockers.push("Settlement Service QA capability marker is missing.");
  }

  return {
    reachable: true,
    ready: responseOk,
    capabilities,
    blockers,
  };
}

export async function getSettlementServiceAuthorityEvidence(): Promise<SettlementServiceAuthorityEvidence> {
  try {
    const response = await fetchWithTimeout(`${getSettlementServiceUrl()}/health/ready`);
    const body = await readJson(response);

    return evaluateSettlementServiceAuthorityEvidenceFromHealth({
      responseOk: response.ok,
      body,
    });
  } catch {
    return {
      reachable: false,
      ready: false,
      capabilities: defaultCapabilities(),
      blockers: ["Settlement Service is not reachable."],
    };
  }
}

export async function assertSettlementServiceAuthorityReady() {
  const evidence = await getSettlementServiceAuthorityEvidence();

  if (evidence.blockers.length > 0) {
    throw new SettlementServiceAuthorityError(evidence.blockers);
  }

  return evidence;
}

function mapRecord(record: SettlementRecordDto) {
  return {
    id: record.id,
    settlementRunId: record.settlementRunId,
    ticketId: record.ticketId,
    ticketLineId: record.ticketLineId,
    accountId: record.accountId,
    gameId: record.gameId,
    drawingId: record.drawingId,
    wagerTypeId: record.wagerTypeId,
    wagerOptionId: record.wagerOptionId ?? null,
    stake: Number(record.stake),
    payout: Number(record.payout),
    netAmount: Number(record.netAmount),
    outcome: record.outcome,
    status: record.status,
    version: record.version,
    previousSettlementRecordId: record.previousSettlementRecordId ?? null,
    reversalOfSettlementRecordId: record.reversalOfSettlementRecordId ?? null,
    ledgerTransactionIds: record.ledgerTransactionIds ?? [],
    recordHash: record.recordHash ?? null,
    previousHash: record.previousHash ?? null,
    hashVersion: record.hashVersion ?? null,
    createdAt: record.createdAt,
  };
}

function mapServiceExecutionResponse(
  input: SettlementExecutionInput,
  response: SettlementExecutionResponseDto
): SettlementExecutionResult {
  const records = response.records.map(mapRecord);

  return {
    summary: {
      settlementRunId: response.run.id,
      drawingId: response.run.drawingId,
      gameId: response.run.gameId,
      executionId: response.run.executionId ?? input.executionId ?? response.run.id,
      status: response.run.status as SettlementExecutionResult["summary"]["status"],
      expectedTicketCount: response.run.expectedTicketCount,
      expectedLineCount: response.run.expectedLineCount,
      processedTicketCount: response.run.processedTicketCount,
      processedLineCount: response.run.processedLineCount,
      winCount: response.run.winCount,
      lossCount: response.run.lossCount,
      pushCount: response.run.pushCount,
      failedCount: response.run.failedCount,
      totalStake: Number(response.run.totalStake),
      totalPayout: Number(response.run.totalPayout),
      totalNet: Number(response.run.totalNet),
      startedAt: response.run.startedAt ?? new Date().toISOString(),
      completedAt: response.run.completedAt ?? new Date().toISOString(),
      durationMs: response.run.durationMs,
      ticketsPerSecond: Number(response.run.ticketsPerSecond),
      linesPerSecond: Number(response.run.linesPerSecond),
      drawToSettlementMs: response.run.drawToSettlementMs ?? null,
      peakConcurrentSettlements: response.run.peakConcurrentSettlements,
    },
    settlementRecords: records,
    updatedTickets: input.tickets,
    updatedTicketLines: input.ticketLines,
    errors: [],
    executionErrors: [],
  };
}

function serviceErrorMessage(body: unknown, fallback: string) {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: { message?: string; code?: string } }).error;

    return error?.message ?? error?.code ?? fallback;
  }

  return fallback;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetchWithTimeout(`${getSettlementServiceUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(body.executionId ? { "Idempotency-Key": String(body.executionId) } : {}),
    },
    body: JSON.stringify(body),
  });
  const responseBody = await readJson(response);

  if (!response.ok) {
    throw new SettlementServiceClientError(
      serviceErrorMessage(
        responseBody,
        `Settlement Service request failed with HTTP ${response.status}.`
      )
    );
  }

  return responseBody as T;
}

function buildServiceRunRequest(input: SettlementExecutionInput) {
  return {
    id: input.settlementRun.id,
    drawingId: input.settlementRun.drawingId,
    gameId: input.settlementRun.gameId,
    status: "running",
    expectedTicketCount: input.tickets.filter(
      (ticket) =>
        ticket.drawingId === input.drawingId &&
        ticket.gameId === input.gameId &&
        ticket.status === "accepted"
    ).length,
    expectedLineCount: input.ticketLines.length,
    startedAt: new Date().toISOString(),
    completedAt: null,
    executionId: input.executionId ?? `settlement-service-${input.settlementRun.id}`,
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
    drawToSettlementMs: null,
    peakConcurrentSettlements: 0,
    notes: "settlement authority switch service path",
    recordHash: null,
    previousHash: null,
    hashVersion: "settlement-service-authority-switch-v1",
    createdAt: input.settlementRun.createdAt,
    records: [],
    ledgerEffects: [],
  };
}

function buildServiceTicketLines(input: SettlementExecutionInput) {
  const acceptedTickets = new Map(
    input.tickets
      .filter(
        (ticket) =>
          ticket.drawingId === input.drawingId &&
          ticket.gameId === input.gameId &&
          ticket.status === "accepted"
      )
      .map((ticket) => [ticket.id, ticket])
  );

  return input.ticketLines
    .filter((line) => acceptedTickets.has(line.ticketId))
    .map((line) => {
      const ticket = acceptedTickets.get(line.ticketId);
      const payout = Number(line.resultAmount ?? line.potentialPayout ?? 0);

      return {
        ticketId: line.ticketId,
        ticketLineId: line.id,
        accountId: ticket?.accountId ?? "",
        ledgerWalletId: null,
        creditPlayerId: null,
        creditReservationId: null,
        creditSettlementId: null,
        creditSettlementBatchId: null,
        gameId: ticket?.gameId ?? input.gameId,
        drawingId: ticket?.drawingId ?? input.drawingId,
        wagerTypeId: line.wagerTypeId,
        wagerOptionId: line.wagerOptionId ?? null,
        stake: Number(line.stake ?? 0),
        payout,
      };
    });
}

export async function executeSettlementViaSettlementService(
  input: SettlementExecutionInput
): Promise<SettlementExecutionResult> {
  await assertSettlementServiceAuthorityReady();

  await postJson("/v1/settlement/runs", buildServiceRunRequest(input));

  const execution = await postJson<SettlementExecutionResponseDto>(
    `/v1/settlement/runs/${input.settlementRun.id}/execute`,
    {
      executionId: input.executionId ?? `settlement-service-${input.settlementRun.id}`,
      integrationDryRun: false,
      ticketLines: buildServiceTicketLines(input),
    }
  );

  return mapServiceExecutionResponse(input, execution);
}

export async function executeSettlementWithAuthority(
  input: SettlementExecutionInput
): Promise<SettlementExecutionResult> {
  if (process.env.SETTLEMENT_AUTHORITY === "SERVICE") {
    return executeSettlementViaSettlementService(input);
  }

  return executeSettlementRun(input);
}
