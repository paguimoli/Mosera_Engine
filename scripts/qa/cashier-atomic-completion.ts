import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type CashierTransactionRow = QueryResultRow & {
  id: string;
  account_id: string;
  wallet_id: string;
  transaction_type: "DEPOSIT" | "WITHDRAWAL";
  status: string;
  amount: string | number;
  ledger_entry_id: string | null;
  completed_at: string | Date | null;
};

type LedgerCountRow = QueryResultRow & {
  count: string;
};

type WalletRow = QueryResultRow & {
  balance: string | number;
};

type OutboxRow = QueryResultRow & {
  count: string;
};

const checks: Check[] = [];

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
    fail("DATABASE_URL is required for cashier atomic completion QA.");
  }

  return databaseUrl;
}

async function seedAccountAndWallet(pool: Pool, balance: number) {
  const accountId = randomUUID();
  const walletId = randomUUID();
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
    [accountId, `qa-cashier-${suffix}`, `QA Cashier ${suffix}`]
  );

  await pool.query(
    `
insert into public.financial_wallets (
  id,
  account_id,
  wallet_type,
  currency_code,
  balance_authority,
  status,
  balance,
  funding_model
)
values ($1, $2, 'CASH', 'USD', 'INTERNAL', 'ACTIVE', $3, 'CASH')
`,
    [walletId, accountId, balance]
  );

  return { accountId, walletId };
}

async function seedTransaction({
  pool,
  accountId,
  walletId,
  transactionType,
  status = "APPROVED",
  amount,
}: {
  pool: Pool;
  accountId: string;
  walletId: string;
  transactionType: "DEPOSIT" | "WITHDRAWAL";
  status?: string;
  amount: number;
}) {
  const result = await pool.query<CashierTransactionRow>(
    `
insert into public.cashier_transactions (
  account_id,
  wallet_id,
  transaction_type,
  status,
  amount,
  currency_code,
  approved_at,
  metadata
)
values ($1, $2, $3, $4, $5, 'USD', case when $4 = 'APPROVED' then now() else null end, '{}'::jsonb)
returning *
`,
    [accountId, walletId, transactionType, status, amount]
  );

  return result.rows[0];
}

async function complete(pool: Pool, transactionId: string, simulateOutboxFailure = false) {
  const result = await pool.query<CashierTransactionRow>(
    `
select *
from public.complete_cashier_transaction_atomically(
  $1::uuid,
  null,
  '{"qa":true}'::jsonb,
  $2,
  $3
)
`,
    [transactionId, `qa-cashier-${transactionId}`, simulateOutboxFailure]
  );

  return result.rows[0];
}

async function ledgerCount(pool: Pool, transactionId: string) {
  const result = await pool.query<LedgerCountRow>(
    `
select count(*)::text as count
from public.financial_ledger_entries
where reference_type = 'cashier_transaction'
  and reference_id = $1
`,
    [transactionId]
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function outboxCount(pool: Pool, transactionId: string) {
  const result = await pool.query<OutboxRow>(
    `
select count(*)::text as count
from public.outbox_events
where event_type = 'cashier.transaction.completed'
  and aggregate_type = 'cashier_transaction'
  and aggregate_id = $1
`,
    [transactionId]
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function walletBalance(pool: Pool, walletId: string) {
  const result = await pool.query<WalletRow>(
    `
select balance
from public.financial_wallets
where id = $1
`,
    [walletId]
  );

  return Number(result.rows[0]?.balance ?? 0);
}

async function transactionStatus(pool: Pool, transactionId: string) {
  const result = await pool.query<CashierTransactionRow>(
    `
select *
from public.cashier_transactions
where id = $1
`,
    [transactionId]
  );

  return result.rows[0];
}

async function expectFailure(action: () => Promise<unknown>, message: string) {
  try {
    await action();
  } catch {
    return;
  }

  fail(message);
}

async function verifyDeposit(pool: Pool) {
  const { accountId, walletId } = await seedAccountAndWallet(pool, 0);
  const transaction = await seedTransaction({
    pool,
    accountId,
    walletId,
    transactionType: "DEPOSIT",
    amount: 125,
  });

  const completed = await complete(pool, transaction.id);

  assert(completed.status === "COMPLETED", "Deposit completion should mark transaction completed.", {
    completed,
  });
  assert(Boolean(completed.ledger_entry_id), "Deposit completion should store ledger entry id.", {
    completed,
  });
  assert((await ledgerCount(pool, transaction.id)) === 1, "Deposit completion should create one ledger entry.");
  assert((await walletBalance(pool, walletId)) === 125, "Deposit completion should credit wallet balance.");
  assert((await outboxCount(pool, transaction.id)) === 1, "Deposit completion should create one outbox event.");
  pass("deposit completion posts ledger, completes transaction, and creates outbox");

  const duplicate = await complete(pool, transaction.id);
  assert(duplicate.ledger_entry_id === completed.ledger_entry_id, "Duplicate completion should return same ledger entry.", {
    duplicate,
    completed,
  });
  assert((await ledgerCount(pool, transaction.id)) === 1, "Duplicate completion should not double-post ledger.");
  assert((await outboxCount(pool, transaction.id)) === 1, "Duplicate completion should not duplicate outbox.");
  assert((await walletBalance(pool, walletId)) === 125, "Duplicate completion should not move balance twice.");
  pass("duplicate completion is idempotent");
}

async function verifyWithdrawal(pool: Pool) {
  const { accountId, walletId } = await seedAccountAndWallet(pool, 200);
  const transaction = await seedTransaction({
    pool,
    accountId,
    walletId,
    transactionType: "WITHDRAWAL",
    amount: 75,
  });

  const completed = await complete(pool, transaction.id);

  assert(completed.status === "COMPLETED", "Withdrawal completion should mark transaction completed.", {
    completed,
  });
  assert((await ledgerCount(pool, transaction.id)) === 1, "Withdrawal completion should create one ledger entry.");
  assert((await walletBalance(pool, walletId)) === 125, "Withdrawal completion should debit wallet balance.");
  assert((await outboxCount(pool, transaction.id)) === 1, "Withdrawal completion should create one outbox event.");
  pass("withdrawal completion posts ledger, completes transaction, and creates outbox");
}

async function verifyInvalidState(pool: Pool) {
  const { accountId, walletId } = await seedAccountAndWallet(pool, 100);
  const transaction = await seedTransaction({
    pool,
    accountId,
    walletId,
    transactionType: "DEPOSIT",
    status: "PENDING",
    amount: 25,
  });

  await expectFailure(
    () => complete(pool, transaction.id),
    "Pending cashier transaction completion should fail."
  );

  assert((await ledgerCount(pool, transaction.id)) === 0, "Invalid state should not post ledger.");
  assert((await outboxCount(pool, transaction.id)) === 0, "Invalid state should not create outbox.");
  assert((await transactionStatus(pool, transaction.id)).status === "PENDING", "Invalid state should remain pending.");
  pass("invalid state is rejected without side effects");
}

async function verifyRollback(pool: Pool) {
  const { accountId, walletId } = await seedAccountAndWallet(pool, 0);
  const transaction = await seedTransaction({
    pool,
    accountId,
    walletId,
    transactionType: "DEPOSIT",
    amount: 30,
  });

  await expectFailure(
    () => complete(pool, transaction.id, true),
    "Simulated outbox failure should fail completion."
  );

  assert((await transactionStatus(pool, transaction.id)).status === "APPROVED", "Failed completion should leave transaction approved.");
  assert((await ledgerCount(pool, transaction.id)) === 0, "Failed completion should roll back ledger posting.");
  assert((await outboxCount(pool, transaction.id)) === 0, "Failed completion should not create outbox.");
  assert((await walletBalance(pool, walletId)) === 0, "Failed completion should roll back wallet movement.");
  pass("simulated failure rolls back transaction, ledger, wallet, and outbox");
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await verifyDeposit(pool);
    await verifyWithdrawal(pool);
    await verifyInvalidState(pool);
    await verifyRollback(pool);

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Cashier atomic completion QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
