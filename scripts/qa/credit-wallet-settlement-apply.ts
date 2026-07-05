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
    fail("DATABASE_URL is required for Credit Wallet settlement apply QA.");
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
    [accountId, `qa-credit-settle-${suffix}`, `QA Credit Settle ${suffix}`]
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
      "x-correlation-id": `qa-credit-wallet-settlement-apply-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    body: await readJson(response),
  };
}

async function reserve(accountId: string, ticketId: string, amount: number, idempotencyKey: string) {
  return postJson(
    `/v1/credit-wallets/${accountId}/reserve`,
    {
      ticketId,
      amount: {
        amount,
        currency: "USD",
      },
      metadata: {
        source: "qa:credit-wallet-settlement-apply",
      },
    },
    idempotencyKey
  );
}

async function settle({
  accountId,
  reservationId,
  ticketId,
  releaseAmount,
  balanceImpact,
  idempotencyKey,
}: {
  accountId: string;
  reservationId: string;
  ticketId: string;
  releaseAmount: number;
  balanceImpact: number;
  idempotencyKey: string;
}) {
  return postJson(
    `/v1/credit-wallets/${accountId}/settle`,
    {
      settlementId: randomUUID(),
      settlementBatchId: randomUUID(),
      reservationId,
      ticketId,
      releaseAmount: {
        amount: releaseAmount,
        currency: "USD",
      },
      balanceImpact: {
        amount: balanceImpact,
        currency: "USD",
      },
      outcome: "WIN",
      metadata: {
        source: "qa:credit-wallet-settlement-apply",
      },
    },
    idempotencyKey
  );
}

async function getSummary(accountId: string) {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${accountId}/summary`);

  return {
    response,
    body: await readJson(response),
  };
}

async function verifyHealth() {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/health`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet health should pass.", { status: response.status, body });
  assert(body?.capabilities?.mutationCapabilityEnabled === true, "Settlement mutation marker should be enabled.", { body });
  assert(body?.capabilities?.mutationCapabilityScope === "reserveReleaseSettleReconcileOnly", "Mutation scope should be reserve/release/settle/reconciliation only.", { body });
  assert(body?.capabilities?.idempotencySupportConfigured === true, "Settlement idempotency marker should be enabled.", { body });
  assert(body?.capabilities?.idempotencySupportScope === "reserveReleaseSettleReconcileOnly", "Idempotency scope should be reserve/release/settle/reconciliation only.", { body });
  assert(body?.capabilities?.qaCapabilityMarkerPresent === true, "Settlement QA marker should be present.", { body });
  pass("Credit Wallet health reports reserve/release/settle/reconciliation capability only");
}

async function verifyReserveThenSettle(pool: Pool) {
  const wallet = await seedWallet(pool);
  const ticketId = randomUUID();
  const reserveKey = `qa-credit-settle-reserve-${randomUUID()}`;
  const reserved = await reserve(wallet.account_id, ticketId, 200, reserveKey);

  assert(reserved.response.ok, "Reserve before settlement should succeed.", {
    status: reserved.response.status,
    body: reserved.body,
  });
  assert(reserved.body?.remainingExposure?.amount === 200, "Reserve should create pending exposure.", {
    body: reserved.body,
  });

  const settleKey = `qa-credit-settle-${randomUUID()}`;
  const settled = await settle({
    accountId: wallet.account_id,
    reservationId: reserved.body.reservationId,
    ticketId,
    releaseAmount: 200,
    balanceImpact: 150,
    idempotencyKey: settleKey,
  });

  assert(settled.response.ok, "Settlement apply should succeed.", {
    status: settled.response.status,
    body: settled.body,
  });
  assert(settled.body?.reservationId === reserved.body.reservationId, "Settlement should preserve reservation id.", {
    body: settled.body,
  });
  assert(settled.body?.releaseAmount?.amount === 200, "Settlement should report released exposure.", {
    body: settled.body,
  });
  assert(settled.body?.balanceImpact?.amount === 150, "Settlement should report balance impact.", {
    body: settled.body,
  });
  assert(settled.body?.balanceBefore?.amount === 100, "Settlement should capture balance before.", {
    body: settled.body,
  });
  assert(settled.body?.balanceAfter?.amount === 250, "Settlement should capture balance after.", {
    body: settled.body,
  });
  pass("reserve then settle succeeds", { settlementApplicationId: settled.body.settlementApplicationId });

  const duplicate = await settle({
    accountId: wallet.account_id,
    reservationId: reserved.body.reservationId,
    ticketId,
    releaseAmount: 200,
    balanceImpact: 150,
    idempotencyKey: settleKey,
  });

  assert(duplicate.response.ok, "Duplicate settlement should be idempotent.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  assert(
    duplicate.body?.settlementApplicationId === settled.body?.settlementApplicationId &&
      duplicate.body?.balanceBefore?.amount === 100 &&
      duplicate.body?.balanceAfter?.amount === 250,
    "Duplicate settlement should return original application without double adjustment.",
    { settled: settled.body, duplicate: duplicate.body }
  );
  pass("duplicate settlement idempotent");

  const summary = await getSummary(wallet.account_id);
  assert(summary.response.ok, "Summary after settlement should succeed.", {
    status: summary.response.status,
    body: summary.body,
  });
  assert(summary.body?.balance?.amount === 250, "Settlement should update wallet balance once.", {
    body: summary.body,
  });
  assert(summary.body?.pendingExposure?.amount === 0, "Settlement should clear settled exposure.", {
    body: summary.body,
  });
  assert(summary.body?.availableCredit?.amount === 1250, "Settlement should update available credit deterministically.", {
    body: summary.body,
  });
  pass("settlement updates wallet/exposure correctly");
}

async function verifyInvalidSettlementFailsClosed(pool: Pool) {
  const wallet = await seedWallet(pool);
  const invalid = await settle({
    accountId: wallet.account_id,
    reservationId: randomUUID(),
    ticketId: randomUUID(),
    releaseAmount: 50,
    balanceImpact: 25,
    idempotencyKey: `qa-credit-invalid-settle-${randomUUID()}`,
  });

  assert(invalid.response.status === 400, "Invalid settlement should fail closed.", {
    status: invalid.response.status,
    body: invalid.body,
  });
  assert(invalid.body?.error?.code === "CREDIT_RESERVATION_NOT_FOUND", "Invalid settlement should report reservation not found.", {
    body: invalid.body,
  });
  pass("invalid settlement fails closed");
}

function verifyCreditAuthorityRemainsMonolith() {
  const authority = String(process.env.CREDIT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "CREDIT_AUTHORITY must not be SERVICE in settlement apply QA.", {
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
  assert(!guardrail.productionReady, "Settlement apply baseline must not report SERVICE production ready.", {
    guardrail,
  });
  pass("guardrails still keep CREDIT authority MONOLITH");
}

async function main() {
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await verifyHealth();
    await verifyReserveThenSettle(pool);
    await verifyInvalidSettlementFailsClosed(pool);
    verifyCreditAuthorityRemainsMonolith();

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Credit Wallet settlement apply QA failed.");
});
