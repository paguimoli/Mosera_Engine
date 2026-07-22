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
  canonicalRequestHash?: string | null;
  originalLedgerEntryHash?: string | null;
  reversalReasonCode?: string | null;
  reversalPolicyVersion?: string | null;
  canonicalReversalHash?: string | null;
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

async function postServiceLedgerEntry(wallet: WalletRow, idempotencyKey: string, amount: number) {
  const effectiveAt = "2026-01-02T00:00:00.000Z";
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
    referenceType: "qa_ledger_authority_dry_run",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: "DEPOSIT",
  });
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-ledger-authority-${idempotencyKey}`,
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
        type: "qa_ledger_authority_dry_run",
        id: idempotencyKey,
      },
      reversalOfLedgerEntryId: null,
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

async function reverseServiceLedgerEntry(originalEntry: LedgerEntry) {
  const effectiveAt = "2026-01-02T00:05:00.000Z";
  const idempotencyKey = `ledger-reversal:${originalEntry.id.replaceAll("-", "")}:authority-dry-run`;
  const instructionId = `reversal-${originalEntry.id}`;
  const instructionType = "LEDGER_REVERSAL";
  const reasonCode = "CORRECTION";
  const instructionHash = sha256(canonicalJson({ instructionId, instructionType, originalLedgerEntryId: originalEntry.id }));
  const canonicalReversalHash = sha256(canonicalJson({
    amountMinor: originalEntry.money.amount,
    currency: originalEntry.money.currency,
    direction: "DEBIT",
    effectiveAt: toDotNetUtcRoundtrip(effectiveAt),
    idempotencyKey,
    instructionHash,
    instructionId,
    instructionType,
    ledgerAccountId: originalEntry.accountId,
    ledgerWalletId: originalEntry.walletId,
    minorUnitPrecision: 2,
    originalLedgerEntryHash: originalEntry.canonicalRequestHash,
    originalLedgerEntryId: originalEntry.id,
    originatingAuthority: "ledger-service-qa",
    reasonCode,
    referenceId: originalEntry.id,
    referenceType: "ledger_entry",
    reversalOfLedgerEntryId: originalEntry.id,
    reversalPolicyVersion: "ledger-reversal-v1",
    settlementRecordId: null,
    transactionType: "REVERSAL",
  }));
  const response = await fetch(`${ledgerServiceUrl}/v1/ledger/entries/${originalEntry.id}/reverse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-ledger-reversal-${originalEntry.id}`,
    },
    body: JSON.stringify({
      originalLedgerEntryId: originalEntry.id,
      originalLedgerEntryHash: originalEntry.canonicalRequestHash,
      walletId: originalEntry.walletId,
      ledgerAccountId: originalEntry.accountId,
      direction: "DEBIT",
      money: originalEntry.money,
      instructionId,
      instructionType,
      instructionHash,
      originatingAuthority: "ledger-service-qa",
      reasonCode,
      reversalPolicyVersion: "ledger-reversal-v1",
      canonicalReversalHash,
      effectiveAt,
      minorUnitPrecision: 2,
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
  assert(body?.capabilities?.canonicalPostingContractReady === true, "Canonical posting contract should be ready.", {
    body,
  });
  assert(body?.capabilities?.canonicalHashValidationReady === true, "Canonical hash validation should be ready.", {
    body,
  });
  assert(body?.capabilities?.conflictSafeIdempotencyReady === true, "Conflict-safe idempotency should be ready.", {
    body,
  });
  assert(body?.capabilities?.currencyAccountValidationReady === true, "Currency/account validation should be ready.", {
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

    const serviceEntry = await postServiceLedgerEntry(serviceWallet, serviceIdempotencyKey, amount);
    const serviceDuplicate = await postServiceLedgerEntry(serviceWallet, serviceIdempotencyKey, amount);
    verifyDuplicateHandling(serviceEntry, serviceDuplicate, "Ledger Service");
    pass("duplicate handling matches", {
      monolithEntryId: monolithEntry.id,
      serviceEntryId: serviceEntry.id,
    });

    verifyEquivalentFinancialResult(monolithEntry, serviceEntry);

    const reversal = await reverseServiceLedgerEntry(serviceEntry);
    const duplicateReversal = await reverseServiceLedgerEntry(serviceEntry);
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
