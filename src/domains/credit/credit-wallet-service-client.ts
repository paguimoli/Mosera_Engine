import type {
  ApplyCreditSettlementInput,
  CreditReservation,
  CreditReservationStatus,
  CreditSettlementApplicationResult,
  CreditSummary,
  ReleaseCreditExposureInput,
  ReserveCreditExposureInput,
} from "./credit-reservation.types";

const CREDIT_WALLET_SERVICE_TIMEOUT_MS = 2_000;
const REQUIRED_QA_MARKER = "credit-wallet-authority-dry-run-baseline";

type CreditWalletAuthorityOperation = "reserve" | "release" | "settle" | "summary";

type MoneyDto = {
  amount: number;
  currency: string;
};

type CreditWalletCapabilities = {
  durablePersistenceConfigured: boolean;
  readCapabilityEnabled: boolean;
  mutationCapabilityEnabled: boolean;
  mutationCapabilityScope: string;
  idempotencySupportConfigured: boolean;
  idempotencySupportScope: string;
  qaCapabilityMarkerPresent: boolean;
  qaCapabilityMarker: string | null;
};

type CreditWalletHealthDto = {
  status?: string;
  capabilities?: Partial<CreditWalletCapabilities>;
};

type CreditReservationDto = {
  reservationId: string;
  playerId: string;
  ticketId: string;
  amount: MoneyDto;
  reservedAmount: MoneyDto;
  releasedAmount: MoneyDto;
  settledAmount: MoneyDto;
  remainingExposure: MoneyDto;
  status: CreditReservationStatus;
  idempotencyKey: string;
  correlationId?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  releasedAt?: string | null;
  settledAt?: string | null;
  cancelledAt?: string | null;
};

type CreditWalletSummaryDto = {
  playerId: string;
  creditWalletId: string;
  creditLimit: MoneyDto;
  balance: MoneyDto;
  pendingExposure: MoneyDto;
  availableCredit: MoneyDto;
};

type CreditSettlementApplicationDto = {
  settlementApplicationId: string;
  reservationId: string;
  playerId: string;
  ticketId: string;
  settlementId: string;
  releaseAmount: MoneyDto;
  balanceImpact: MoneyDto;
  balanceBefore: MoneyDto;
  balanceAfter: MoneyDto;
  operationType: "PARTIAL_SETTLEMENT" | "FULL_SETTLEMENT";
  idempotencyKey: string;
  correlationId?: string | null;
  createdAt: string;
};

type CreditReconciliationReservationDto = {
  reservationId: string;
  reservedAmount: MoneyDto;
  releasedAmount: MoneyDto;
  settledAmount: MoneyDto;
  remainingExposure: MoneyDto;
  status: CreditReservationStatus;
};

type CreditWalletReconciliationDto = {
  reservations?: CreditReconciliationReservationDto[];
};

type ErrorResponseDto = {
  error?: {
    code?: string;
    message?: string;
  };
};

export type CreditWalletServiceAuthorityEvidence = {
  reachable: boolean;
  ready: boolean;
  capabilities: CreditWalletCapabilities;
  blockers: string[];
};

export class CreditWalletServiceAuthorityError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Credit Wallet Service authority guardrails failed: ${blockers.join(" ")}`);
    this.name = "CreditWalletServiceAuthorityError";
    this.blockers = blockers;
  }
}

export class CreditWalletServiceClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditWalletServiceClientError";
  }
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getCreditWalletServiceUrl() {
  return trimTrailingSlash(
    process.env.CREDIT_SERVICE_URL?.trim() || "http://credit-wallet-service:8080"
  );
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CREDIT_WALLET_SERVICE_TIMEOUT_MS);

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

function defaultCapabilities(): CreditWalletCapabilities {
  return {
    durablePersistenceConfigured: false,
    readCapabilityEnabled: false,
    mutationCapabilityEnabled: false,
    mutationCapabilityScope: "none",
    idempotencySupportConfigured: false,
    idempotencySupportScope: "none",
    qaCapabilityMarkerPresent: false,
    qaCapabilityMarker: null,
  };
}

function capabilityEvidence(body: unknown): CreditWalletCapabilities {
  const capabilities =
    typeof body === "object" && body !== null && "capabilities" in body
      ? ((body as CreditWalletHealthDto).capabilities ?? {})
      : {};

  return {
    durablePersistenceConfigured: capabilities.durablePersistenceConfigured === true,
    readCapabilityEnabled: capabilities.readCapabilityEnabled === true,
    mutationCapabilityEnabled: capabilities.mutationCapabilityEnabled === true,
    mutationCapabilityScope:
      typeof capabilities.mutationCapabilityScope === "string"
        ? capabilities.mutationCapabilityScope
        : "none",
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
  };
}

function scopeSupportsOperation(
  scope: string,
  operation: CreditWalletAuthorityOperation
) {
  if (operation === "summary") {
    return true;
  }

  if (scope === "reserveReleaseSettleReconcileOnly" || scope === "reserveReleaseSettleOnly") {
    return operation === "reserve" || operation === "release" || operation === "settle";
  }

  if (scope === "reserveReleaseOnly") {
    return operation === "reserve" || operation === "release";
  }

  return scope === "all" || scope === "productionAuthority";
}

function buildCapabilityBlockers(
  operation: CreditWalletAuthorityOperation,
  responseOk: boolean,
  capabilities: CreditWalletCapabilities
) {
  const blockers: string[] = [];
  const isMutation = operation !== "summary";

  if (!responseOk) {
    blockers.push("Credit Wallet Service capability endpoint is not healthy.");
  }
  if (!capabilities.durablePersistenceConfigured) {
    blockers.push("Credit Wallet Service durable persistence is not configured.");
  }
  if (operation === "summary" && !capabilities.readCapabilityEnabled) {
    blockers.push("Credit Wallet Service read capability is not explicitly enabled.");
  }
  if (isMutation && !capabilities.mutationCapabilityEnabled) {
    blockers.push("Credit Wallet Service mutation capability is not explicitly enabled.");
  }
  if (
    isMutation &&
    !scopeSupportsOperation(capabilities.mutationCapabilityScope, operation)
  ) {
    blockers.push(`Credit Wallet Service does not support ${operation} mutations.`);
  }
  if (isMutation && !capabilities.idempotencySupportConfigured) {
    blockers.push("Credit Wallet Service idempotency support is not configured.");
  }
  if (
    isMutation &&
    !scopeSupportsOperation(capabilities.idempotencySupportScope, operation)
  ) {
    blockers.push(`Credit Wallet Service idempotency does not support ${operation}.`);
  }
  if (
    !capabilities.qaCapabilityMarkerPresent ||
    capabilities.qaCapabilityMarker !== REQUIRED_QA_MARKER
  ) {
    blockers.push("Credit Wallet Service QA capability marker is missing.");
  }

  return blockers;
}

export async function getCreditWalletServiceAuthorityEvidence(
  operation: CreditWalletAuthorityOperation
): Promise<CreditWalletServiceAuthorityEvidence> {
  try {
    const [readinessResponse, capabilityResponse] = await Promise.all([
      fetchWithTimeout(`${getCreditWalletServiceUrl()}/health/ready`),
      fetchWithTimeout(`${getCreditWalletServiceUrl()}/v1/credit-wallets/health`),
    ]);
    const capabilityBody = await readJson(capabilityResponse);
    const capabilities = capabilityEvidence(capabilityBody);
    const blockers = buildCapabilityBlockers(
      operation,
      readinessResponse.ok && capabilityResponse.ok,
      capabilities
    );

    if (!readinessResponse.ok) {
      blockers.unshift("Credit Wallet Service readiness endpoint is not healthy.");
    }

    return {
      reachable: true,
      ready: readinessResponse.ok && capabilityResponse.ok,
      capabilities,
      blockers,
    };
  } catch {
    return {
      reachable: false,
      ready: false,
      capabilities: defaultCapabilities(),
      blockers: ["Credit Wallet Service is not reachable."],
    };
  }
}

export async function assertCreditWalletServiceAuthorityReady(
  operation: CreditWalletAuthorityOperation
) {
  const evidence = await getCreditWalletServiceAuthorityEvidence(operation);

  if (evidence.blockers.length > 0) {
    throw new CreditWalletServiceAuthorityError(evidence.blockers);
  }

  return evidence;
}

function mapReservation(dto: CreditReservationDto): CreditReservation {
  return {
    id: dto.reservationId,
    playerId: dto.playerId,
    ticketId: dto.ticketId,
    amount: dto.amount.amount,
    currency: dto.amount.currency,
    status: dto.status,
    reservedAmount: dto.reservedAmount.amount,
    releasedAmount: dto.releasedAmount.amount,
    settledAmount: dto.settledAmount.amount,
    remainingExposure: dto.remainingExposure.amount,
    idempotencyKey: dto.idempotencyKey,
    correlationId: dto.correlationId ?? null,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt ?? null,
    releasedAt: dto.releasedAt ?? null,
    settledAt: dto.settledAt ?? null,
    cancelledAt: dto.cancelledAt ?? null,
    metadata: {},
  };
}

function mapSummary(dto: CreditWalletSummaryDto): CreditSummary {
  return {
    playerId: dto.playerId,
    walletId: dto.creditWalletId,
    creditLimit: dto.creditLimit.amount,
    balance: dto.balance.amount,
    pendingExposure: dto.pendingExposure.amount,
    availableCredit: dto.availableCredit.amount,
    currency: dto.balance.currency,
  };
}

function mapSettlementApplication(
  dto: CreditSettlementApplicationDto,
  reservation?: CreditReconciliationReservationDto
): CreditSettlementApplicationResult {
  return {
    applicationId: dto.settlementApplicationId,
    reservationId: dto.reservationId,
    playerId: dto.playerId,
    ticketId: dto.ticketId,
    settlementId: dto.settlementId,
    releaseAmount: dto.releaseAmount.amount,
    balanceImpact: dto.balanceImpact.amount,
    balanceBefore: dto.balanceBefore.amount,
    balanceAfter: dto.balanceAfter.amount,
    currency: dto.balanceAfter.currency,
    operationType: dto.operationType,
    status: reservation?.status ?? "SETTLED",
    releasedAmount: reservation?.releasedAmount.amount ?? dto.releaseAmount.amount,
    settledAmount: reservation?.settledAmount.amount ?? dto.releaseAmount.amount,
    remainingExposure: reservation?.remainingExposure.amount ?? 0,
    idempotencyKey: dto.idempotencyKey,
    correlationId: dto.correlationId ?? null,
    createdAt: dto.createdAt,
  };
}

function serviceErrorMessage(body: unknown, fallback: string) {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as ErrorResponseDto).error;
    if (error?.message) {
      return error.message;
    }
    if (error?.code) {
      return error.code;
    }
  }

  return fallback;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  correlationId?: string | null
): Promise<T> {
  const response = await fetchWithTimeout(`${getCreditWalletServiceUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
    body: JSON.stringify(body),
  });
  const responseBody = await readJson(response);

  if (!response.ok) {
    throw new CreditWalletServiceClientError(
      serviceErrorMessage(
        responseBody,
        `Credit Wallet Service request failed with HTTP ${response.status}.`
      )
    );
  }

  return responseBody as T;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetchWithTimeout(`${getCreditWalletServiceUrl()}${path}`);
  const body = await readJson(response);

  if (!response.ok) {
    throw new CreditWalletServiceClientError(
      serviceErrorMessage(
        body,
        `Credit Wallet Service request failed with HTTP ${response.status}.`
      )
    );
  }

  return body as T;
}

async function getReservationSnapshot(
  playerId: string,
  reservationId: string
): Promise<CreditReconciliationReservationDto | undefined> {
  const reconciliation = await getJson<CreditWalletReconciliationDto>(
    `/v1/credit-wallets/${playerId}/reconciliation`
  );

  return reconciliation.reservations?.find(
    (reservation) => reservation.reservationId === reservationId
  );
}

export async function reserveCreditExposureViaCreditWalletService(
  input: ReserveCreditExposureInput
): Promise<CreditReservation> {
  await assertCreditWalletServiceAuthorityReady("reserve");

  const reservation = await postJson<CreditReservationDto>(
    `/v1/credit-wallets/${input.playerId}/reserve`,
    {
      ticketId: input.ticketId,
      amount: {
        amount: input.amount,
        currency: input.currency,
      },
      sourceService: "lottery-app",
      metadata: input.metadata ?? {},
    },
    input.idempotencyKey,
    input.correlationId
  );

  return mapReservation(reservation);
}

export async function releaseCreditExposureViaCreditWalletService(
  input: ReleaseCreditExposureInput
): Promise<CreditReservation> {
  await assertCreditWalletServiceAuthorityReady("release");

  const playerId =
    typeof input.metadata?.playerId === "string"
      ? input.metadata.playerId
      : "";

  if (!playerId) {
    throw new CreditWalletServiceClientError(
      "Credit Wallet Service release routing requires metadata.playerId."
    );
  }

  const reservation = await postJson<CreditReservationDto>(
    `/v1/credit-wallets/${playerId}/release`,
    {
      reservationId: input.reservationId,
      ticketId: input.ticketId,
      releaseAmount: {
        amount: input.releaseAmount,
        currency: "USD",
      },
      reasonCode: input.reason ?? "CREDIT_AUTHORITY_RELEASE",
      sourceService: "lottery-app",
      metadata: input.metadata ?? {},
    },
    input.idempotencyKey,
    input.correlationId
  );

  return mapReservation(reservation);
}

export async function applyCreditSettlementViaCreditWalletService(
  input: ApplyCreditSettlementInput
): Promise<CreditSettlementApplicationResult> {
  await assertCreditWalletServiceAuthorityReady("settle");

  const playerId =
    typeof input.metadata?.playerId === "string" ? input.metadata.playerId : "";

  if (!playerId) {
    throw new CreditWalletServiceClientError(
      "Credit Wallet Service settlement routing requires metadata.playerId."
    );
  }

  const application = await postJson<CreditSettlementApplicationDto>(
    `/v1/credit-wallets/${playerId}/settle`,
    {
      settlementId: input.settlementId,
      settlementBatchId:
        typeof input.metadata?.settlementBatchId === "string"
          ? input.metadata.settlementBatchId
          : input.settlementId,
      reservationId: input.reservationId,
      ticketId: input.ticketId,
      releaseAmount: {
        amount: input.releaseAmount,
        currency: input.currency,
      },
      balanceImpact: {
        amount: input.balanceImpact,
        currency: input.currency,
      },
      outcome:
        typeof input.metadata?.settlementOutcome === "string"
          ? input.metadata.settlementOutcome
          : "WIN",
      sourceService: "lottery-app",
      metadata: input.metadata ?? {},
    },
    input.idempotencyKey,
    input.correlationId
  );
  const reservation = await getReservationSnapshot(
    application.playerId,
    application.reservationId
  ).catch(() => undefined);

  return mapSettlementApplication(application, reservation);
}

export async function getPlayerCreditSummaryViaCreditWalletService(
  playerId: string
): Promise<CreditSummary> {
  await assertCreditWalletServiceAuthorityReady("summary");

  return mapSummary(
    await getJson<CreditWalletSummaryDto>(`/v1/credit-wallets/${playerId}/summary`)
  );
}
