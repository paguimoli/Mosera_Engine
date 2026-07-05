import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type WalletRow = QueryResultRow & {
  id: string;
  account_id: string;
};

type LedgerEntryRow = QueryResultRow & {
  id: string;
  wallet_id: string;
  account_id: string;
  transaction_type: string;
  direction: string;
  amount: string | number;
  balance_after: string | number;
  currency_code: string;
  idempotency_key: string | null;
};

type LedgerEntry = {
  id: string;
  walletId: string;
  balanceAfter: number;
  idempotencyKey: string | null;
};

const checks: Check[] = [];
const originalLedgerAuthority = process.env.LEDGER_AUTHORITY;
const originalLedgerServiceUrl = process.env.LEDGER_SERVICE_URL;

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
    fail("DATABASE_URL is required for Ledger authority switch QA.");
  }

  return databaseUrl;
}

function restoreEnvironment() {
  if (originalLedgerAuthority === undefined) {
    delete process.env.LEDGER_AUTHORITY;
  } else {
    process.env.LEDGER_AUTHORITY = originalLedgerAuthority;
  }

  if (originalLedgerServiceUrl === undefined) {
    delete process.env.LEDGER_SERVICE_URL;
  } else {
    process.env.LEDGER_SERVICE_URL = originalLedgerServiceUrl;
  }
}

async function seedWallet(pool: Pool, label: string) {
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
    [accountId, `qa-${label}-${suffix}`, `QA ${label} ${suffix}`]
  );

  const wallet = await pool.query<WalletRow>(
    `
insert into public.financial_wallets (
  account_id,
  wallet_type,
  currency_code,
  balance_authority,
  status,
  balance,
  funding_model
)
values ($1, 'CASH', 'USD', 'INTERNAL', 'ACTIVE', 0, 'CASH')
returning id::text, account_id::text
`,
    [accountId]
  );

  return wallet.rows[0];
}

function mapLedgerEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    walletId: row.wallet_id,
    balanceAfter: Number(row.balance_after),
    idempotencyKey: row.idempotency_key,
  };
}

async function postMonolithLedgerEntry(pool: Pool, walletId: string, idempotencyKey: string, amount: number) {
  const result = await pool.query<LedgerEntryRow>(
    `
select
  id::text,
  wallet_id::text,
  account_id::text,
  transaction_type,
  direction,
  amount,
  balance_after,
  currency_code,
  idempotency_key
from public.post_financial_ledger_entry(
  $1,
  'MANUAL_CREDIT_ADJUSTMENT',
  'CREDIT',
  $2,
  'qa_ledger_authority_switch',
  $3,
  $3,
  cast($4 as jsonb),
  null
)
`,
    [
      walletId,
      amount,
      idempotencyKey,
      JSON.stringify({
        qa: "ledger-authority-switch",
        authority: "MONOLITH",
      }),
    ]
  );

  return mapLedgerEntry(result.rows[0]);
}

async function postThroughAuthorityRouter(walletId: string, idempotencyKey: string, amount: number) {
  process.env.SUPABASE_URL ??= "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy-service-role-key";
  const { postLedgerEntry } = await import("@/src/domains/ledger/ledger.entrypoints");

  return postLedgerEntry({
    walletId,
    transactionType: "MANUAL_CREDIT_ADJUSTMENT",
    direction: "CREDIT",
    amount,
    reference: {
      referenceType: "qa_ledger_authority_switch",
      referenceId: idempotencyKey,
    },
    idempotencyKey,
    metadata: {
      qa: "ledger-authority-switch",
      authority: process.env.LEDGER_AUTHORITY ?? "MONOLITH",
    },
  });
}

async function verifyMonolithMode(pool: Pool) {
  process.env.LEDGER_AUTHORITY = "MONOLITH";
  process.env.LEDGER_SERVICE_URL = "http://127.0.0.1:1";

  const wallet = await seedWallet(pool, "ledger-switch-monolith");
  const idempotencyKey = `qa-ledger-switch-monolith-${randomUUID()}`;
  const first = await postMonolithLedgerEntry(pool, wallet.id, idempotencyKey, 11);
  const duplicate = await postMonolithLedgerEntry(pool, wallet.id, idempotencyKey, 11);

  assert(first.id === duplicate.id, "MONOLITH duplicate idempotency should return existing entry.", {
    first,
    duplicate,
  });
  assert(first.walletId === wallet.id, "MONOLITH post should use seeded wallet.", { first, wallet });
  assert(first.balanceAfter === 11, "MONOLITH post should update wallet balance.", { first });
  pass("MONOLITH mode posts through monolith path", { ledgerEntryId: first.id });
  pass("duplicate idempotency works in MONOLITH mode", { ledgerEntryId: first.id });
}

async function verifyServiceMode(pool: Pool) {
  process.env.LEDGER_AUTHORITY = "SERVICE";
  process.env.LEDGER_SERVICE_URL = originalLedgerServiceUrl ?? "http://ledger-service:8080";

  const wallet = await seedWallet(pool, "ledger-switch-service");
  const idempotencyKey = `qa-ledger-switch-service-${randomUUID()}`;
  const first = await postThroughAuthorityRouter(wallet.id, idempotencyKey, 13);
  const duplicate = await postThroughAuthorityRouter(wallet.id, idempotencyKey, 13);

  assert(first.id === duplicate.id, "SERVICE duplicate idempotency should return existing entry.", {
    first,
    duplicate,
  });
  assert(first.walletId === wallet.id, "SERVICE post should use seeded wallet.", { first, wallet });
  assert(first.balanceAfter === 13, "SERVICE post should update wallet balance.", { first });
  pass("SERVICE mode posts through Ledger Service", { ledgerEntryId: first.id });
  pass("duplicate idempotency works in SERVICE mode", { ledgerEntryId: first.id });
}

async function verifyMissingReadinessFailsClosed(pool: Pool) {
  process.env.LEDGER_AUTHORITY = "SERVICE";
  process.env.LEDGER_SERVICE_URL = "http://127.0.0.1:1";

  const wallet = await seedWallet(pool, "ledger-switch-fail-closed");
  const idempotencyKey = `qa-ledger-switch-fail-${randomUUID()}`;

  try {
    await postThroughAuthorityRouter(wallet.id, idempotencyKey, 17);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("Ledger Service authority guardrails failed") ||
        message.includes("Ledger Service is not reachable"),
      "Missing Ledger Service readiness should fail closed with guardrail error.",
      { message }
    );
    pass("missing Ledger Service readiness fails closed");
    return;
  }

  fail("Missing Ledger Service readiness should not post a ledger entry.");
}

async function verifyRollbackToMonolith(pool: Pool) {
  process.env.LEDGER_AUTHORITY = "MONOLITH";
  process.env.LEDGER_SERVICE_URL = "http://127.0.0.1:1";

  const wallet = await seedWallet(pool, "ledger-switch-rollback");
  const idempotencyKey = `qa-ledger-switch-rollback-${randomUUID()}`;
  const entry = await postMonolithLedgerEntry(pool, wallet.id, idempotencyKey, 19);

  assert(entry.walletId === wallet.id, "Rollback to MONOLITH should restore monolith ledger posting.", {
    entry,
    wallet,
  });
  assert(entry.balanceAfter === 19, "Rollback MONOLITH post should update wallet balance.", { entry });
  pass("rollback to MONOLITH works", { ledgerEntryId: entry.id });
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
    await verifyMissingReadinessFailsClosed(pool);
    await verifyRollbackToMonolith(pool);

    assert(process.env.CREDIT_AUTHORITY !== "SERVICE", "CREDIT_AUTHORITY must not be changed by Ledger switch QA.", {
      creditAuthority: process.env.CREDIT_AUTHORITY ?? null,
    });
    assert(
      process.env.SETTLEMENT_AUTHORITY !== "SERVICE",
      "SETTLEMENT_AUTHORITY must not be changed by Ledger switch QA.",
      {
        settlementAuthority: process.env.SETTLEMENT_AUTHORITY ?? null,
      }
    );
    pass("Credit and Settlement authority remain unchanged");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    restoreEnvironment();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  restoreEnvironment();
  fail("Ledger authority switch QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
