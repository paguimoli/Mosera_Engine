import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { readAuthorityConfigurations } from "@/src/domains/authority-control/authority-control.repository";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type WalletRow = QueryResultRow & {
  id: string;
  account_id: string;
};

type LedgerEntry = {
  id: string;
  walletId: string;
  accountId: string;
  transactionType: string;
  direction: string;
  money: {
    amount: number;
    currency: string;
  };
  balanceAfter: {
    amount: number;
    currency: string;
  };
  idempotencyKey: string | null;
  reversalOfLedgerEntryId: string | null;
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
  reversal_of_ledger_entry_id: string | null;
};

const checks: Check[] = [];
const ledgerServiceUrl = trimTrailingSlash(process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080");

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
    fail("DATABASE_URL is required for Ledger Service authority dry-run QA.");
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

function mapLedgerRow(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    walletId: row.wallet_id,
    accountId: row.account_id,
    transactionType: row.transaction_type,
    direction: row.direction,
    money: {
      amount: Number(row.amount),
      currency: row.currency_code,
    },
    balanceAfter: {
      amount: Number(row.balance_after),
      currency: row.currency_code,
    },
    idempotencyKey: row.idempotency_key,
    reversalOfLedgerEntryId: row.reversal_of_ledger_entry_id,
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
  idempotency_key,
  reversal_of_ledger_entry_id::text
from public.post_financial_ledger_entry(
  $1,
  'DEPOSIT',
  'CREDIT',
  $2,
  'qa_ledger_authority_dry_run',
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
        qa: "ledger-service-authority-dry-run",
        path: "monolith",
      }),
    ]
  );

  return mapLedgerRow(result.rows[0]);
}

async function postServiceLedgerEntry(walletId: string, idempotencyKey: string, amount: number) {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-ledger-authority-${idempotencyKey}`,
    },
    body: JSON.stringify({
      walletId,
      transactionType: "DEPOSIT",
      direction: "CREDIT",
      money: {
        amount,
        currency: "USD",
      },
      reference: {
        type: "qa_ledger_authority_dry_run",
        id: idempotencyKey,
      },
      metadata: {
        qa: "ledger-service-authority-dry-run",
        path: "service",
      },
    }),
  });
  const body = await readJson(response);

  assert(response.ok, "Ledger Service dry-run post should succeed.", {
    status: response.status,
    body,
  });

  return body.ledgerEntry as LedgerEntry;
}

async function reverseServiceLedgerEntry(ledgerEntryId: string) {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries/${ledgerEntryId}/reverse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": `qa-ledger-reversal-${ledgerEntryId}`,
    },
    body: JSON.stringify({
      reason: "qa-ledger-service-authority-dry-run",
      actorUserId: null,
      metadata: {
        qa: "ledger-service-authority-dry-run",
      },
    }),
  });
  const body = await readJson(response);

  assert(response.ok, "Ledger Service reversal should succeed.", {
    status: response.status,
    body,
  });

  return body.ledgerEntry as LedgerEntry;
}

async function queryServiceAccountEntries(accountId: string) {
  const response = await fetch(
    `${ledgerServiceUrl}/v1/ledger/accounts/${accountId}/entries?limit=20&sort=createdAt.asc`
  );
  const body = await readJson(response);

  assert(response.ok, "Ledger Service account query should succeed.", {
    status: response.status,
    body,
  });

  return body.entries as LedgerEntry[];
}

async function verifyHealthEvidence() {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/health`);
  const body = await readJson(response);

  assert(response.ok, "Ledger Service health should be reachable.", { status: response.status, body });
  assert(body?.status === "ok", "Ledger Service should report ready.", { body });
  assert(body?.capabilities?.mutationCapabilityEnabled === true, "Mutation capability should be enabled.", {
    body,
  });
  assert(body?.capabilities?.durablePersistenceConfigured === true, "Durable persistence should be configured.", {
    body,
  });
  assert(body?.capabilities?.idempotencySupportConfigured === true, "Idempotency support should be configured.", {
    body,
  });
  assert(body?.capabilities?.qaCapabilityMarker === "ledger-service-authority-dry-run", "QA marker should be present.", {
    body,
  });
  assert(body?.capabilities?.serviceAuthorityEnabled === false, "Ledger Service authority must remain disabled.", {
    body,
  });
  pass("Ledger Service guardrail evidence is exposed");
}

function verifyAuthorityRemainsMonolith() {
  const authority = readAuthorityConfigurations().ledger;

  assert(authority.authority === "MONOLITH", "Ledger authority must remain MONOLITH.", { authority });
  assert(process.env.LEDGER_AUTHORITY !== "SERVICE", "LEDGER_AUTHORITY must not be SERVICE.", {
    ledgerAuthorityEnv: process.env.LEDGER_AUTHORITY ?? null,
  });
  pass("Ledger authority remains MONOLITH", { authority: authority.authority });
}

function verifyEquivalentFinancialResult(monolithEntry: LedgerEntry, serviceEntry: LedgerEntry) {
  assert(monolithEntry.transactionType === serviceEntry.transactionType, "Transaction types should match.", {
    monolithEntry,
    serviceEntry,
  });
  assert(monolithEntry.direction === serviceEntry.direction, "Directions should match.", {
    monolithEntry,
    serviceEntry,
  });
  assert(monolithEntry.money.amount === serviceEntry.money.amount, "Amounts should match.", {
    monolithEntry,
    serviceEntry,
  });
  assert(monolithEntry.money.currency === serviceEntry.money.currency, "Currencies should match.", {
    monolithEntry,
    serviceEntry,
  });
  assert(monolithEntry.balanceAfter.amount === serviceEntry.balanceAfter.amount, "Balance impact should match.", {
    monolithEntry,
    serviceEntry,
  });
  pass("monolith and Ledger Service posts produce equivalent financial result");
}

function verifyDuplicateHandling(first: LedgerEntry, duplicate: LedgerEntry, source: string) {
  assert(duplicate.id === first.id, `${source} duplicate idempotency should return existing entry.`, {
    first,
    duplicate,
  });
  assert(duplicate.idempotencyKey === first.idempotencyKey, `${source} duplicate should preserve idempotency key.`, {
    first,
    duplicate,
  });
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    verifyAuthorityRemainsMonolith();
    await verifyHealthEvidence();

    const amount = 41;
    const monolithWallet = await seedWallet(pool, "ledger-monolith-dry-run");
    const serviceWallet = await seedWallet(pool, "ledger-service-dry-run");
    const monolithIdempotencyKey = `qa-ledger-monolith-${randomUUID()}`;
    const serviceIdempotencyKey = `qa-ledger-service-${randomUUID()}`;

    const monolithEntry = await postMonolithLedgerEntry(pool, monolithWallet.id, monolithIdempotencyKey, amount);
    const monolithDuplicate = await postMonolithLedgerEntry(pool, monolithWallet.id, monolithIdempotencyKey, amount);
    verifyDuplicateHandling(monolithEntry, monolithDuplicate, "Monolith");

    const serviceEntry = await postServiceLedgerEntry(serviceWallet.id, serviceIdempotencyKey, amount);
    const serviceDuplicate = await postServiceLedgerEntry(serviceWallet.id, serviceIdempotencyKey, amount);
    verifyDuplicateHandling(serviceEntry, serviceDuplicate, "Ledger Service");
    pass("duplicate handling matches", {
      monolithEntryId: monolithEntry.id,
      serviceEntryId: serviceEntry.id,
    });

    verifyEquivalentFinancialResult(monolithEntry, serviceEntry);

    const reversal = await reverseServiceLedgerEntry(serviceEntry.id);
    const duplicateReversal = await reverseServiceLedgerEntry(serviceEntry.id);
    assert(duplicateReversal.id === reversal.id, "Duplicate reversal should return existing reversal.", {
      reversal,
      duplicateReversal,
    });
    assert(reversal.transactionType === "REVERSAL", "Reversal should use REVERSAL transaction type.", { reversal });
    assert(reversal.direction === "DEBIT", "Reversal should oppose the original CREDIT entry.", { reversal });
    assert(reversal.money.amount === serviceEntry.money.amount, "Reversal should preserve original amount.", {
      serviceEntry,
      reversal,
    });
    assert(reversal.reversalOfLedgerEntryId === serviceEntry.id, "Reversal should link to original entry.", {
      serviceEntry,
      reversal,
    });
    assert(reversal.balanceAfter.amount === 0, "Reversal should restore the service wallet balance to zero.", {
      serviceEntry,
      reversal,
    });
    pass("reversal produces correct opposing entry", {
      originalLedgerEntryId: serviceEntry.id,
      reversalLedgerEntryId: reversal.id,
    });

    const accountEntries = await queryServiceAccountEntries(serviceWallet.account_id);
    const accountEntryIds = new Set(accountEntries.map((entry) => entry.id));
    assert(
      accountEntryIds.has(serviceEntry.id) && accountEntryIds.has(reversal.id),
      "Account query should show original and reversal entries.",
      { accountEntries, serviceEntry, reversal }
    );
    pass("account query shows original and reversal", {
      accountId: serviceWallet.account_id,
      originalLedgerEntryId: serviceEntry.id,
      reversalLedgerEntryId: reversal.id,
    });

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Ledger Service authority dry-run QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
