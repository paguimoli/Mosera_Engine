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
};

type LedgerEntry = {
  id: string;
  walletId: string;
  accountId: string;
  direction: "CREDIT" | "DEBIT";
  money: { amount: number; currency: string };
  balanceAfter: { amount: number; currency: string };
  canonicalRequestHash: string;
  reversalOfLedgerEntryId?: string | null;
  originalLedgerEntryHash?: string | null;
  reversalReasonCode?: string | null;
  reversalPolicyVersion?: string | null;
  canonicalReversalHash?: string | null;
};

const checks: Check[] = [];
const ledgerServiceUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");

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

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) fail("DATABASE_URL is required for Ledger reversal QA.");
  return value;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  ).replaceAll("+", "\\u002B");
}

function dotnetTimestamp(value: string) {
  return new Date(value).toISOString().replace("Z", "0000+00:00");
}

function postingHash(input: {
  amountMinor: number;
  effectiveAt: string;
  idempotencyKey: string;
  instructionHash: string;
  instructionId: string;
  ledgerAccountId: string;
  ledgerWalletId: string;
}) {
  return sha256(canonicalJson({
    amountMinor: input.amountMinor,
    currency: "USD",
    direction: "CREDIT",
    effectiveAt: dotnetTimestamp(input.effectiveAt),
    idempotencyKey: input.idempotencyKey,
    instructionHash: input.instructionHash,
    instructionId: input.instructionId,
    instructionType: "DEPOSIT",
    ledgerAccountId: input.ledgerAccountId,
    ledgerWalletId: input.ledgerWalletId,
    minorUnitPrecision: 2,
    originatingAuthority: "ledger-reversal-qa",
    referenceId: input.idempotencyKey,
    referenceType: "qa_ledger_reversal",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: "DEPOSIT",
  }));
}

function reversalHash(input: {
  amountMinor: number;
  canonicalOriginalHash: string;
  direction: "CREDIT" | "DEBIT";
  effectiveAt: string;
  idempotencyKey: string;
  instructionHash: string;
  instructionId: string;
  ledgerAccountId: string;
  ledgerWalletId: string;
  originalLedgerEntryId: string;
  reasonCode: string;
}) {
  return sha256(canonicalJson({
    amountMinor: input.amountMinor,
    currency: "USD",
    direction: input.direction,
    effectiveAt: dotnetTimestamp(input.effectiveAt),
    idempotencyKey: input.idempotencyKey,
    instructionHash: input.instructionHash,
    instructionId: input.instructionId,
    instructionType: "LEDGER_REVERSAL",
    ledgerAccountId: input.ledgerAccountId,
    ledgerWalletId: input.ledgerWalletId,
    minorUnitPrecision: 2,
    originalLedgerEntryHash: input.canonicalOriginalHash,
    originalLedgerEntryId: input.originalLedgerEntryId,
    originatingAuthority: "ledger-reversal-qa",
    reasonCode: input.reasonCode,
    referenceId: input.originalLedgerEntryId,
    referenceType: "ledger_entry",
    reversalOfLedgerEntryId: input.originalLedgerEntryId,
    reversalPolicyVersion: "ledger-reversal-v1",
    settlementRecordId: null,
    transactionType: "REVERSAL",
  }));
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
    `insert into public.accounts (id, account_type, account_code, display_name, status)
     values ($1, 'PLAYER', $2, $3, 'ACTIVE')`,
    [accountId, `qa-ledger-reversal-${suffix}`, `QA Ledger Reversal ${suffix}`]
  );
  const result = await pool.query<WalletRow>(
    `insert into public.financial_wallets
       (account_id, wallet_type, currency_code, balance_authority, status, balance, funding_model)
     values ($1, 'CASH', 'USD', 'INTERNAL', 'ACTIVE', 0, 'CASH')
     returning id::text, account_id::text`,
    [accountId]
  );
  return result.rows[0];
}

async function createOriginal(wallet: WalletRow) {
  const idempotencyKey = `qa-ledger-original-${randomUUID()}`;
  const effectiveAt = "2026-01-04T00:00:00.000Z";
  const instructionHash = sha256(canonicalJson({ idempotencyKey, type: "DEPOSIT" }));
  const canonicalRequestHash = postingHash({
    amountMinor: 100,
    effectiveAt,
    idempotencyKey,
    instructionHash,
    instructionId: idempotencyKey,
    ledgerAccountId: wallet.account_id,
    ledgerWalletId: wallet.id,
  });
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      walletId: wallet.id,
      ledgerAccountId: wallet.account_id,
      instructionId: idempotencyKey,
      instructionType: "DEPOSIT",
      instructionHash,
      originatingAuthority: "ledger-reversal-qa",
      settlementRecordId: null,
      transactionType: "DEPOSIT",
      direction: "CREDIT",
      money: { amount: 100, currency: "USD" },
      minorUnitPrecision: 2,
      canonicalRequestHash,
      effectiveAt,
      reference: { type: "qa_ledger_reversal", id: idempotencyKey },
      reversalOfLedgerEntryId: null,
      metadata: { qa: "ledger-reversal" },
    }),
  });
  const body = await readJson(response);
  assert(response.ok, "Original immutable Ledger entry should post.", { status: response.status, body });
  return body.ledgerEntry as LedgerEntry;
}

function buildReversal(original: LedgerEntry, idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  const effectiveAt = "2026-01-04T00:05:00.000Z";
  const reasonCode = String(overrides.reasonCode ?? "CORRECTION");
  const instructionId = String(overrides.instructionId ?? `correction:${original.id}`);
  const instructionHash = sha256(canonicalJson({
    instructionId,
    originalLedgerEntryHash: original.canonicalRequestHash,
    originalLedgerEntryId: original.id,
    reasonCode,
  }));
  const base = {
    originalLedgerEntryId: original.id,
    originalLedgerEntryHash: original.canonicalRequestHash,
    walletId: original.walletId,
    ledgerAccountId: original.accountId,
    direction: "DEBIT" as const,
    money: { amount: original.money.amount, currency: original.money.currency },
    instructionId,
    instructionType: "LEDGER_REVERSAL",
    instructionHash,
    originatingAuthority: "ledger-reversal-qa",
    reasonCode,
    reversalPolicyVersion: "ledger-reversal-v1",
    effectiveAt,
    minorUnitPrecision: 2,
    actorUserId: null,
    metadata: { qa: "ledger-reversal", provenance: "P1-008.2" },
    ...overrides,
  };
  const canonicalReversalHash = reversalHash({
    amountMinor: base.money.amount,
    canonicalOriginalHash: base.originalLedgerEntryHash,
    direction: base.direction,
    effectiveAt: base.effectiveAt,
    idempotencyKey,
    instructionHash: base.instructionHash,
    instructionId: base.instructionId,
    ledgerAccountId: base.ledgerAccountId,
    ledgerWalletId: base.walletId,
    originalLedgerEntryId: base.originalLedgerEntryId,
    reasonCode: base.reasonCode,
  });
  return { ...base, canonicalReversalHash };
}

async function reverse(original: LedgerEntry, idempotencyKey: string, body: Record<string, unknown>) {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries/${original.id}/reverse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await readJson(response) };
}

async function verifyImmutability(pool: Pool, original: LedgerEntry) {
  for (const [name, sql] of [
    ["update", "update public.financial_ledger_entries set metadata = '{}'::jsonb where id = $1"],
    ["delete", "delete from public.financial_ledger_entries where id = $1"],
  ] as const) {
    let blocked = false;
    try {
      await pool.query(sql, [original.id]);
    } catch (error) {
      blocked = error instanceof Error && error.message.includes("immutable");
    }
    assert(blocked, `Direct Ledger ${name} must be blocked.`);
    pass(`direct ledger ${name} blocked`);
  }
}

async function verifyReversal(pool: Pool, original: LedgerEntry) {
  const idempotencyKey = `qa-ledger-reversal-${randomUUID()}`;
  const request = buildReversal(original, idempotencyKey);
  const first = await reverse(original, idempotencyKey, request);
  assert(first.response.ok, "Valid reversal should succeed.", { status: first.response.status, body: first.body });
  const entry = first.body.ledgerEntry as LedgerEntry;
  assert(entry.reversalOfLedgerEntryId === original.id, "Reversal must reference the original entry.", { entry });
  assert(entry.originalLedgerEntryHash === original.canonicalRequestHash, "Original hash must persist.", { entry });
  assert(entry.reversalReasonCode === "CORRECTION", "Reason code must persist.", { entry });
  assert(entry.reversalPolicyVersion === "ledger-reversal-v1", "Policy version must persist.", { entry });
  assert(entry.canonicalReversalHash === request.canonicalReversalHash, "Canonical reversal hash must persist.", { entry });
  assert(entry.direction === "DEBIT" && entry.money.amount === original.money.amount, "Reversal must oppose original.", {
    original,
    entry,
  });
  assert(entry.balanceAfter.amount === 0, "Opposing entry should restore the wallet balance.", { entry });
  pass("immutable opposing reversal persists", { reversalId: entry.id });

  const duplicate = await reverse(original, idempotencyKey, request);
  assert(duplicate.response.ok && duplicate.body.ledgerEntry.id === entry.id, "Identical duplicate must return existing.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  pass("identical duplicate reversal is idempotent");

  const conflictingRequest = buildReversal(original, idempotencyKey, { reasonCode: "VOID" });
  const conflict = await reverse(original, idempotencyKey, conflictingRequest);
  assert(conflict.response.status === 409, "Conflicting duplicate idempotency key must fail closed.", {
    status: conflict.response.status,
    body: conflict.body,
  });
  pass("conflicting reversal idempotency fails closed");

  const secondKey = `qa-ledger-reversal-${randomUUID()}`;
  const second = await reverse(original, secondKey, buildReversal(original, secondKey));
  assert(second.response.status === 409, "Second independent reversal must be rejected.", {
    status: second.response.status,
    body: second.body,
  });
  pass("second independent reversal rejected");

  const count = await pool.query<{ count: string }>(
    "select count(*)::text from public.financial_ledger_entries where reversal_of_ledger_entry_id = $1",
    [original.id]
  );
  assert(count.rows[0].count === "1", "Exactly one reversal row should exist.", { count: count.rows[0].count });
  pass("one reversal per original enforced");
}

async function verifyInvalidReversals(wallet: WalletRow, original: LedgerEntry) {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["nonexistent original", { originalLedgerEntryId: randomUUID() }],
    ["wrong original hash", { originalLedgerEntryHash: `sha256:${"0".repeat(64)}` }],
    ["wrong wallet", { walletId: randomUUID() }],
    ["wrong account", { ledgerAccountId: randomUUID() }],
    ["wrong amount", { money: { amount: 99, currency: "USD" } }],
    ["wrong currency", { money: { amount: 100, currency: "CRC" } }],
    ["wrong direction", { direction: "CREDIT" }],
    ["unsupported reason", { reasonCode: "UNSUPPORTED" }],
  ];

  for (const [name, overrides] of cases) {
    const idempotencyKey = `qa-ledger-invalid-${randomUUID()}`;
    const body = buildReversal(original, idempotencyKey, overrides);
    const response = await reverse(original, idempotencyKey, body);
    assert(response.response.status >= 400 && response.response.status < 500, `${name} must fail closed.`, {
      status: response.response.status,
      body: response.body,
    });
    pass(`${name} rejected`);
  }

  const arbitraryKey = `qa-ledger-arbitrary-${randomUUID()}`;
  const effectiveAt = "2026-01-04T00:15:00.000Z";
  const instructionHash = sha256(arbitraryKey);
  const canonicalRequestHash = sha256(canonicalJson({
    amountMinor: 10,
    currency: "USD",
    direction: "DEBIT",
    effectiveAt: dotnetTimestamp(effectiveAt),
    idempotencyKey: arbitraryKey,
    instructionHash,
    instructionId: arbitraryKey,
    instructionType: "REVERSAL",
    ledgerAccountId: wallet.account_id,
    ledgerWalletId: wallet.id,
    minorUnitPrecision: 2,
    originatingAuthority: "ledger-reversal-qa",
    referenceId: null,
    referenceType: null,
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: "REVERSAL",
  }));
  const arbitrary = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": arbitraryKey },
    body: JSON.stringify({
      walletId: wallet.id,
      ledgerAccountId: wallet.account_id,
      instructionId: arbitraryKey,
      instructionType: "REVERSAL",
      instructionHash,
      originatingAuthority: "ledger-reversal-qa",
      settlementRecordId: null,
      transactionType: "REVERSAL",
      direction: "DEBIT",
      money: { amount: 10, currency: "USD" },
      minorUnitPrecision: 2,
      canonicalRequestHash,
      effectiveAt,
      reference: null,
      reversalOfLedgerEntryId: null,
      metadata: { qa: "ledger-reversal" },
    }),
  });
  assert(arbitrary.status === 400, "Arbitrary reversal posting must be rejected.", {
    status: arbitrary.status,
    body: await readJson(arbitrary),
  });
  pass("arbitrary reversal posting rejected");
}

async function verifyReadiness() {
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/health`);
  const body = await readJson(response);
  assert(response.ok, "Ledger readiness endpoint should pass.", { status: response.status, body });
  for (const marker of [
    "immutableEntryStorageReady",
    "reversalOnlyCorrectionReady",
    "originalEntryValidationReady",
    "reversalConflictProtectionReady",
    "settlementReversalInstructionCompatible",
  ]) {
    assert(body?.capabilities?.[marker] === true, `${marker} should be ready.`, { body });
  }
  pass("immutability and reversal readiness markers present");
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl(), connectionTimeoutMillis: 1_000, max: 4 });
  try {
    const wallet = await seedWallet(pool);
    const original = await createOriginal(wallet);
    await verifyImmutability(pool, original);
    await verifyInvalidReversals(wallet, original);
    await verifyReversal(pool, original);
    await verifyReadiness();
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Ledger reversal QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
