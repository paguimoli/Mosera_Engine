import { createHash, randomUUID } from "node:crypto";
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

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  ).replaceAll("+", "\\u002B");
}

function toDotNetUtcRoundtrip(value: string) {
  return `${new Date(value).toISOString().replace("Z", "0000+00:00")}`;
}

function computeCanonicalLedgerRequestHash(input: {
  amountMinor: number;
  currency: string;
  direction: string;
  effectiveAt: string;
  idempotencyKey: string;
  instructionHash: string;
  instructionId: string;
  instructionType: string;
  ledgerAccountId?: string | null;
  ledgerWalletId: string;
  minorUnitPrecision: number;
  originatingAuthority: string;
  referenceId?: string | null;
  referenceType?: string | null;
  reversalOfLedgerEntryId?: string | null;
  settlementRecordId?: string | null;
  transactionType: string;
}) {
  return sha256(
    canonicalJson({
      amountMinor: input.amountMinor,
      currency: input.currency.trim(),
      direction: input.direction,
      effectiveAt: toDotNetUtcRoundtrip(input.effectiveAt),
      idempotencyKey: input.idempotencyKey.trim(),
      instructionHash: input.instructionHash.trim(),
      instructionId: input.instructionId.trim(),
      instructionType: input.instructionType.trim(),
      ledgerAccountId: input.ledgerAccountId?.trim() || null,
      ledgerWalletId: input.ledgerWalletId.trim(),
      minorUnitPrecision: input.minorUnitPrecision,
      originatingAuthority: input.originatingAuthority.trim(),
      referenceId: input.referenceId?.trim() || null,
      referenceType: input.referenceType?.trim() || null,
      reversalOfLedgerEntryId: input.reversalOfLedgerEntryId?.trim() || null,
      settlementRecordId: input.settlementRecordId?.trim() || null,
      transactionType: input.transactionType,
    })
  );
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
  assert(body?.capabilities?.canonicalPostingContractReady === true, "Canonical posting marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.canonicalHashValidationReady === true, "Canonical hash marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.conflictSafeIdempotencyReady === true, "Conflict-safe idempotency marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.currencyAccountValidationReady === true, "Currency/account validation marker should be enabled.", {
    body,
  });
  assert(body?.capabilities?.serviceAuthorityEnabled === false, "Ledger Service must not self-report authority enabled.", {
    body,
  });
  pass("Ledger Service readiness and capability markers are explicit");
}

async function postLedgerEntry(wallet: WalletRow, idempotencyKey: string, amount = 25) {
  const effectiveAt = "2026-01-01T00:00:00.000Z";
  const instructionId = idempotencyKey;
  const instructionType = "DEPOSIT";
  const instructionHash = sha256(canonicalJson({ amount, idempotencyKey, instructionId, instructionType }));
  const canonicalRequestHash = computeCanonicalLedgerRequestHash({
    amountMinor: amount,
    currency: "USD",
    direction: "CREDIT",
    effectiveAt,
    idempotencyKey,
    instructionHash,
    instructionId,
    instructionType,
    ledgerAccountId: wallet.account_id,
    ledgerWalletId: wallet.id,
    minorUnitPrecision: 2,
    originatingAuthority: "ledger-service-qa",
    referenceId: idempotencyKey,
    referenceType: "qa_ledger_service",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: "DEPOSIT",
  });
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-ledger-service-${idempotencyKey}`,
    },
    body: JSON.stringify({
      walletId: wallet.id,
      ledgerAccountId: wallet.account_id,
      instructionId,
      instructionType,
      instructionHash,
      originatingAuthority: "ledger-service-qa",
      settlementRecordId: null,
      transactionType: "DEPOSIT",
      direction: "CREDIT",
      money: {
        amount,
        currency: "USD",
      },
      minorUnitPrecision: 2,
      canonicalRequestHash,
      effectiveAt,
      reference: {
        type: "qa_ledger_service",
        id: idempotencyKey,
      },
      reversalOfLedgerEntryId: null,
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
  const first = await postLedgerEntry(wallet, idempotencyKey);

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
  assert(
    ledgerEntry?.canonicalRequestHash?.startsWith("sha256:"),
    "Posted entry should preserve canonical request hash.",
    { ledgerEntry }
  );
  pass("post ledger entry succeeds", { ledgerEntryId: ledgerEntry.id });

  const duplicate = await postLedgerEntry(wallet, idempotencyKey);
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
