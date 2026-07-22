import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type WalletRow = QueryResultRow & {
  id: string;
  account_id: string;
};

type LedgerEntry = {
  id: string;
  walletId: string;
  accountId: string;
  canonicalRequestHash: string;
  money: { amount: number; currency: string };
};

type DirectLedgerEntry = LedgerEntry & {
  idempotencyKey: string;
  instructionId: string;
  instructionHash: string;
};

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };

const checks: Check[] = [];
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");

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
  if (!value) fail("DATABASE_URL is required.");
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
  amount: number;
  currency: string;
  direction: string;
  effectiveAt: string;
  idempotencyKey: string;
  instructionHash: string;
  instructionId: string;
  instructionType: string;
  accountId: string | null;
  walletId: string;
  transactionType: string;
}) {
  return sha256(canonicalJson({
    amountMinor: input.amount,
    currency: input.currency,
    direction: input.direction,
    effectiveAt: dotnetTimestamp(input.effectiveAt),
    idempotencyKey: input.idempotencyKey,
    instructionHash: input.instructionHash,
    instructionId: input.instructionId,
    instructionType: input.instructionType,
    ledgerAccountId: input.accountId,
    ledgerWalletId: input.walletId,
    minorUnitPrecision: 2,
    originatingAuthority: "ledger-posting-evidence-qa",
    referenceId: input.idempotencyKey,
    referenceType: "qa_ledger_posting_evidence",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: input.transactionType,
  }));
}

function reversalHash(input: {
  amount: number;
  effectiveAt: string;
  idempotencyKey: string;
  instructionHash: string;
  instructionId: string;
  original: LedgerEntry;
}) {
  return sha256(canonicalJson({
    amountMinor: input.amount,
    currency: input.original.money.currency,
    direction: "DEBIT",
    effectiveAt: dotnetTimestamp(input.effectiveAt),
    idempotencyKey: input.idempotencyKey,
    instructionHash: input.instructionHash,
    instructionId: input.instructionId,
    instructionType: "LEDGER_REVERSAL",
    ledgerAccountId: input.original.accountId,
    ledgerWalletId: input.original.walletId,
    minorUnitPrecision: 2,
    originalLedgerEntryHash: input.original.canonicalRequestHash,
    originalLedgerEntryId: input.original.id,
    originatingAuthority: "ledger-posting-evidence-qa",
    reasonCode: "CORRECTION",
    referenceId: input.original.id,
    referenceType: "ledger_entry",
    reversalOfLedgerEntryId: input.original.id,
    reversalPolicyVersion: "ledger-reversal-v1",
    settlementRecordId: null,
    transactionType: "REVERSAL",
  }));
}

async function json(response: Response) {
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
    [accountId, `qa-ledger-evidence-${suffix}`, `QA Ledger Evidence ${suffix}`]
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

function buildPosting(wallet: WalletRow, idempotencyKey: string, amount = 125) {
  const effectiveAt = "2026-01-05T00:00:00.000Z";
  const instructionId = `instruction:${idempotencyKey}`;
  const instructionHash = sha256(canonicalJson({ amount, instructionId }));
  const canonicalRequestHash = postingHash({
    amount,
    currency: "USD",
    direction: "CREDIT",
    effectiveAt,
    idempotencyKey,
    instructionHash,
    instructionId,
    instructionType: "DEPOSIT",
    accountId: wallet.account_id,
    walletId: wallet.id,
    transactionType: "DEPOSIT",
  });
  return {
    walletId: wallet.id,
    ledgerAccountId: wallet.account_id,
    instructionId,
    instructionType: "DEPOSIT",
    instructionHash,
    originatingAuthority: "ledger-posting-evidence-qa",
    settlementRecordId: null,
    transactionType: "DEPOSIT",
    direction: "CREDIT",
    money: { amount, currency: "USD" },
    minorUnitPrecision: 2,
    canonicalRequestHash,
    effectiveAt,
    reference: { type: "qa_ledger_posting_evidence", id: idempotencyKey },
    reversalOfLedgerEntryId: null,
    metadata: { qa: "ledger-posting-evidence" },
  };
}

async function post(body: Record<string, unknown>, key: string) {
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  return { response, body: await json(response) };
}

async function verifyPostingLifecycle(pool: Pool, wallet: WalletRow) {
  const key = `qa-ledger-evidence-${randomUUID()}`;
  const requestBody = buildPosting(wallet, key);
  const first = await post(requestBody, key);
  assert(first.response.ok, "First durable posting must succeed.", { status: first.response.status, body: first.body });
  const requestId = first.body.postingRequestId as string;
  const entry = first.body.ledgerEntry as LedgerEntry;
  assert(Boolean(requestId), "Posting response must expose postingRequestId.", { body: first.body });

  const requestResponse = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}`);
  const request = await json(requestResponse);
  assert(requestResponse.ok && request.postingRequest.status === "COMPLETED", "Durable request must complete.", { request });
  assert(request.postingRequest.ledgerEntryId === entry.id, "Request must reference immutable entry.", { request, entry });

  const firstAttemptsResponse = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/attempts`);
  const firstAttempts = await json(firstAttemptsResponse);
  assert(firstAttempts.attempts.length === 1 && firstAttempts.attempts[0].result === "SUCCEEDED",
    "First posting must persist SUCCEEDED attempt.", { firstAttempts });
  pass("first durable posting request and attempt persist", { requestId, ledgerEntryId: entry.id });

  const duplicate = await post(requestBody, key);
  assert(duplicate.response.ok, "Duplicate identical posting must succeed.", { duplicate: duplicate.body });
  assert(duplicate.body.ledgerEntry.id === entry.id && duplicate.body.postingRequestId === requestId,
    "Duplicate identical posting must reuse request and entry.", { duplicate: duplicate.body });
  const duplicateAttempts = await json(await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/attempts`));
  assert(duplicateAttempts.attempts.length === 2 &&
    duplicateAttempts.attempts[1].result === "REUSED",
  "Duplicate retry must append REUSED attempt.", { duplicateAttempts });

  const count = await pool.query<{ count: string }>(
    "select count(*)::text as count from public.financial_ledger_entries where idempotency_key = $1",
    [key]
  );
  assert(count.rows[0].count === "1", "Retry must not create a second financial effect.", { count: count.rows[0].count });
  pass("duplicate request reuses one financial effect");

  const conflictBody = buildPosting(wallet, key, 126);
  const conflict = await post(conflictBody, key);
  assert(conflict.response.status === 409, "Conflicting duplicate must fail closed.", {
    status: conflict.response.status,
    body: conflict.body,
  });
  const conflictAttempts = await json(await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/attempts`));
  assert(conflictAttempts.attempts.some((attempt: { result: string }) => attempt.result === "CONFLICT"),
    "Conflict attempt evidence must persist.", { conflictAttempts });
  pass("conflicting duplicate records conflict evidence");

  const replay = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/replay`, { method: "POST" });
  const replayBody = await json(replay);
  assert(replay.ok && replayBody.evidence.result === "MATCH", "Standard posting replay must MATCH.", { replayBody });
  pass("standard posting replay matches");

  return { requestId, entry };
}

async function verifyReversalReplay(original: LedgerEntry) {
  const key = `qa-ledger-reversal-evidence-${randomUUID()}`;
  const effectiveAt = "2026-01-05T00:05:00.000Z";
  const instructionId = `reversal:${original.id}`;
  const instructionHash = sha256(canonicalJson({ instructionId, original: original.id }));
  const canonicalReversalHash = reversalHash({
    amount: original.money.amount,
    effectiveAt,
    idempotencyKey: key,
    instructionHash,
    instructionId,
    original,
  });
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries/${original.id}/reverse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      originalLedgerEntryId: original.id,
      originalLedgerEntryHash: original.canonicalRequestHash,
      walletId: original.walletId,
      ledgerAccountId: original.accountId,
      direction: "DEBIT",
      money: original.money,
      instructionId,
      instructionType: "LEDGER_REVERSAL",
      instructionHash,
      originatingAuthority: "ledger-posting-evidence-qa",
      reasonCode: "CORRECTION",
      reversalPolicyVersion: "ledger-reversal-v1",
      canonicalReversalHash,
      effectiveAt,
      minorUnitPrecision: 2,
      actorUserId: null,
      metadata: { qa: "ledger-posting-evidence" },
    }),
  });
  const body = await json(response);
  assert(response.ok, "Durable reversal must succeed.", { status: response.status, body });
  const replay = await fetch(
    `${ledgerUrl}/v1/ledger/posting-requests/${body.postingRequestId}/replay`,
    { method: "POST" }
  );
  const replayBody = await json(replay);
  assert(replay.ok && replayBody.evidence.result === "MATCH", "Reversal replay must MATCH.", { replayBody });
  pass("reversal replay matches");
}

async function insertSyntheticRequest(
  pool: Pool,
  wallet: WalletRow,
  entry: DirectLedgerEntry,
  overrides: Record<string, unknown>
) {
  const id = randomUUID();
  const values = {
    instructionId: entry.instructionId,
    instructionHash: entry.instructionHash,
    amount: entry.money.amount,
    currency: entry.money.currency,
    ...overrides,
  };
  await pool.query(
    `insert into ledger_service.ledger_posting_requests (
       id, request_kind, instruction_id, instruction_type, instruction_hash,
       originating_authority, ledger_wallet_id, ledger_account_id, direction,
       amount_minor, currency, minor_unit_precision, transaction_type,
       idempotency_key, canonical_request_hash, effective_at, correlation_metadata,
       request_status, completed_at, ledger_entry_id, ledger_entry_hash
     )
     values (
       $1, 'POSTING', $2, 'DEPOSIT', $3, 'ledger-posting-evidence-qa',
       $4, $5, 'CREDIT', $6, $7, 2, 'DEPOSIT',
       $8, $9, '2026-01-05T00:00:00Z', '{}'::jsonb,
       'COMPLETED', now(), $10, $11
     )`,
    [
      id,
      values.instructionId,
      values.instructionHash,
      wallet.id,
      wallet.account_id,
      values.amount,
      values.currency,
      entry.idempotencyKey,
      entry.canonicalRequestHash,
      entry.id,
      entry.canonicalRequestHash,
    ]
  );
  return id;
}

async function createDirectLedgerEntry(
  pool: Pool,
  wallet: WalletRow,
  amount: number
): Promise<DirectLedgerEntry> {
  const idempotencyKey = `qa-ledger-direct-${randomUUID()}`;
  const body = buildPosting(wallet, idempotencyKey, amount);
  const result = await pool.query<{ id: string }>(
    `select (public.post_financial_ledger_entry(
       $1, 'DEPOSIT', 'CREDIT', $2, 'qa_ledger_posting_evidence', $3, $3,
       jsonb_build_object(
         'instructionId', $4::text,
         'instructionType', 'DEPOSIT',
         'instructionHash', $5::text,
         'originatingAuthority', 'ledger-posting-evidence-qa',
         'effectiveAt', '2026-01-05T00:00:00.000Z'
       ),
       null, $6, null, null, null, null
     )).id::text as id`,
    [
      wallet.id,
      amount,
      idempotencyKey,
      body.instructionId,
      body.instructionHash,
      body.canonicalRequestHash,
    ]
  );

  return {
    id: result.rows[0].id,
    walletId: wallet.id,
    accountId: wallet.account_id,
    canonicalRequestHash: body.canonicalRequestHash,
    money: { amount, currency: "USD" },
    idempotencyKey,
    instructionId: body.instructionId,
    instructionHash: body.instructionHash,
  };
}

async function verifyReplayMismatch(pool: Pool, wallet: WalletRow) {
  for (const [name, overrides] of [
    ["amount", { amount: 126 }],
    ["currency", { currency: "CRC" }],
    ["instruction hash", { instructionHash: sha256("tampered") }],
  ] as const) {
    const entry = await createDirectLedgerEntry(pool, wallet, 125);
    const requestId = await insertSyntheticRequest(pool, wallet, entry, overrides);
    const response = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/replay`, { method: "POST" });
    const body = await json(response);
    assert(response.status === 409 && body.evidence.result === "MISMATCH",
      `Tampered ${name} must replay as MISMATCH.`, { body });
    pass(`tampered ${name} replay mismatch`);
  }
}

async function verifyRecovery(pool: Pool, wallet: WalletRow) {
  const key = `qa-ledger-recovery-${randomUUID()}`;
  const body = buildPosting(wallet, key, 77);
  const entryResult = await pool.query<{ id: string }>(
    `select (public.post_financial_ledger_entry(
       $1, 'DEPOSIT', 'CREDIT', 77, 'qa_ledger_posting_evidence', $2, $2,
       jsonb_build_object(
         'instructionId', $3::text,
         'instructionType', 'DEPOSIT',
         'instructionHash', $4::text,
         'originatingAuthority', 'ledger-posting-evidence-qa',
         'effectiveAt', '2026-01-05T00:00:00.000Z'
       ),
       null, $5, null, null, null, null
     )).id::text as id`,
    [wallet.id, key, body.instructionId, body.instructionHash, body.canonicalRequestHash]
  );
  const requestId = randomUUID();
  await pool.query(
    `insert into ledger_service.ledger_posting_requests (
       id, request_kind, instruction_id, instruction_type, instruction_hash,
       originating_authority, ledger_wallet_id, ledger_account_id, direction,
       amount_minor, currency, minor_unit_precision, transaction_type,
       idempotency_key, canonical_request_hash, effective_at, correlation_metadata,
       request_status
     )
     values ($1, 'POSTING', $2, 'DEPOSIT', $3, 'ledger-posting-evidence-qa',
       $4, $5, 'CREDIT', 77, 'USD', 2, 'DEPOSIT', $6, $7,
       '2026-01-05T00:00:00Z', '{}'::jsonb, 'CLAIMED')`,
    [requestId, body.instructionId, body.instructionHash, wallet.id, wallet.account_id, key, body.canonicalRequestHash]
  );
  const recovered = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/recover`, { method: "POST" });
  const recoveredBody = await json(recovered);
  assert(recovered.ok && recoveredBody.ledgerEntry.id === entryResult.rows[0].id,
    "Crash-after-commit recovery must reuse existing entry.", { recoveredBody });
  pass("unknown-result recovery proves committed entry");

  const unknownId = randomUUID();
  await pool.query(
    `insert into ledger_service.ledger_posting_requests (
       id, request_kind, instruction_id, instruction_type, instruction_hash,
       originating_authority, ledger_wallet_id, ledger_account_id, direction,
       amount_minor, currency, minor_unit_precision, transaction_type,
       idempotency_key, canonical_request_hash, effective_at, correlation_metadata,
       request_status
     )
     values ($1, 'POSTING', $2, 'DEPOSIT', $3, 'ledger-posting-evidence-qa',
       $4, $5, 'CREDIT', 88, 'USD', 2, 'DEPOSIT', $6, $7,
       '2026-01-05T00:00:00Z', '{}'::jsonb, 'CLAIMED')`,
    [unknownId, `unknown:${unknownId}`, sha256(unknownId), wallet.id, wallet.account_id,
      `unknown:${unknownId}`, sha256(`unknown:${unknownId}`)]
  );
  const unknown = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${unknownId}/recover`, { method: "POST" });
  const unknownBody = await json(unknown);
  assert(unknown.status === 409 && unknownBody.error.code === "LEDGER_UNKNOWN_RESULT",
    "Unprovable result must remain fail-closed.", { unknownBody });
  const stored = await json(await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${unknownId}`));
  assert(stored.postingRequest.status === "UNKNOWN", "Unknown request status must persist.", { stored });
  pass("unprovable unknown result fails closed");
}

async function verifyAppendOnly(pool: Pool, requestId: string) {
  const attempt = await pool.query<{ id: string }>(
    "select id::text from ledger_service.ledger_posting_attempts where posting_request_id = $1 limit 1",
    [requestId]
  );
  const replay = await pool.query<{ id: string }>(
    "select id::text from ledger_service.ledger_replay_evidence where posting_request_id = $1 limit 1",
    [requestId]
  );
  for (const [name, sql, id] of [
    ["attempt update", "update ledger_service.ledger_posting_attempts set result = 'FAILED' where id = $1", attempt.rows[0].id],
    ["attempt delete", "delete from ledger_service.ledger_posting_attempts where id = $1", attempt.rows[0].id],
    ["replay update", "update ledger_service.ledger_replay_evidence set replay_result = 'MISMATCH' where id = $1", replay.rows[0].id],
    ["replay delete", "delete from ledger_service.ledger_replay_evidence where id = $1", replay.rows[0].id],
  ] as const) {
    let blocked = false;
    try {
      await pool.query(sql, [id]);
    } catch (error) {
      blocked = error instanceof Error && error.message.includes("append-only");
    }
    assert(blocked, `${name} must be blocked.`);
  }
  pass("attempt and replay evidence append-only enforcement");
}

async function verifyReadiness() {
  const response = await fetch(`${ledgerUrl}/v1/ledger/health`);
  const body = await json(response);
  for (const marker of [
    "durablePostingRequestsReady",
    "postingAttemptsReady",
    "unknownResultRecoveryReady",
    "replayVerificationReady",
    "conflictSafeIdempotencyReady",
  ]) {
    assert(body.capabilities[marker] === true, `${marker} must be ready.`, { body });
  }
  assert(body.capabilities.serviceAuthorityEnabled === false, "Production Ledger authority must remain disabled.", { body });
  pass("posting evidence readiness markers");
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl(), max: 4 });
  try {
    const wallet = await seedWallet(pool);
    const posting = await verifyPostingLifecycle(pool, wallet);
    await verifyReversalReplay(posting.entry);
    await verifyReplayMismatch(pool, wallet);
    await verifyRecovery(pool, wallet);
    await verifyAppendOnly(pool, posting.requestId);
    await verifyReadiness();
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
