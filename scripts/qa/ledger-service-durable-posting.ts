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
    fail("DATABASE_URL is required for Ledger Service durable posting QA.");
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

async function seedWallet(pool: Pool) {
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
    [accountId, `qa-ledger-service-${suffix}`, `QA Ledger Service ${suffix}`]
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

async function verifyHealth() {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/health`);
  const body = await readJson(response);

  assert(response.ok, "Ledger Service health should be ready.", {
    status: response.status,
    body,
  });
  assert(body?.dependencies?.database === "ready", "Ledger Service database dependency should be ready.", {
    body,
  });
  assert(body?.capabilities?.mutationCapabilityEnabled === true, "Mutation capability marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.durablePersistenceConfigured === true, "Durable persistence marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.idempotencySupportConfigured === true, "Idempotency marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.serviceAuthorityEnabled === false, "Ledger Service must not self-report authority enabled.", {
    body,
  });
  pass("Ledger Service readiness and capability markers are explicit");
}

async function postLedgerEntry(walletId: string, idempotencyKey: string, amount = 25) {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-ledger-service-${idempotencyKey}`,
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
        type: "qa_ledger_service",
        id: idempotencyKey,
      },
      metadata: {
        qa: "ledger-service-durable-posting",
      },
    }),
  });
  const body = await readJson(response);

  return { response, body };
}

async function verifyPosting(wallet: WalletRow) {
  const idempotencyKey = `qa-ledger-service-${randomUUID()}`;
  const first = await postLedgerEntry(wallet.id, idempotencyKey);

  assert(first.response.ok, "Ledger Service posting should succeed.", {
    status: first.response.status,
    body: first.body,
  });
  const ledgerEntry = first.body?.ledgerEntry;
  assert(ledgerEntry?.id, "Ledger Service posting should return a ledger entry.", {
    body: first.body,
  });
  assert(ledgerEntry?.walletId === wallet.id, "Posted entry should preserve wallet id.", {
    ledgerEntry,
    wallet,
  });
  assert(ledgerEntry?.accountId === wallet.account_id, "Posted entry should resolve account id.", {
    ledgerEntry,
    wallet,
  });
  assert(ledgerEntry?.idempotencyKey === idempotencyKey, "Posted entry should preserve idempotency key.", {
    ledgerEntry,
  });
  pass("post ledger entry succeeds", { ledgerEntryId: ledgerEntry.id });

  const duplicate = await postLedgerEntry(wallet.id, idempotencyKey);
  assert(duplicate.response.ok, "Duplicate idempotency key should return success.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  assert(
    duplicate.body?.ledgerEntry?.id === ledgerEntry.id,
    "Duplicate idempotency key should return existing ledger entry.",
    {
      first: ledgerEntry,
      duplicate: duplicate.body?.ledgerEntry,
    }
  );
  pass("duplicate idempotency key is idempotent", { ledgerEntryId: ledgerEntry.id });

  return ledgerEntry;
}

async function verifyGetById(ledgerEntryId: string) {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries/${ledgerEntryId}`);
  const body = await readJson(response);

  assert(response.ok, "Get by id should succeed.", { status: response.status, body });
  assert(body?.ledgerEntry?.id === ledgerEntryId, "Get by id should return requested entry.", { body });
  pass("get by id works", { ledgerEntryId });
}

async function verifyAccountQuery(accountId: string, ledgerEntryId: string) {
  const response = await fetch(
    `${ledgerServiceUrl}/v1/ledger/accounts/${accountId}/entries?limit=10&sort=createdAt.desc`
  );
  const body = await readJson(response);

  assert(response.ok, "Account ledger query should succeed.", { status: response.status, body });
  assert(
    Array.isArray(body?.entries) && body.entries.some((entry: { id?: string }) => entry.id === ledgerEntryId),
    "Account ledger query should include posted entry.",
    { body, ledgerEntryId }
  );
  assert(body?.pagination?.limit === 10, "Account ledger query should return pagination metadata.", { body });
  pass("query by account works", { accountId, ledgerEntryId });
}

async function verifyInvalidRequest(walletId: string) {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `qa-ledger-invalid-${randomUUID()}`,
    },
    body: JSON.stringify({
      walletId,
      transactionType: "DEPOSIT",
      direction: "CREDIT",
      money: {
        amount: 0,
        currency: "USD",
      },
    }),
  });
  const body = await readJson(response);

  assert(response.status === 400, "Invalid ledger request should fail closed with 400.", {
    status: response.status,
    body,
  });
  pass("invalid request fails closed");
}

function verifyAuthorityRemainsMonolith() {
  const authority = readAuthorityConfigurations().ledger;

  assert(authority.authority === "MONOLITH", "Ledger authority must remain MONOLITH.", {
    authority,
  });
  assert(process.env.LEDGER_AUTHORITY !== "SERVICE", "LEDGER_AUTHORITY must not be SERVICE.", {
    ledgerAuthorityEnv: process.env.LEDGER_AUTHORITY ?? null,
  });
  pass("authority guardrails keep MONOLITH active", { authority: authority.authority });
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await verifyHealth();
    const wallet = await seedWallet(pool);
    const ledgerEntry = await verifyPosting(wallet);
    await verifyGetById(ledgerEntry.id);
    await verifyAccountQuery(wallet.account_id, ledgerEntry.id);
    await verifyInvalidRequest(wallet.id);
    verifyAuthorityRemainsMonolith();

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Ledger Service durable posting QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
