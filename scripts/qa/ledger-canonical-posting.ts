import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type WalletRow = QueryResultRow & {
  id: string;
  account_id: string;
  currency_code: string;
};

type PostOptions = {
  amount?: number;
  currency?: string;
  direction?: string;
  transactionType?: string;
  minorUnitPrecision?: number;
  walletId?: string;
  ledgerAccountId?: string | null;
  idempotencyKey?: string;
  effectiveAt?: string;
  canonicalRequestHashOverride?: string;
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
    fail("DATABASE_URL is required for Ledger canonical posting QA.");
  }

  return databaseUrl;
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

async function readJson(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function seedWallet(pool: Pool, options: { currency?: string; walletStatus?: string; accountStatus?: string } = {}) {
  const accountId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const currency = options.currency ?? "USD";

  await pool.query(
    `
insert into public.accounts (
  id,
  account_type,
  account_code,
  display_name,
  status
)
values ($1, 'PLAYER', $2, $3, $4)
`,
    [accountId, `qa-ledger-canonical-${suffix}`, `QA Ledger Canonical ${suffix}`, options.accountStatus ?? "ACTIVE"]
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
values ($1, 'CASH', $2, 'INTERNAL', $3, 0, 'CASH')
returning id::text, account_id::text, currency_code
`,
    [accountId, currency, options.walletStatus ?? "ACTIVE"]
  );

  return wallet.rows[0];
}

function buildPostBody(wallet: WalletRow, options: PostOptions = {}) {
  const amount = options.amount ?? 33;
  const currency = options.currency ?? wallet.currency_code;
  const direction = options.direction ?? "CREDIT";
  const transactionType = options.transactionType ?? "DEPOSIT";
  const minorUnitPrecision = options.minorUnitPrecision ?? 2;
  const walletId = options.walletId ?? wallet.id;
  const ledgerAccountId = options.ledgerAccountId === undefined ? wallet.account_id : options.ledgerAccountId;
  const idempotencyKey = options.idempotencyKey ?? `qa-ledger-canonical-${randomUUID()}`;
  const effectiveAt = options.effectiveAt ?? "2026-01-03T00:00:00.000Z";
  const instructionId = idempotencyKey;
  const instructionType = transactionType;
  const instructionHash = sha256(canonicalJson({ amount, idempotencyKey, instructionId, instructionType }));
  const canonicalRequestHash = computeCanonicalLedgerRequestHash({
    amountMinor: amount,
    currency,
    direction,
    effectiveAt,
    idempotencyKey,
    instructionHash,
    instructionId,
    instructionType,
    ledgerAccountId,
    ledgerWalletId: walletId,
    minorUnitPrecision,
    originatingAuthority: "ledger-service-qa",
    referenceId: idempotencyKey,
    referenceType: "qa_ledger_canonical",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType,
  });

  return {
    idempotencyKey,
    body: {
      walletId,
      ledgerAccountId,
      instructionId,
      instructionType,
      instructionHash,
      originatingAuthority: "ledger-service-qa",
      settlementRecordId: null,
      transactionType,
      direction,
      money: {
        amount,
        currency,
      },
      minorUnitPrecision,
      canonicalRequestHash: options.canonicalRequestHashOverride ?? canonicalRequestHash,
      effectiveAt,
      reference: {
        type: "qa_ledger_canonical",
        id: idempotencyKey,
      },
      reversalOfLedgerEntryId: null,
      metadata: {
        qa: "ledger-canonical-posting",
      },
    },
    canonicalRequestHash,
  };
}

async function postLedgerEntry(wallet: WalletRow, options: PostOptions = {}) {
  const { body, idempotencyKey, canonicalRequestHash } = buildPostBody(wallet, options);
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-ledger-canonical-${idempotencyKey}`,
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    body: await readJson(response),
    idempotencyKey,
    canonicalRequestHash,
  };
}

async function verifyCanonicalPosting(wallet: WalletRow) {
  const first = await postLedgerEntry(wallet);
  assert(first.response.ok, "Canonical Ledger posting should succeed.", {
    status: first.response.status,
    body: first.body,
  });
  assert(
    first.body?.ledgerEntry?.canonicalRequestHash === first.canonicalRequestHash,
    "Canonical request hash should be persisted and returned.",
    { body: first.body, canonicalRequestHash: first.canonicalRequestHash }
  );
  pass("canonical posting succeeds", { ledgerEntryId: first.body.ledgerEntry.id });

  const duplicate = await postLedgerEntry(wallet, { idempotencyKey: first.idempotencyKey });
  assert(duplicate.response.ok, "Duplicate canonical Ledger posting should return existing entry.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  assert(duplicate.body?.ledgerEntry?.id === first.body?.ledgerEntry?.id, "Duplicate should return existing entry.", {
    first: first.body,
    duplicate: duplicate.body,
  });
  pass("duplicate same canonical request is idempotent", { ledgerEntryId: first.body.ledgerEntry.id });

  const conflict = await postLedgerEntry(wallet, {
    idempotencyKey: first.idempotencyKey,
    amount: 34,
  });
  assert(conflict.response.status === 409, "Conflicting canonical request must fail with 409.", {
    status: conflict.response.status,
    body: conflict.body,
  });
  pass("duplicate conflicting payload fails closed");

  return first.body.ledgerEntry;
}

async function verifyCurrencyAndAccountValidation(pool: Pool, wallet: WalletRow) {
  const currencyMismatch = await postLedgerEntry(wallet, { currency: "CRC" });
  assert(currencyMismatch.response.status === 400, "Currency mismatch should fail closed.", {
    status: currencyMismatch.response.status,
    body: currencyMismatch.body,
  });
  pass("currency mismatch rejected");

  const invalidPrecision = await postLedgerEntry(wallet, { minorUnitPrecision: 0 });
  assert(invalidPrecision.response.status === 400, "Invalid minor unit precision should fail closed.", {
    status: invalidPrecision.response.status,
    body: invalidPrecision.body,
  });
  pass("minor unit precision mismatch rejected");

  const missingWallet = await postLedgerEntry(wallet, {
    walletId: randomUUID(),
    ledgerAccountId: null,
  });
  assert(missingWallet.response.status === 400, "Missing wallet should fail closed.", {
    status: missingWallet.response.status,
    body: missingWallet.body,
  });
  pass("missing wallet rejected");

  const suspendedWallet = await seedWallet(pool, { walletStatus: "SUSPENDED" });
  const inactiveWallet = await postLedgerEntry(suspendedWallet);
  assert(inactiveWallet.response.status === 400, "Inactive wallet should fail closed.", {
    status: inactiveWallet.response.status,
    body: inactiveWallet.body,
  });
  pass("inactive wallet rejected");

  const mismatchedAccount = await postLedgerEntry(wallet, { ledgerAccountId: randomUUID() });
  assert(mismatchedAccount.response.status === 400, "Ledger account mismatch should fail closed.", {
    status: mismatchedAccount.response.status,
    body: mismatchedAccount.body,
  });
  pass("ledger account mismatch rejected");
}

async function verifyContractValidation(wallet: WalletRow, ledgerEntry: { id: string }) {
  const invalidDirection = await postLedgerEntry(wallet, {
    transactionType: "DEPOSIT",
    direction: "DEBIT",
  });
  assert(invalidDirection.response.status === 400, "Invalid transaction type/direction should fail closed.", {
    status: invalidDirection.response.status,
    body: invalidDirection.body,
  });
  pass("transaction type and direction mismatch rejected");

  const reverseResponse = await fetch(`${ledgerServiceUrl}/v1/ledger/entries/${ledgerEntry.id}/reverse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": `qa-ledger-canonical-reversal-${ledgerEntry.id}`,
    },
    body: JSON.stringify({
      reason: "qa-canonical-mismatch",
      instructionId: `reversal-${ledgerEntry.id}`,
      instructionType: "REVERSAL",
      instructionHash: sha256(ledgerEntry.id),
      originatingAuthority: "ledger-service-qa",
      canonicalRequestHash: `sha256:${"0".repeat(64)}`,
      effectiveAt: "2026-01-03T00:10:00.000Z",
      minorUnitPrecision: 2,
      actorUserId: null,
      metadata: {
        qa: "ledger-canonical-posting",
      },
    }),
  });
  const reverseBody = await readJson(reverseResponse);
  assert(reverseResponse.status === 400, "Reversal canonical mismatch should fail closed.", {
    status: reverseResponse.status,
    body: reverseBody,
  });
  pass("reversal canonical reference mismatch rejected");
}

async function verifyNoCompetingPublicJournalTable(pool: Pool) {
  const result = await pool.query<{ table_name: string }>(
    `
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('ledger_journals', 'financial_ledger_journals', 'ledger_journal_entries')
`
  );
  assert(result.rowCount === 0, "The canonical posting path must not introduce competing public journal tables.", {
    tables: result.rows,
  });
  pass("canonical posting uses the ledger_service journal without competing public tables");
}

async function main() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    const wallet = await seedWallet(pool);
    const ledgerEntry = await verifyCanonicalPosting(wallet);
    await verifyCurrencyAndAccountValidation(pool, wallet);
    await verifyContractValidation(wallet, ledgerEntry);
    await verifyNoCompetingPublicJournalTable(pool);

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Ledger canonical posting QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
