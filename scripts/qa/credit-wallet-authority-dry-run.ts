import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import {
  evaluateFinancialAuthorityGuardrail,
} from "@/src/domains/financial-authority/financial-authority-guardrails";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type SeededWallet = QueryResultRow & {
  account_id: string;
  wallet_id: string;
};

type FlowSnapshot = {
  balance: number;
  pendingExposure: number;
  availableCredit: number;
  reservations: number;
  settlementApplications: number;
  discrepancies: number;
};

const checks: Check[] = [];
const creditServiceUrl = trimTrailingSlash(
  process.env.CREDIT_SERVICE_URL ?? process.env.QA_CREDIT_SERVICE_URL ?? "http://localhost:5300"
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

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    fail("DATABASE_URL is required for Credit Wallet authority dry-run QA.");
  }

  return databaseUrl;
}

async function readJson(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function seedWallet(pool: Pool, prefix: string): Promise<SeededWallet> {
  const accountId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `
insert into public.accounts (
  id,
  account_type,
  account_code,
  display_name,
  status
)
values ($1, 'PLAYER', $2, $3, 'ACTIVE')
`,
    [accountId, `${prefix}-${suffix}`, `QA ${prefix} ${suffix}`]
  );

  const wallet = await pool.query<SeededWallet>(
    `
insert into public.financial_wallets (
  account_id,
  wallet_type,
  currency_code,
  balance_authority,
  status,
  balance,
  credit_limit,
  funding_model
)
values ($1, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', 100, 1000, 'CREDIT')
returning account_id::text, id::text as wallet_id
`,
    [accountId]
  );

  return wallet.rows[0];
}

async function postJson(path: string, body: Record<string, unknown>, idempotencyKey: string) {
  const response = await fetch(`${creditServiceUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-credit-wallet-authority-dry-run-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    body: await readJson(response),
  };
}

async function getReconciliation(accountId: string) {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${accountId}/reconciliation`);
  const body = await readJson(response);

  assert(response.ok, "Reconciliation endpoint should return 200.", {
    accountId,
    status: response.status,
    body,
  });

  return body;
}

function snapshot(reconciliation: Record<string, unknown>): FlowSnapshot {
  const balance = reconciliation.balance as Record<string, unknown>;
  const pendingExposure = reconciliation.pendingExposure as Record<string, unknown>;
  const availableCredit = reconciliation.availableCredit as Record<string, unknown>;
  const reservations = reconciliation.reservations as unknown[];
  const settlements = reconciliation.settlementApplications as unknown[];
  const discrepancies = reconciliation.detectedDiscrepancies as unknown[];

  return {
    balance: Number(balance?.amount ?? 0),
    pendingExposure: Number(pendingExposure?.amount ?? 0),
    availableCredit: Number(availableCredit?.amount ?? 0),
    reservations: reservations.length,
    settlementApplications: settlements.length,
    discrepancies: discrepancies.length,
  };
}

function assertEquivalentSnapshot(monolith: FlowSnapshot, service: FlowSnapshot, name: string) {
  assert(JSON.stringify(monolith) === JSON.stringify(service), `${name} snapshots should match.`, {
    monolith,
    service,
  });
}

async function monolithReserve(pool: Pool, accountId: string, ticketId: string, amount: number, key: string) {
  const result = await pool.query(
    `
select *
from public.reserve_credit_exposure($1, $2, $3, 'USD', $4, $5, $6::jsonb)
`,
    [
      accountId,
      ticketId,
      amount,
      key,
      `qa-credit-wallet-authority-dry-run-${randomUUID()}`,
      JSON.stringify({ source: "qa:credit-wallet-authority-dry-run", path: "monolith" }),
    ]
  );

  return result.rows[0];
}

async function monolithRelease(pool: Pool, reservationId: string, ticketId: string, amount: number, key: string) {
  const result = await pool.query(
    `
select *
from public.release_credit_exposure($1, $2, $3, $4, $5, 'QA_DRY_RUN_RELEASE', $6::jsonb)
`,
    [
      reservationId,
      ticketId,
      amount,
      key,
      `qa-credit-wallet-authority-dry-run-${randomUUID()}`,
      JSON.stringify({ source: "qa:credit-wallet-authority-dry-run", path: "monolith" }),
    ]
  );

  return result.rows[0];
}

async function monolithSettle(pool: Pool, reservationId: string, ticketId: string, amount: number, impact: number, key: string) {
  const result = await pool.query(
    `
select *
from public.apply_credit_settlement($1, $2, $3, $4, $5, 'USD', $6, $7, $8::jsonb)
`,
    [
      reservationId,
      ticketId,
      randomUUID(),
      amount,
      impact,
      key,
      `qa-credit-wallet-authority-dry-run-${randomUUID()}`,
      JSON.stringify({ source: "qa:credit-wallet-authority-dry-run", path: "monolith" }),
    ]
  );

  return result.rows[0];
}

async function serviceReserve(accountId: string, ticketId: string, amount: number, key: string) {
  return postJson(
    `/v1/credit-wallets/${accountId}/reserve`,
    {
      ticketId,
      amount: { amount, currency: "USD" },
      metadata: { source: "qa:credit-wallet-authority-dry-run", path: "service" },
    },
    key
  );
}

async function serviceRelease(accountId: string, reservationId: string, ticketId: string, amount: number, key: string) {
  return postJson(
    `/v1/credit-wallets/${accountId}/release`,
    {
      reservationId,
      ticketId,
      releaseAmount: { amount, currency: "USD" },
      reasonCode: "QA_DRY_RUN_RELEASE",
      metadata: { source: "qa:credit-wallet-authority-dry-run", path: "service" },
    },
    key
  );
}

async function serviceSettle(accountId: string, reservationId: string, ticketId: string, amount: number, impact: number, key: string) {
  return postJson(
    `/v1/credit-wallets/${accountId}/settle`,
    {
      settlementId: randomUUID(),
      settlementBatchId: randomUUID(),
      reservationId,
      ticketId,
      releaseAmount: { amount, currency: "USD" },
      balanceImpact: { amount: impact, currency: "USD" },
      outcome: "WIN",
      metadata: { source: "qa:credit-wallet-authority-dry-run", path: "service" },
    },
    key
  );
}

async function verifyHealth() {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/health`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet health should pass.", { status: response.status, body });
  assert(body?.capabilities?.durablePersistenceConfigured === true, "Durable persistence marker should be enabled.", { body });
  assert(body?.capabilities?.mutationCapabilityEnabled === true, "Partial mutation marker should be enabled.", { body });
  assert(body?.capabilities?.mutationCapabilityScope === "reserveReleaseSettleReconcileOnly", "Mutation scope should remain partial.", { body });
  assert(body?.capabilities?.idempotencySupportConfigured === true, "Idempotency marker should be enabled.", { body });
  assert(body?.capabilities?.qaCapabilityMarkerPresent === true, "Authority dry-run QA marker should be present.", { body });
  pass("Credit Wallet health reports dry-run capability markers");
}

async function verifyEquivalentFlow(pool: Pool) {
  const monolith = await seedWallet(pool, "qa-credit-dry-run-monolith");
  const service = await seedWallet(pool, "qa-credit-dry-run-service");
  const ticketId = randomUUID();
  const reserveCorrelation = randomUUID();
  const monolithReserveKey = `qa-credit-dry-run-reserve-monolith-${reserveCorrelation}`;
  const serviceReserveKey = `qa-credit-dry-run-reserve-service-${reserveCorrelation}`;

  const monolithReserved = await monolithReserve(pool, monolith.account_id, ticketId, 300, monolithReserveKey);
  const serviceReserved = await serviceReserve(service.account_id, ticketId, 300, serviceReserveKey);

  assert(serviceReserved.response.ok, "Service reserve should succeed.", {
    status: serviceReserved.response.status,
    body: serviceReserved.body,
  });
  assert(Number(monolithReserved.remaining_exposure) === serviceReserved.body?.remainingExposure?.amount, "Reserve remaining exposure should match.", {
    monolithReserved,
    serviceReserved: serviceReserved.body,
  });
  assertEquivalentSnapshot(
    snapshot(await getReconciliation(monolith.account_id)),
    snapshot(await getReconciliation(service.account_id)),
    "reserve"
  );
  pass("monolith reserve vs service reserve equivalence");

  const duplicateMonolithReserve = await monolithReserve(pool, monolith.account_id, ticketId, 300, monolithReserveKey);
  const duplicateServiceReserve = await serviceReserve(service.account_id, ticketId, 300, serviceReserveKey);
  assert(duplicateServiceReserve.response.ok, "Duplicate service reserve should succeed idempotently.", {
    status: duplicateServiceReserve.response.status,
    body: duplicateServiceReserve.body,
  });
  assert(duplicateMonolithReserve.id === monolithReserved.id, "Duplicate monolith reserve should return original reservation.", {
    duplicateMonolithReserve,
    monolithReserved,
  });
  assert(duplicateServiceReserve.body?.reservationId === serviceReserved.body?.reservationId, "Duplicate service reserve should return original reservation.", {
    duplicateServiceReserve: duplicateServiceReserve.body,
    serviceReserved: serviceReserved.body,
  });
  assertEquivalentSnapshot(
    snapshot(await getReconciliation(monolith.account_id)),
    snapshot(await getReconciliation(service.account_id)),
    "duplicate reserve"
  );
  pass("duplicate idempotency equivalence");

  const releaseCorrelation = randomUUID();
  const monolithReleaseKey = `qa-credit-dry-run-release-monolith-${releaseCorrelation}`;
  const serviceReleaseKey = `qa-credit-dry-run-release-service-${releaseCorrelation}`;
  const monolithReleased = await monolithRelease(pool, monolithReserved.id, ticketId, 100, monolithReleaseKey);
  const serviceReleased = await serviceRelease(service.account_id, serviceReserved.body.reservationId, ticketId, 100, serviceReleaseKey);
  assert(serviceReleased.response.ok, "Service release should succeed.", {
    status: serviceReleased.response.status,
    body: serviceReleased.body,
  });
  assert(Number(monolithReleased.remaining_exposure) === serviceReleased.body?.remainingExposure?.amount, "Release remaining exposure should match.", {
    monolithReleased,
    serviceReleased: serviceReleased.body,
  });
  assertEquivalentSnapshot(
    snapshot(await getReconciliation(monolith.account_id)),
    snapshot(await getReconciliation(service.account_id)),
    "release"
  );
  pass("monolith release vs service release equivalence");

  const settleCorrelation = randomUUID();
  const monolithSettleKey = `qa-credit-dry-run-settle-monolith-${settleCorrelation}`;
  const serviceSettleKey = `qa-credit-dry-run-settle-service-${settleCorrelation}`;
  const monolithSettled = await monolithSettle(pool, monolithReserved.id, ticketId, 200, 175, monolithSettleKey);
  const serviceSettled = await serviceSettle(service.account_id, serviceReserved.body.reservationId, ticketId, 200, 175, serviceSettleKey);
  assert(serviceSettled.response.ok, "Service settle should succeed.", {
    status: serviceSettled.response.status,
    body: serviceSettled.body,
  });
  assert(Number(monolithSettled.balance_after) === serviceSettled.body?.balanceAfter?.amount, "Settlement balance after should match.", {
    monolithSettled,
    serviceSettled: serviceSettled.body,
  });
  assertEquivalentSnapshot(
    snapshot(await getReconciliation(monolith.account_id)),
    snapshot(await getReconciliation(service.account_id)),
    "settle"
  );
  pass("monolith settle vs service settle equivalence");
  pass("exposure/balance reconciliation after each flow");
}

async function verifyInvalidStateEquivalence(pool: Pool) {
  const service = await seedWallet(pool, "qa-credit-dry-run-invalid-service");
  const ticketId = randomUUID();
  const reservationId = randomUUID();

  let monolithFailed = false;
  try {
    await monolithRelease(
      pool,
      reservationId,
      ticketId,
      50,
      `qa-credit-dry-run-invalid-monolith-${randomUUID()}`
    );
  } catch {
    monolithFailed = true;
  }

  const serviceResult = await serviceRelease(
    service.account_id,
    reservationId,
    ticketId,
    50,
    `qa-credit-dry-run-invalid-service-${randomUUID()}`
  );

  assert(monolithFailed, "Monolith invalid release should fail.", {});
  assert(serviceResult.response.status === 400, "Service invalid release should fail closed.", {
    status: serviceResult.response.status,
    body: serviceResult.body,
  });
  assert(serviceResult.body?.error?.code === "CREDIT_RESERVATION_NOT_FOUND", "Service invalid release should map to reservation not found.", {
    body: serviceResult.body,
  });
  pass("invalid state equivalence");
}

function verifyCreditAuthorityRemainsMonolith() {
  const authority = String(process.env.CREDIT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "CREDIT_AUTHORITY must not be SERVICE in authority dry-run QA.", {
    authority,
  });

  const guardrail = evaluateFinancialAuthorityGuardrail({
    config: {
      domain: "CREDIT",
      authority: "MONOLITH",
      comparisonMode: "ENABLED",
      mismatchAlertThreshold: 0.001,
      serviceUrl: creditServiceUrl,
    },
    serviceReachable: true,
    readinessHealthy: true,
    mutationCapabilityEnabled: true,
    durablePersistenceConfigured: true,
    idempotencySupportConfigured: true,
    qaCapabilityMarkerPresent: true,
  });

  assert(guardrail.productionStatus === "MONOLITH_ALLOWED", "Credit authority guardrail should keep MONOLITH allowed.", {
    guardrail,
  });
  assert(!guardrail.productionReady, "Credit authority dry-run must not report SERVICE production ready.", {
    guardrail,
  });
  pass("guardrails still keep CREDIT authority MONOLITH");
}

async function main() {
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await verifyHealth();
    await verifyEquivalentFlow(pool);
    await verifyInvalidStateEquivalence(pool);
    verifyCreditAuthorityRemainsMonolith();

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Credit Wallet authority dry-run QA failed.");
});
