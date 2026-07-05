import type { CreateLedgerEntryInput, LedgerEntry } from "./ledger.types";

const LEDGER_SERVICE_TIMEOUT_MS = 2_000;
const REQUIRED_QA_MARKER = "ledger-service-authority-dry-run";

type LedgerServiceCapabilities = {
  mutationCapabilityEnabled: boolean;
  durablePersistenceConfigured: boolean;
  idempotencySupportConfigured: boolean;
  qaCapabilityMarkerPresent: boolean;
};

export type LedgerServiceAuthorityEvidence = {
  reachable: boolean;
  ready: boolean;
  capabilities: LedgerServiceCapabilities;
  blockers: string[];
};

type LedgerServiceEntryDto = {
  id: string;
  walletId: string;
  accountId: string;
  transactionType: LedgerEntry["transactionType"];
  direction: LedgerEntry["direction"];
  money: {
    amount: number;
    currency: string;
  };
  balanceAfter: {
    amount: number;
    currency: string;
  };
  reference?: {
    type?: string | null;
    id?: string | null;
  } | null;
  idempotencyKey?: string | null;
  reversalOfLedgerEntryId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export class LedgerServiceAuthorityError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Ledger Service authority guardrails failed: ${blockers.join(" ")}`);
    this.name = "LedgerServiceAuthorityError";
    this.blockers = blockers;
  }
}

export class LedgerServiceClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerServiceClientError";
  }
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getLedgerServiceUrl() {
  return trimTrailingSlash(process.env.LEDGER_SERVICE_URL?.trim() || "http://ledger-service:8080");
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEDGER_SERVICE_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function capabilityEvidence(body: unknown): LedgerServiceCapabilities {
  const capabilities =
    typeof body === "object" && body !== null && "capabilities" in body
      ? (body.capabilities as Record<string, unknown>)
      : {};

  return {
    mutationCapabilityEnabled: capabilities.mutationCapabilityEnabled === true,
    durablePersistenceConfigured: capabilities.durablePersistenceConfigured === true,
    idempotencySupportConfigured: capabilities.idempotencySupportConfigured === true,
    qaCapabilityMarkerPresent: capabilities.qaCapabilityMarker === REQUIRED_QA_MARKER,
  };
}

export async function getLedgerServiceAuthorityEvidence(): Promise<LedgerServiceAuthorityEvidence> {
  const blockers: string[] = [];

  try {
    const response = await fetchWithTimeout(`${getLedgerServiceUrl()}/health/ready`);
    const body = await readJson(response);
    const capabilities = capabilityEvidence(body);

    if (!response.ok) {
      blockers.push("Ledger Service readiness endpoint is not healthy.");
    }
    if (!capabilities.mutationCapabilityEnabled) {
      blockers.push("Ledger Service mutation capability is not explicitly enabled.");
    }
    if (!capabilities.durablePersistenceConfigured) {
      blockers.push("Ledger Service durable persistence is not configured.");
    }
    if (!capabilities.idempotencySupportConfigured) {
      blockers.push("Ledger Service idempotency support is not configured.");
    }
    if (!capabilities.qaCapabilityMarkerPresent) {
      blockers.push("Ledger Service QA capability marker is missing.");
    }

    return {
      reachable: true,
      ready: response.ok,
      capabilities,
      blockers,
    };
  } catch {
    return {
      reachable: false,
      ready: false,
      capabilities: {
        mutationCapabilityEnabled: false,
        durablePersistenceConfigured: false,
        idempotencySupportConfigured: false,
        qaCapabilityMarkerPresent: false,
      },
      blockers: ["Ledger Service is not reachable."],
    };
  }
}

export async function assertLedgerServiceAuthorityReady() {
  const evidence = await getLedgerServiceAuthorityEvidence();

  if (evidence.blockers.length > 0) {
    throw new LedgerServiceAuthorityError(evidence.blockers);
  }

  return evidence;
}

function mapLedgerServiceEntry(entry: LedgerServiceEntryDto): LedgerEntry {
  return {
    id: entry.id,
    walletId: entry.walletId,
    accountId: entry.accountId,
    transactionType: entry.transactionType,
    direction: entry.direction,
    amount: entry.money.amount,
    balanceAfter: entry.balanceAfter.amount,
    currencyCode: entry.money.currency,
    referenceType: entry.reference?.type ?? null,
    referenceId: entry.reference?.id ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
    reversalOfLedgerEntryId: entry.reversalOfLedgerEntryId ?? null,
    metadata: entry.metadata ?? {},
    createdAt: entry.createdAt,
  };
}

export async function postLedgerEntryViaLedgerService(
  input: CreateLedgerEntryInput
): Promise<LedgerEntry> {
  if (!input.idempotencyKey?.trim()) {
    throw new LedgerServiceClientError("Ledger Service authority requires an idempotency key.");
  }

  await assertLedgerServiceAuthorityReady();

  const response = await fetchWithTimeout(`${getLedgerServiceUrl()}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      walletId: input.walletId,
      transactionType: input.transactionType,
      direction: input.direction,
      money: {
        amount: input.amount,
        currency: "USD",
      },
      reference: {
        type: input.reference?.referenceType ?? null,
        id: input.reference?.referenceId ?? null,
      },
      metadata: input.metadata ?? {},
    }),
  });
  const body = await readJson(response);

  if (!response.ok) {
    const message =
      body?.error?.message ??
      body?.error ??
      `Ledger Service posting failed with HTTP ${response.status}.`;
    throw new LedgerServiceClientError(String(message));
  }

  if (!body?.ledgerEntry) {
    throw new LedgerServiceClientError("Ledger Service posting did not return a ledger entry.");
  }

  return mapLedgerServiceEntry(body.ledgerEntry as LedgerServiceEntryDto);
}
