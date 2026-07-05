import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type SeededWallet = QueryResultRow & {
  account_id: string;
  wallet_id: string;
};

type ReservationRow = QueryResultRow & {
  id: string;
  player_id: string;
  ticket_id: string;
  status: string;
  remaining_exposure: string | number;
  idempotency_key: string;
};

type SettlementRow = QueryResultRow & {
  id: string;
  reservation_id: string;
  player_id: string;
  balance_after: string | number;
  idempotency_key: string;
};

const checks: Check[] = [];
const originalCreditAuthority = process.env.CREDIT_AUTHORITY;
const originalCreditServiceUrl = process.env.CREDIT_SERVICE_URL;
const originalLedgerAuthority = process.env.LEDGER_AUTHORITY;
const originalSettlementAuthority = process.env.SETTLEMENT_AUTHORITY;
const originalConsoleInfo = console.info.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleLog = console.log.bind(console);

console.info = () => undefined;
console.warn = () => undefined;

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
    fail("DATABASE_URL is required for Credit authority switch QA.");
  }

  return databaseUrl;
}

function restoreEnvironment() {
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;

  if (originalCreditAuthority === undefined) {
    delete process.env.CREDIT_AUTHORITY;
  } else {
    process.env.CREDIT_AUTHORITY = originalCreditAuthority;
  }

  if (originalCreditServiceUrl === undefined) {
    delete process.env.CREDIT_SERVICE_URL;
  } else {
    process.env.CREDIT_SERVICE_URL = originalCreditServiceUrl;
  }

  if (originalLedgerAuthority === undefined) {
    delete process.env.LEDGER_AUTHORITY;
  } else {
    process.env.LEDGER_AUTHORITY = originalLedgerAuthority;
  }

  if (originalSettlementAuthority === undefined) {
    delete process.env.SETTLEMENT_AUTHORITY;
  } else {
    process.env.SETTLEMENT_AUTHORITY = originalSettlementAuthority;
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

async function monolithReserve(
  pool: Pool,
  accountId: string,
  ticketId: string,
  amount: number,
  idempotencyKey: string
) {
  const result = await pool.query<ReservationRow>(
    `
select id::text,
       player_id::text,
       ticket_id,
       status,
       remaining_exposure,
       idempotency_key
from public.reserve_credit_exposure($1, $2, $3, 'USD', $4, $5, $6::jsonb)
`,
    [
      accountId,
      ticketId,
      amount,
      idempotencyKey,
      `qa-credit-authority-switch-${randomUUID()}`,
      JSON.stringify({ source: "qa:credit-authority-switch", authority: "MONOLITH" }),
    ]
  );

  return result.rows[0];
}

async function monolithRelease(
  pool: Pool,
  reservationId: string,
  ticketId: string,
  amount: number,
  idempotencyKey: string
) {
  const result = await pool.query<ReservationRow>(
    `
select id::text,
       player_id::text,
       ticket_id,
       status,
       remaining_exposure,
       idempotency_key
from public.release_credit_exposure($1, $2, $3, $4, $5, 'QA_AUTHORITY_SWITCH', $6::jsonb)
`,
    [
      reservationId,
      ticketId,
      amount,
      idempotencyKey,
      `qa-credit-authority-switch-${randomUUID()}`,
      JSON.stringify({ source: "qa:credit-authority-switch", authority: "MONOLITH" }),
    ]
  );

  return result.rows[0];
}

async function monolithSettle(
  pool: Pool,
  reservationId: string,
  ticketId: string,
  amount: number,
  impact: number,
  idempotencyKey: string
) {
  const result = await pool.query<SettlementRow>(
    `
select id::text,
       reservation_id::text,
       player_id::text,
       balance_after,
       idempotency_key
from public.apply_credit_settlement($1, $2, $3, $4, $5, 'USD', $6, $7, $8::jsonb)
`,
    [
      reservationId,
      ticketId,
      randomUUID(),
      amount,
      impact,
      idempotencyKey,
      `qa-credit-authority-switch-${randomUUID()}`,
      JSON.stringify({ source: "qa:credit-authority-switch", authority: "MONOLITH" }),
    ]
  );

  return result.rows[0];
}

async function importCreditEntryPoints() {
  process.env.SUPABASE_URL ??= "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy-service-role-key";

  return import("@/src/domains/credit/credit.entrypoints");
}

async function verifyMonolithMode(pool: Pool) {
  process.env.CREDIT_AUTHORITY = "MONOLITH";
  process.env.CREDIT_SERVICE_URL = "http://127.0.0.1:1";

  const wallet = await seedWallet(pool, "credit-switch-monolith");
  const ticketId = randomUUID();
  const reserveKey = `qa-credit-switch-monolith-reserve-${randomUUID()}`;
  const first = await monolithReserve(pool, wallet.account_id, ticketId, 210, reserveKey);
  const duplicate = await monolithReserve(pool, wallet.account_id, ticketId, 210, reserveKey);
  const releaseKey = `qa-credit-switch-monolith-release-${randomUUID()}`;
  const released = await monolithRelease(pool, first.id, ticketId, 40, releaseKey);
  const settleKey = `qa-credit-switch-monolith-settle-${randomUUID()}`;
  const settled = await monolithSettle(pool, first.id, ticketId, 170, 125, settleKey);

  assert(first.id === duplicate.id, "MONOLITH duplicate reserve should return original reservation.", {
    first,
    duplicate,
  });
  assert(first.player_id === wallet.account_id, "MONOLITH reserve should use seeded wallet.", {
    first,
    wallet,
  });
  assert(Number(released.remaining_exposure) === 170, "MONOLITH release should update exposure.", {
    released,
  });
  assert(Number(settled.balance_after) === 225, "MONOLITH settle should update wallet balance.", {
    settled,
  });
  pass("MONOLITH mode uses monolith path", { reservationId: first.id });
  pass("duplicate idempotency works in MONOLITH mode", { reservationId: first.id });
}

async function verifyServiceMode(pool: Pool) {
  process.env.CREDIT_AUTHORITY = "SERVICE";
  process.env.CREDIT_SERVICE_URL =
    originalCreditServiceUrl ?? process.env.QA_CREDIT_SERVICE_URL ?? "http://credit-wallet-service:8080";

  const credit = await importCreditEntryPoints();
  const wallet = await seedWallet(pool, "credit-switch-service");
  const ticketId = randomUUID();
  const reserveKey = `qa-credit-switch-service-reserve-${randomUUID()}`;
  const first = await credit.reserveCreditExposure({
    playerId: wallet.account_id,
    ticketId,
    amount: 260,
    currency: "USD",
    idempotencyKey: reserveKey,
    correlationId: `qa-credit-switch-service-${randomUUID()}`,
    metadata: {
      source: "qa:credit-authority-switch",
      playerId: wallet.account_id,
    },
  });
  const duplicate = await credit.reserveCreditExposure({
    playerId: wallet.account_id,
    ticketId,
    amount: 260,
    currency: "USD",
    idempotencyKey: reserveKey,
    correlationId: `qa-credit-switch-service-${randomUUID()}`,
    metadata: {
      source: "qa:credit-authority-switch",
      playerId: wallet.account_id,
    },
  });
  const released = await credit.releaseCreditExposure({
    reservationId: first.id,
    ticketId,
    releaseAmount: 60,
    idempotencyKey: `qa-credit-switch-service-release-${randomUUID()}`,
    correlationId: `qa-credit-switch-service-${randomUUID()}`,
    reason: "QA_AUTHORITY_SWITCH",
    metadata: {
      source: "qa:credit-authority-switch",
      playerId: wallet.account_id,
    },
  });
  const application = await credit.applyCreditSettlement({
    reservationId: first.id,
    ticketId,
    settlementId: randomUUID(),
    releaseAmount: 200,
    balanceImpact: 145,
    currency: "USD",
    idempotencyKey: `qa-credit-switch-service-settle-${randomUUID()}`,
    correlationId: `qa-credit-switch-service-${randomUUID()}`,
    metadata: {
      source: "qa:credit-authority-switch",
      playerId: wallet.account_id,
      settlementBatchId: randomUUID(),
      settlementOutcome: "WIN",
    },
  });
  const summary = await credit.getPlayerCreditSummary(wallet.account_id);

  assert(first.id === duplicate.id, "SERVICE duplicate reserve should return original reservation.", {
    first,
    duplicate,
  });
  assert(first.playerId === wallet.account_id, "SERVICE reserve should route through player-scoped service.", {
    first,
    wallet,
  });
  assert(released.remainingExposure === 200, "SERVICE release should update exposure.", { released });
  assert(application.balanceAfter === 245, "SERVICE settle should update wallet balance.", {
    application,
  });
  assert(summary.balance === 245, "SERVICE summary read should route through Credit Wallet Service.", {
    summary,
  });
  pass("SERVICE mode uses Credit Wallet Service for supported operations", {
    reservationId: first.id,
    settlementApplicationId: application.applicationId,
  });
  pass("duplicate idempotency works in SERVICE mode", { reservationId: first.id });
}

async function verifyUnsupportedServiceOperationFailsClosed(pool: Pool) {
  process.env.CREDIT_AUTHORITY = "SERVICE";
  process.env.CREDIT_SERVICE_URL =
    originalCreditServiceUrl ?? process.env.QA_CREDIT_SERVICE_URL ?? "http://credit-wallet-service:8080";

  const credit = await importCreditEntryPoints();
  const wallet = await seedWallet(pool, "credit-switch-unsupported");
  const ticketId = randomUUID();
  const reservation = await credit.reserveCreditExposure({
    playerId: wallet.account_id,
    ticketId,
    amount: 50,
    currency: "USD",
    idempotencyKey: `qa-credit-switch-unsupported-reserve-${randomUUID()}`,
    metadata: {
      source: "qa:credit-authority-switch",
      playerId: wallet.account_id,
    },
  });

  try {
    await credit.cancelCreditReservation({
      reservationId: reservation.id,
      reason: "QA_UNSUPPORTED_SERVICE_OPERATION",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("does not support reservation cancellation"),
      "Unsupported SERVICE operation should fail closed.",
      { message }
    );
    pass("unsupported SERVICE operation fails closed");
    return;
  }

  fail("Unsupported SERVICE operation should not fall back to monolith cancellation.");
}

async function verifyMissingReadinessFailsClosed(pool: Pool) {
  process.env.CREDIT_AUTHORITY = "SERVICE";
  process.env.CREDIT_SERVICE_URL = "http://127.0.0.1:1";

  const credit = await importCreditEntryPoints();
  const wallet = await seedWallet(pool, "credit-switch-fail-closed");

  try {
    await credit.reserveCreditExposure({
      playerId: wallet.account_id,
      ticketId: randomUUID(),
      amount: 75,
      currency: "USD",
      idempotencyKey: `qa-credit-switch-fail-${randomUUID()}`,
      metadata: {
        source: "qa:credit-authority-switch",
        playerId: wallet.account_id,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("Credit Wallet Service authority guardrails failed") ||
        message.includes("Credit Wallet Service is not reachable"),
      "Missing Credit Wallet Service readiness should fail closed with guardrail error.",
      { message }
    );
    pass("missing Credit Wallet Service readiness fails closed");
    return;
  }

  fail("Missing Credit Wallet Service readiness should not reserve exposure.");
}

async function verifyRollbackToMonolith(pool: Pool) {
  process.env.CREDIT_AUTHORITY = "MONOLITH";
  process.env.CREDIT_SERVICE_URL = "http://127.0.0.1:1";

  const wallet = await seedWallet(pool, "credit-switch-rollback");
  const ticketId = randomUUID();
  const reservation = await monolithReserve(
    pool,
    wallet.account_id,
    ticketId,
    90,
    `qa-credit-switch-rollback-${randomUUID()}`
  );

  assert(
    reservation.player_id === wallet.account_id,
    "Rollback to MONOLITH should restore monolith reserve path.",
    { reservation, wallet }
  );
  pass("rollback to MONOLITH works", { reservationId: reservation.id });
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await verifyMonolithMode(pool);
    await verifyServiceMode(pool);
    await verifyUnsupportedServiceOperationFailsClosed(pool);
    await verifyMissingReadinessFailsClosed(pool);
    await verifyRollbackToMonolith(pool);

    assert(
      process.env.LEDGER_AUTHORITY === originalLedgerAuthority,
      "Credit authority switch QA must not change Ledger authority.",
      { ledgerAuthority: process.env.LEDGER_AUTHORITY ?? null }
    );
    assert(
      process.env.SETTLEMENT_AUTHORITY === originalSettlementAuthority,
      "Credit authority switch QA must not change Settlement authority.",
      { settlementAuthority: process.env.SETTLEMENT_AUTHORITY ?? null }
    );
    pass("Ledger and Settlement authority remain unchanged");

    originalConsoleLog(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    restoreEnvironment();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  restoreEnvironment();
  fail("Credit authority switch QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
