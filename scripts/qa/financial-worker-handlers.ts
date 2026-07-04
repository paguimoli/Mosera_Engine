import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

import {
  handleWorkloadMessage,
  FinancialWorkerNonRetryableError,
} from "@/src/domains/workers/financial-worker-handlers";
import type { QueueMessage } from "@/src/lib/queue/queue.types";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type CashierTransactionRow = QueryResultRow & {
  id: string;
  account_id: string;
  wallet_id: string;
  ledger_entry_id: string | null;
};

type CountRow = QueryResultRow & {
  count: string;
};

type HandlerRow = QueryResultRow & {
  handling_status: string;
  error_message: string | null;
};

const checks: Check[] = [];
const output = {
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

console.info = () => undefined;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

function fail(message: string, metadata: Record<string, unknown> = {}) {
  output.error(JSON.stringify({ status: "FAIL", message, ...metadata, checks }, null, 2));
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
    fail("DATABASE_URL is required for financial worker QA.");
  }

  return databaseUrl;
}

async function seedCompletedCashierTransaction(pool: Pool) {
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
    [accountId, `qa-worker-${suffix}`, `QA Worker ${suffix}`]
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
values ($1, $2, 'CASH', 'USD', 'INTERNAL', 'ACTIVE', 0, 'CASH')
`,
    [walletId, accountId]
  );

  const transaction = await pool.query<CashierTransactionRow>(
    `
insert into public.cashier_transactions (
  account_id,
  wallet_id,
  transaction_type,
  status,
  amount,
  currency_code,
  approved_at
)
values ($1, $2, 'DEPOSIT', 'APPROVED', 50, 'USD', now())
returning *
`,
    [accountId, walletId]
  );

  const completed = await pool.query<CashierTransactionRow>(
    `
select *
from public.complete_cashier_transaction_atomically(
  $1::uuid,
  null,
  '{"qa":"financial-worker"}'::jsonb,
  $2,
  false
)
`,
    [transaction.rows[0].id, `qa-worker-${transaction.rows[0].id}`]
  );

  return completed.rows[0];
}

async function ledgerCount(pool: Pool, transactionId: string) {
  const result = await pool.query<CountRow>(
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

async function handlerRow(pool: Pool, eventId: string) {
  const result = await pool.query<HandlerRow>(
    `
select handling_status, error_message
from public.financial_worker_event_handlers
where event_id = $1
`,
    [eventId]
  );

  return result.rows[0] ?? null;
}

async function verifyValidAndDuplicate(pool: Pool) {
  const transaction = await seedCompletedCashierTransaction(pool);
  const eventId = `qa-worker-event-${randomUUID()}`;
  const message: QueueMessage = {
    id: eventId,
    type: "cashier.transaction.completed",
    aggregateType: "cashier_transaction",
    aggregateId: transaction.id,
    correlationId: `qa-worker-${transaction.id}`,
    payload: {
      transactionId: transaction.id,
      ledgerEntryId: transaction.ledger_entry_id,
    },
  };

  const result = await handleWorkloadMessage({
    category: "CRITICAL_FINANCIAL",
    message,
  });

  assert(result.status === "HANDLED", "Valid cashier completion event should be handled.", {
    result,
  });
  assert((await ledgerCount(pool, transaction.id)) === 1, "Worker must not double-post ledger.");
  pass("valid cashier completion event handled idempotently");

  const duplicate = await handleWorkloadMessage({
    category: "CRITICAL_FINANCIAL",
    message,
  });

  assert(duplicate.duplicate === true, "Duplicate event should be detected as duplicate.", {
    duplicate,
  });
  assert((await ledgerCount(pool, transaction.id)) === 1, "Duplicate event must not double-post ledger.");
  pass("duplicate event ignored idempotently");
}

async function verifyMalformed(pool: Pool) {
  const eventId = `qa-worker-malformed-${randomUUID()}`;
  const message: QueueMessage = {
    id: eventId,
    type: "cashier.transaction.completed",
    aggregateType: "cashier_transaction",
    aggregateId: null,
    correlationId: `qa-worker-malformed-${eventId}`,
    payload: {},
  };

  try {
    await handleWorkloadMessage({
      category: "CRITICAL_FINANCIAL",
      message,
    });
  } catch (error) {
    assert(
      error instanceof FinancialWorkerNonRetryableError,
      "Malformed event should fail with a financial worker error.",
      { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }
    );
    const row = await handlerRow(pool, eventId);
    assert(row?.handling_status === "FAILED", "Malformed event should be recorded as failed.", {
      row,
    });
    pass("malformed event fails safely");
    return;
  }

  fail("Malformed event should fail safely.");
}

async function verifyUnsupported(pool: Pool) {
  const eventId = `qa-worker-unsupported-${randomUUID()}`;
  const message: QueueMessage = {
    id: eventId,
    type: "ledger.entry.posted",
    aggregateType: "ledger_entry",
    aggregateId: randomUUID(),
    correlationId: `qa-worker-unsupported-${eventId}`,
    payload: {},
  };

  const result = await handleWorkloadMessage({
    category: "CRITICAL_FINANCIAL",
    message,
  });

  const row = await handlerRow(pool, eventId);

  assert(result.status === "NO_OP", "Unsupported event should be explicit no-op.", {
    result,
  });
  assert(row?.handling_status === "NO_OP", "Unsupported event should persist no-op status.", {
    row,
  });
  pass("unsupported event logs explicit no-op");
}

async function verifySettlementAndReconciliationNoOps(pool: Pool) {
  const settlementEventId = `qa-worker-settlement-${randomUUID()}`;
  const reconciliationEventId = `qa-worker-reconciliation-${randomUUID()}`;

  const settlement = await handleWorkloadMessage({
    category: "CRITICAL_FINANCIAL",
    message: {
      id: settlementEventId,
      type: "settlement.ledger_effect.generated",
      aggregateType: "settlement_ledger_effect",
      aggregateId: randomUUID(),
      correlationId: settlementEventId,
      payload: {},
    },
  });
  const reconciliation = await handleWorkloadMessage({
    category: "RECONCILIATION",
    message: {
      id: reconciliationEventId,
      type: "reconciliation.run.reviewed",
      aggregateType: "reconciliation_run",
      aggregateId: randomUUID(),
      correlationId: reconciliationEventId,
      payload: {},
    },
  });

  assert(settlement.status === "NO_OP", "Settlement ledger effect event should remain no-op.", {
    settlement,
  });
  assert(reconciliation.status === "NO_OP", "Reconciliation trigger should remain no-op.", {
    reconciliation,
  });
  assert((await handlerRow(pool, settlementEventId))?.handling_status === "NO_OP", "Settlement no-op should persist.");
  assert((await handlerRow(pool, reconciliationEventId))?.handling_status === "NO_OP", "Reconciliation no-op should persist.");
  pass("settlement and reconciliation events preserve explicit no-op behavior");
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await verifyValidAndDuplicate(pool);
    await verifyMalformed(pool);
    await verifyUnsupported(pool);
    await verifySettlementAndReconciliationNoOps(pool);

    output.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Financial worker handler QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
