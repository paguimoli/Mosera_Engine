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
    fail("DATABASE_URL is required for Credit Wallet reserve/release QA.");
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

async function seedWallet(pool: Pool, creditLimit = 1000, balance = 100): Promise<SeededWallet> {
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
    [accountId, `qa-credit-mutation-${suffix}`, `QA Credit Mutation ${suffix}`]
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
values ($1, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', $2, $3, 'CREDIT')
returning account_id::text, id::text as wallet_id
`,
    [accountId, balance, creditLimit]
  );

  return wallet.rows[0];
}

async function postJson(path: string, body: Record<string, unknown>, idempotencyKey: string) {
  const response = await fetch(`${creditServiceUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-credit-wallet-reserve-release-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    body: await readJson(response),
  };
}

async function reserve(accountId: string, amount: number, idempotencyKey: string) {
  return postJson(
    `/v1/credit-wallets/${accountId}/reserve`,
    {
      ticketId: randomUUID(),
      amount: {
        amount,
        currency: "USD",
      },
      metadata: {
        source: "qa:credit-wallet-reserve-release",
      },
    },
    idempotencyKey
  );
}

async function release({
  accountId,
  reservationId,
  ticketId,
  amount,
  idempotencyKey,
}: {
  accountId: string;
  reservationId: string;
  ticketId: string;
  amount: number;
  idempotencyKey: string;
}) {
  return postJson(
    `/v1/credit-wallets/${accountId}/release`,
    {
      reservationId,
      ticketId,
      releaseAmount: {
        amount,
        currency: "USD",
      },
      reasonCode: "QA_RELEASE",
      metadata: {
        source: "qa:credit-wallet-reserve-release",
      },
    },
    idempotencyKey
  );
}

async function verifyHealth() {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/health`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet health should pass.", { status: response.status, body });
  assert(body?.capabilities?.mutationCapabilityEnabled === true, "Reserve/release mutation marker should be enabled.", { body });
  assert(body?.capabilities?.mutationCapabilityScope === "reserveReleaseSettleReconcileOnly", "Mutation scope should be reserve/release/settle/reconciliation only.", { body });
  assert(body?.capabilities?.idempotencySupportConfigured === true, "Reserve/release idempotency marker should be enabled.", { body });
  assert(body?.capabilities?.idempotencySupportScope === "reserveReleaseSettleReconcileOnly", "Idempotency scope should be reserve/release/settle/reconciliation only.", { body });
  assert(body?.capabilities?.qaCapabilityMarkerPresent === true, "Reserve/release QA marker should be present.", { body });
  pass("Credit Wallet health reports reserve/release capability only");
}

async function verifyReserveAndRelease(pool: Pool) {
  const wallet = await seedWallet(pool);
  const reserveKey = `qa-credit-reserve-${randomUUID()}`;
  const reserved = await reserve(wallet.account_id, 250, reserveKey);

  assert(reserved.response.ok, "Reserve should succeed.", {
    status: reserved.response.status,
    body: reserved.body,
  });
  assert(reserved.body?.status === "RESERVED", "Reserve should return RESERVED status.", { body: reserved.body });
  assert(reserved.body?.remainingExposure?.amount === 250, "Reserve should return full remaining exposure.", { body: reserved.body });
  pass("reserve succeeds", { reservationId: reserved.body.reservationId });

  const duplicateReserve = await postJson(
    `/v1/credit-wallets/${wallet.account_id}/reserve`,
    {
      ticketId: reserved.body.ticketId,
      amount: {
        amount: 250,
        currency: "USD",
      },
      metadata: {
        source: "qa:credit-wallet-reserve-release",
        replay: true,
      },
    },
    reserveKey
  );
  assert(duplicateReserve.response.ok, "Duplicate reserve should be idempotent.", {
    status: duplicateReserve.response.status,
    body: duplicateReserve.body,
  });
  assert(
    duplicateReserve.body?.reservationId === reserved.body?.reservationId,
    "Duplicate reserve should return original reservation.",
    { reserved: reserved.body, duplicateReserve: duplicateReserve.body }
  );
  pass("duplicate reserve idempotent");

  const releaseKey = `qa-credit-release-${randomUUID()}`;
  const released = await release({
    accountId: wallet.account_id,
    reservationId: reserved.body.reservationId,
    ticketId: reserved.body.ticketId,
    amount: 100,
    idempotencyKey: releaseKey,
  });

  assert(released.response.ok, "Release should succeed.", {
    status: released.response.status,
    body: released.body,
  });
  assert(released.body?.status === "PARTIALLY_RELEASED", "Partial release should return PARTIALLY_RELEASED.", { body: released.body });
  assert(released.body?.releasedAmount?.amount === 100, "Release should increment released amount.", { body: released.body });
  assert(released.body?.remainingExposure?.amount === 150, "Release should reduce remaining exposure.", { body: released.body });
  pass("release succeeds");

  const duplicateRelease = await release({
    accountId: wallet.account_id,
    reservationId: reserved.body.reservationId,
    ticketId: reserved.body.ticketId,
    amount: 100,
    idempotencyKey: releaseKey,
  });

  assert(duplicateRelease.response.ok, "Duplicate release should be idempotent.", {
    status: duplicateRelease.response.status,
    body: duplicateRelease.body,
  });
  assert(
    duplicateRelease.body?.reservationId === reserved.body?.reservationId &&
      duplicateRelease.body?.releasedAmount?.amount === 100 &&
      duplicateRelease.body?.remainingExposure?.amount === 150,
    "Duplicate release should return original release state.",
    { released: released.body, duplicateRelease: duplicateRelease.body }
  );
  pass("duplicate release idempotent");
}

async function verifyFailures(pool: Pool) {
  const smallWallet = await seedWallet(pool, 50, 0);
  const overReserve = await reserve(
    smallWallet.account_id,
    1000,
    `qa-credit-over-reserve-${randomUUID()}`
  );

  assert(overReserve.response.status === 400, "Over-reserve should fail closed.", {
    status: overReserve.response.status,
    body: overReserve.body,
  });
  assert(overReserve.body?.error?.code === "CREDIT_INSUFFICIENT_AVAILABLE", "Over-reserve should report insufficient credit.", {
    body: overReserve.body,
  });
  pass("over-reserve fails closed");

  const invalidRelease = await release({
    accountId: smallWallet.account_id,
    reservationId: randomUUID(),
    ticketId: randomUUID(),
    amount: 25,
    idempotencyKey: `qa-credit-invalid-release-${randomUUID()}`,
  });
  assert(invalidRelease.response.status === 400, "Invalid release should fail closed.", {
    status: invalidRelease.response.status,
    body: invalidRelease.body,
  });
  assert(invalidRelease.body?.error?.code === "CREDIT_RESERVATION_NOT_FOUND", "Invalid release should report reservation not found.", {
    body: invalidRelease.body,
  });
  pass("invalid release fails closed");
}

function verifyCreditAuthorityRemainsMonolith() {
  const authority = String(process.env.CREDIT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "CREDIT_AUTHORITY must not be SERVICE in reserve/release QA.", {
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
  assert(!guardrail.productionReady, "Reserve/release baseline must not report SERVICE production ready.", {
    guardrail,
  });
  pass("guardrails still keep CREDIT authority MONOLITH");
}

async function main() {
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await verifyHealth();
    await verifyReserveAndRelease(pool);
    await verifyFailures(pool);
    verifyCreditAuthorityRemainsMonolith();

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Credit Wallet reserve/release QA failed.");
});
