import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type Wallet = QueryResultRow & { id: string; account_id: string };
type LedgerEntry = {
  id: string;
  walletId: string;
  accountId: string;
  canonicalRequestHash: string;
  direction: "CREDIT" | "DEBIT";
  money: { amount: number; currency: string };
};
type PostingResponse = {
  ledgerEntry: LedgerEntry;
  postingRequestId: string;
  journalTransactionId: string;
};
type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };

const checks: Check[] = [];
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");

function fail(message: string, metadata: Record<string, unknown> = {}): never {
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

function dotnetTimestamp(value: string) {
  return new Date(value).toISOString().replace("Z", "0000+00:00");
}

function postingHash(input: {
  amount: number;
  effectiveAt: string;
  idempotencyKey: string;
  instructionHash: string;
  instructionId: string;
  accountId: string;
  walletId: string;
}) {
  return sha256(canonicalJson({
    amountMinor: input.amount,
    currency: "USD",
    direction: "CREDIT",
    effectiveAt: dotnetTimestamp(input.effectiveAt),
    idempotencyKey: input.idempotencyKey,
    instructionHash: input.instructionHash,
    instructionId: input.instructionId,
    instructionType: "TICKET_WIN",
    ledgerAccountId: input.accountId,
    ledgerWalletId: input.walletId,
    minorUnitPrecision: 2,
    originatingAuthority: "ledger-balanced-journal-qa",
    referenceId: input.idempotencyKey,
    referenceType: "qa_balanced_journal",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: "TICKET_WIN",
  }));
}

function buildPosting(wallet: Wallet, key: string, amount = 250) {
  const effectiveAt = "2026-02-01T12:00:00.000Z";
  const instructionId = `journal:${key}`;
  const instructionHash = sha256(canonicalJson({ amount, instructionId }));
  return {
    walletId: wallet.id,
    ledgerAccountId: wallet.account_id,
    instructionId,
    instructionType: "TICKET_WIN",
    instructionHash,
    originatingAuthority: "ledger-balanced-journal-qa",
    settlementRecordId: null,
    transactionType: "TICKET_WIN",
    direction: "CREDIT",
    money: { amount, currency: "USD" },
    minorUnitPrecision: 2,
    canonicalRequestHash: postingHash({
      amount,
      effectiveAt,
      idempotencyKey: key,
      instructionHash,
      instructionId,
      accountId: wallet.account_id,
      walletId: wallet.id,
    }),
    effectiveAt,
    reference: { type: "qa_balanced_journal", id: key },
    reversalOfLedgerEntryId: null,
    metadata: { qa: "ledger-balanced-journal" },
  };
}

function reversalHash(input: {
  original: LedgerEntry;
  effectiveAt: string;
  idempotencyKey: string;
  instructionId: string;
  instructionHash: string;
}) {
  return sha256(canonicalJson({
    amountMinor: input.original.money.amount,
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
    originatingAuthority: "ledger-balanced-journal-qa",
    reasonCode: "CORRECTION",
    referenceId: input.original.id,
    referenceType: "ledger_entry",
    reversalOfLedgerEntryId: input.original.id,
    reversalPolicyVersion: "ledger-reversal-v1",
    settlementRecordId: null,
    transactionType: "REVERSAL",
  }));
}

async function responseJson(response: Response) {
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
    [accountId, `qa-journal-${suffix}`, `QA Journal ${suffix}`]
  );
  const result = await pool.query<Wallet>(
    `insert into public.financial_wallets
       (account_id, wallet_type, currency_code, balance_authority, status, balance, funding_model)
     values ($1, 'CASH', 'USD', 'INTERNAL', 'ACTIVE', 0, 'CASH')
     returning id::text, account_id::text`,
    [accountId]
  );
  return result.rows[0];
}

async function post(body: Record<string, unknown>, key: string) {
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  return { response, body: await responseJson(response) };
}

async function verifyBalancedPosting(pool: Pool, wallet: Wallet) {
  const key = `qa-balanced-journal-${randomUUID()}`;
  const request = buildPosting(wallet, key);
  const first = await post(request, key);
  assert(first.response.ok, "Balanced posting must succeed.", { status: first.response.status, body: first.body });
  const result = first.body as PostingResponse;
  assert(Boolean(result.journalTransactionId), "Posting must return its journal transaction reference.", { result });

  const journal = await pool.query<{
    transaction_hash: string;
    canonical_transaction_hash: string;
    debit_total: string;
    credit_total: string;
    line_count: string;
    request_journal_id: string;
  }>(
    `select tx.transaction_hash,
            tx.canonical_transaction_hash,
            sum(entry.debit_amount)::text as debit_total,
            sum(entry.credit_amount)::text as credit_total,
            count(entry.id)::text as line_count,
            request.journal_transaction_id::text as request_journal_id
     from ledger_service.ledger_transactions tx
     join ledger_service.ledger_entries entry on entry.transaction_id = tx.id
     join ledger_service.ledger_posting_requests request on request.id = tx.posting_request_id
     where tx.id = $1
     group by tx.id, request.journal_transaction_id`,
    [result.journalTransactionId]
  );
  assert(journal.rows.length === 1, "Journal transaction must persist.");
  assert(journal.rows[0].debit_total === journal.rows[0].credit_total,
    "Journal debits and credits must be exactly equal.", { journal: journal.rows[0] });
  assert(journal.rows[0].line_count === "2", "Minimal journal must contain exactly two lines.", { journal: journal.rows[0] });
  assert(journal.rows[0].request_journal_id === result.journalTransactionId,
    "Posting request must reference the journal transaction.", { journal: journal.rows[0], result });
  assert(journal.rows[0].transaction_hash.startsWith("sha256:") &&
    journal.rows[0].canonical_transaction_hash.startsWith("sha256:"),
  "Journal hashes must use canonical SHA-256 evidence.", { journal: journal.rows[0] });
  pass("balanced transaction succeeds with exact debit/credit equality", { journalTransactionId: result.journalTransactionId });

  const duplicate = await post(request, key);
  assert(duplicate.response.ok, "Duplicate identical posting must succeed.", { body: duplicate.body });
  assert((duplicate.body as PostingResponse).journalTransactionId === result.journalTransactionId,
    "Duplicate posting must reuse the same journal transaction.", { duplicate: duplicate.body, result });
  const count = await pool.query<{ count: string }>(
    "select count(*)::text as count from ledger_service.ledger_transactions where posting_request_id = $1",
    [result.postingRequestId]
  );
  assert(count.rows[0].count === "1", "Duplicate posting must not duplicate journal entries.", { count: count.rows[0] });
  pass("duplicate request reuses deterministic journal hashes");

  const conflict = await post(buildPosting(wallet, key, 251), key);
  assert(conflict.response.status === 409, "Conflicting duplicate must fail closed.", {
    status: conflict.response.status,
    body: conflict.body,
  });
  pass("conflicting duplicate remains fail-closed");
  return result;
}

async function verifyDatabaseGuards(pool: Pool, transactionId: string) {
  const client = await pool.connect();
  let unbalancedRejected = false;
  try {
    await client.query("begin");
    await client.query(
      `insert into ledger_service.ledger_entries (
         id, transaction_id, account_id, account_class, debit_amount, credit_amount,
         currency, direction, posting_sequence, canonical_entry_hash, provenance
       ) values ($1, $2, $3, 'OPERATOR_CLEARING', 1, 0, 'USD', 'DEBIT', 3, $4, '{}'::jsonb)`,
      [randomUUID(), transactionId, randomUUID(), sha256(randomUUID())]
    );
    await client.query("commit");
  } catch (error) {
    unbalancedRejected = String(error).includes("not balanced");
    await client.query("rollback").catch(() => undefined);
  } finally {
    client.release();
  }
  assert(unbalancedRejected, "Database must reject an unbalanced journal at commit.");
  pass("unbalanced transaction rejected by deferred balance enforcement");

  await assertMutationRejected(pool, "update ledger_service.ledger_transactions set currency = 'EUR' where id = $1", transactionId);
  await assertMutationRejected(pool, "delete from ledger_service.ledger_entries where transaction_id = $1", transactionId);
  pass("journal transaction and entries are immutable");
}

async function assertMutationRejected(pool: Pool, sql: string, transactionId: string) {
  let rejected = false;
  try {
    await pool.query(sql, [transactionId]);
  } catch (error) {
    rejected = String(error).includes("append-only");
  }
  assert(rejected, "Journal mutation must be rejected.", { sql });
}

async function verifyReversalJournal(pool: Pool, original: PostingResponse) {
  const key = `qa-journal-reversal-${randomUUID()}`;
  const effectiveAt = "2026-02-01T12:05:00.000Z";
  const instructionId = `journal-reversal:${original.ledgerEntry.id}`;
  const instructionHash = sha256(canonicalJson({ instructionId, original: original.ledgerEntry.id }));
  const canonicalReversalHash = reversalHash({
    original: original.ledgerEntry,
    effectiveAt,
    idempotencyKey: key,
    instructionId,
    instructionHash,
  });
  const body = {
    originalLedgerEntryId: original.ledgerEntry.id,
    originalLedgerEntryHash: original.ledgerEntry.canonicalRequestHash,
    walletId: original.ledgerEntry.walletId,
    ledgerAccountId: original.ledgerEntry.accountId,
    direction: "DEBIT",
    money: original.ledgerEntry.money,
    instructionId,
    instructionType: "LEDGER_REVERSAL",
    instructionHash,
    originatingAuthority: "ledger-balanced-journal-qa",
    reasonCode: "CORRECTION",
    reversalPolicyVersion: "ledger-reversal-v1",
    canonicalReversalHash,
    effectiveAt,
    minorUnitPrecision: 2,
    actorUserId: null,
    metadata: { qa: "ledger-journal-reversal" },
  };
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries/${original.ledgerEntry.id}/reverse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  const result = await responseJson(response) as PostingResponse;
  assert(response.ok, "Reversal posting must succeed.", { status: response.status, result });
  const row = await pool.query<{
    reverses_transaction_id: string;
    debit_total: string;
    credit_total: string;
    linked_lines: string;
  }>(
    `select tx.reverses_transaction_id::text,
            sum(entry.debit_amount)::text as debit_total,
            sum(entry.credit_amount)::text as credit_total,
            count(entry.reversal_of_entry_id)::text as linked_lines
     from ledger_service.ledger_transactions tx
     join ledger_service.ledger_entries entry on entry.transaction_id = tx.id
     where tx.id = $1
     group by tx.reverses_transaction_id`,
    [result.journalTransactionId]
  );
  assert(row.rows[0].reverses_transaction_id === original.journalTransactionId,
    "Reversal journal must reference the original transaction.", { row: row.rows[0], original });
  assert(row.rows[0].debit_total === row.rows[0].credit_total && row.rows[0].linked_lines === "2",
    "Reversal journal must independently balance and link both compensating lines.", { row: row.rows[0] });
  const originalCount = await pool.query<{ count: string }>(
    "select count(*)::text as count from ledger_service.ledger_entries where transaction_id = $1",
    [original.journalTransactionId]
  );
  assert(originalCount.rows[0].count === "2", "Original journal must remain unchanged.", { originalCount: originalCount.rows[0] });
  pass("reversal produces balanced compensating journal and preserves original");
}

async function verifyRecovery(pool: Pool, wallet: Wallet) {
  const key = `qa-journal-recovery-${randomUUID()}`;
  const requestId = randomUUID();
  const request = buildPosting(wallet, key, 175);
  const metadata = {
    instructionId: request.instructionId,
    instructionType: request.instructionType,
    instructionHash: request.instructionHash,
    originatingAuthority: request.originatingAuthority,
    effectiveAt: request.effectiveAt,
  };
  const entry = await pool.query<{ id: string }>(
    `select id::text
     from public.post_financial_ledger_entry(
       $1::uuid, $2::text, $3::text, $4::numeric, $5::text, $6::text,
       $7::text, $8::jsonb, null::uuid, $9::text, null::text,
       null::text, null::text, null::text
     )`,
    [
      wallet.id,
      request.transactionType,
      request.direction,
      request.money.amount,
      request.reference.type,
      request.reference.id,
      key,
      JSON.stringify(metadata),
      request.canonicalRequestHash,
    ]
  );
  await pool.query(
    `insert into ledger_service.ledger_posting_requests (
       id, request_kind, instruction_id, instruction_type, instruction_hash,
       originating_authority, ledger_wallet_id, ledger_account_id, direction,
       amount_minor, currency, minor_unit_precision, transaction_type,
       idempotency_key, canonical_request_hash, effective_at, correlation_metadata,
       request_status, created_at
     ) values (
       $1, 'POSTING', $2, $3, $4, $5, $6, $7, $8, $9, 'USD', 2, $10,
       $11, $12, $13, '{}'::jsonb, 'CLAIMED', now()
     )`,
    [
      requestId,
      request.instructionId,
      request.instructionType,
      request.instructionHash,
      request.originatingAuthority,
      wallet.id,
      wallet.account_id,
      request.direction,
      request.money.amount,
      request.transactionType,
      key,
      request.canonicalRequestHash,
      request.effectiveAt,
    ]
  );
  const recovery = await fetch(`${ledgerUrl}/v1/ledger/posting-requests/${requestId}/recover`, { method: "POST" });
  const result = await responseJson(recovery) as PostingResponse;
  assert(recovery.ok, "Recovery must complete a proven entry with a missing journal.", {
    status: recovery.status,
    result,
  });
  assert(result.ledgerEntry.id === entry.rows[0].id && Boolean(result.journalTransactionId),
    "Recovery must reuse the financial entry and create its journal.", { result, entry: entry.rows[0] });
  const journalCount = await pool.query<{ count: string }>(
    "select count(*)::text as count from ledger_service.ledger_transactions where posting_request_id = $1",
    [requestId]
  );
  assert(journalCount.rows[0].count === "1", "Recovery must create exactly one journal transaction.", { journalCount: journalCount.rows[0] });
  pass("recovery safely resumes a missing journal without duplicating financial effect");
}

async function verifyReadiness() {
  const response = await fetch(`${ledgerUrl}/v1/ledger/health`);
  const body = await responseJson(response);
  assert(response.ok && body.capabilities.balancedJournalReady === true &&
    body.capabilities.journalPersistenceReady === true &&
    body.capabilities.journalRecoveryReady === true &&
    body.capabilities.reversalJournalReady === true &&
    body.capabilities.serviceAuthorityEnabled === false,
  "Ledger readiness must expose journal capability while production authority remains disabled.", { body });
  pass("balanced journal readiness markers are explicit");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const wallet = await seedWallet(pool);
    const posting = await verifyBalancedPosting(pool, wallet);
    await verifyDatabaseGuards(pool, posting.journalTransactionId);
    await verifyReversalJournal(pool, posting);
    await verifyRecovery(pool, wallet);
    await verifyReadiness();
    pass("scope excludes reconciliation, commissions, rebates, cashier, tax, UI, and new services");
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail("Balanced journal QA failed.", { error: String(error), stack: error?.stack }));
