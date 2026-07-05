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

type SeededCreditWallet = QueryResultRow & {
  account_id: string;
  wallet_id: string;
  reservation_id: string;
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
    fail("DATABASE_URL is required for Credit Wallet durable baseline QA.");
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

async function seedCreditWallet(pool: Pool): Promise<SeededCreditWallet> {
  const accountId = randomUUID();
  const ticketId = `qa-credit-wallet-${randomUUID()}`;
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
    [accountId, `qa-credit-wallet-${suffix}`, `QA Credit Wallet ${suffix}`]
  );

  const result = await pool.query<SeededCreditWallet>(
    `
with wallet as (
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
  returning id, account_id
),
reservation as (
  insert into public.credit_reservations (
    player_id,
    ticket_id,
    amount,
    currency,
    status,
    reserved_amount,
    released_amount,
    settled_amount,
    remaining_exposure,
    idempotency_key,
    correlation_id,
    metadata
  )
  values ($1, $2, 250, 'USD', 'RESERVED', 250, 0, 0, 250, $3, $4, '{"source":"qa:credit-wallet-durable-baseline"}'::jsonb)
  returning id
)
select wallet.account_id::text,
       wallet.id::text as wallet_id,
       reservation.id::text as reservation_id
from wallet, reservation
`,
    [
      accountId,
      ticketId,
      `qa-credit-wallet-reserve-${randomUUID()}`,
      `qa-credit-wallet-${randomUUID()}`,
    ]
  );

  return result.rows[0];
}

async function verifyHealth() {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/health`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet health should pass with durable read storage.", {
    status: response.status,
    body,
  });
  assert(body?.dependencies?.database === "ready", "Credit Wallet database dependency should be ready.", {
    body,
  });
  assert(body?.capabilities?.durablePersistenceConfigured === true, "Durable persistence marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.readCapabilityEnabled === true, "Read capability marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.mutationCapabilityEnabled === true, "Reserve/release mutation capability marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.mutationCapabilityScope === "reserveReleaseSettleReconcileOnly", "Mutation capability scope should be reserve/release/settle/reconciliation only.", {
    body,
  });
  assert(body?.capabilities?.idempotencySupportConfigured === true, "Reserve/release idempotency marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.idempotencySupportScope === "reserveReleaseSettleReconcileOnly", "Idempotency scope should be reserve/release/settle/reconciliation only.", {
    body,
  });
  assert(body?.capabilities?.qaCapabilityMarkerPresent === true, "Read QA marker should be present.", {
    body,
  });
  pass("Credit Wallet health reports durable read capability only");

  return body;
}

async function verifySummary(accountId: string) {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${accountId}/summary`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet summary should return 200.", { status: response.status, body });
  assert(body?.playerId === accountId, "Summary should preserve player id.", { body });
  assert(body?.creditLimit?.amount === 1000, "Summary credit limit should match durable wallet.", { body });
  assert(body?.balance?.amount === 100, "Summary balance should match durable wallet.", { body });
  assert(body?.pendingExposure?.amount === 250, "Summary pending exposure should include open reservation.", { body });
  assert(body?.availableCredit?.amount === 850, "Summary available credit formula should be deterministic.", { body });
  pass("Credit Wallet summary reads durable wallet and exposure", { accountId });
}

async function verifyWallet(accountId: string) {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${accountId}`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet detail should return 200.", { status: response.status, body });
  assert(body?.playerId === accountId, "Wallet detail should preserve player id.", { body });
  assert(body?.availableCredit?.amount === 850, "Wallet detail should use durable summary values.", { body });
  pass("Credit Wallet detail reads durable wallet");
}

async function verifyExposure(accountId: string, reservationId: string) {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${accountId}/exposure?includeReservations=true`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet exposure should return 200.", { status: response.status, body });
  assert(body?.pendingExposure?.amount === 250, "Exposure should include pending reservation amount.", { body });
  assert(Array.isArray(body?.reservations), "Exposure should include reservations.", { body });
  assert(
    body.reservations.some((reservation: Record<string, unknown>) => reservation.reservationId === reservationId),
    "Exposure should include seeded reservation.",
    { body, reservationId }
  );
  pass("Credit Wallet exposure is deterministic");
}

async function verifyTransactions(accountId: string, reservationId: string) {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${accountId}/transactions?limit=10&sort=createdAt.asc`);
  const body = await readJson(response);

  assert(response.ok, "Credit Wallet transactions should return 200.", { status: response.status, body });
  assert(Array.isArray(body?.transactions), "Transactions response should contain a transaction list.", { body });
  assert(
    body.transactions.some((transaction: Record<string, unknown>) => transaction.id === reservationId && transaction.transactionType === "RESERVATION"),
    "Transactions should include seeded reservation.",
    { body, reservationId }
  );
  pass("Credit Wallet transactions read supported credit schema");
}

async function verifyMissingPlayerFailsClosed() {
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/${randomUUID()}/summary`);
  const body = await readJson(response);

  assert(response.status === 404, "Missing player should return explicit 404.", {
    status: response.status,
    body,
  });
  pass("Missing player fails closed with explicit not-found");
}

function verifyCreditAuthorityRemainsMonolith(capabilities: Record<string, unknown>) {
  const authority = String(process.env.CREDIT_AUTHORITY ?? "MONOLITH").toUpperCase();

  assert(authority !== "SERVICE", "CREDIT_AUTHORITY must not be SERVICE in durable read baseline QA.", {
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
    mutationCapabilityEnabled: capabilities.mutationCapabilityEnabled === true,
    durablePersistenceConfigured: capabilities.durablePersistenceConfigured === true,
    idempotencySupportConfigured: capabilities.idempotencySupportConfigured === true,
    qaCapabilityMarkerPresent: capabilities.qaCapabilityMarkerPresent === true,
  });

  assert(guardrail.productionStatus === "MONOLITH_ALLOWED", "Credit guardrail should keep MONOLITH allowed.", {
    guardrail,
  });
  assert(!guardrail.productionReady, "Read baseline must not report credit SERVICE production ready.", {
    guardrail,
  });
  pass("Credit authority guardrail remains MONOLITH");
}

async function main() {
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const health = await verifyHealth();
    const seeded = await seedCreditWallet(pool);

    await verifySummary(seeded.account_id);
    await verifyWallet(seeded.account_id);
    await verifyExposure(seeded.account_id, seeded.reservation_id);
    await verifyTransactions(seeded.account_id, seeded.reservation_id);
    await verifyMissingPlayerFailsClosed();
    verifyCreditAuthorityRemainsMonolith(health.capabilities ?? {});

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Credit Wallet durable baseline QA failed.");
});
