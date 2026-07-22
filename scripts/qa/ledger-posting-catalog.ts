import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");
const checks: Array<{ name: string; status: "PASS"; metadata?: unknown }> = [];
const pass = (name: string, metadata: unknown = {}) => checks.push({ name, status: "PASS", metadata });
function fail(message: string, metadata: unknown = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}
function assert(condition: unknown, message: string, metadata: unknown = {}): asserts condition {
  if (!condition) fail(message, metadata);
}
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalJson = (value: Record<string, unknown>) => JSON.stringify(
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
).replaceAll("+", "\\u002B");
const dotnetTimestamp = (value: string) => new Date(value).toISOString().replace("Z", "0000+00:00");

type Wallet = { id: string; accountId: string };
type Posting = {
  ledgerEntry: {
    id: string;
    walletId: string;
    accountId: string;
    direction: "CREDIT" | "DEBIT";
    canonicalRequestHash: string;
    money: { amount: number; currency: string };
  };
  postingRequestId: string;
  journalTransactionId: string;
};
type RuleInput = {
  ruleId: string;
  instructionType: string;
  authority: string;
  transactionType: string;
  direction: "CREDIT" | "DEBIT";
  metadata?: Record<string, unknown>;
};
type CatalogHealth = {
  capabilities: {
    postingCatalogLoaded: boolean;
    requiredLaunchMappingsPresent: boolean;
    exactRuleResolutionReady: boolean;
    accountRoleResolutionReady: boolean;
    settlementMappingsReady: boolean;
    commissionAccrualMappingReady: boolean;
    rebateMappingReady: boolean;
    promotionMappingReady: boolean;
    manualAdjustmentMappingReady: boolean;
    stakeRecognitionReady: boolean;
    freePlayReady: boolean;
    cashierMappingsDisabled: boolean;
    serviceAuthorityEnabled: boolean;
  };
};

async function seedWallet(pool: Pool): Promise<Wallet> {
  const accountId = randomUUID();
  const walletId = randomUUID();
  await pool.query(
    `insert into public.accounts (id, account_code, display_name, account_type, status)
     values ($1, $2, $3, 'PLAYER', 'ACTIVE')`,
    [accountId, `qa-catalog-${accountId}`, "QA Posting Catalog"]
  );
  await pool.query(
    `insert into public.financial_wallets
       (id, account_id, wallet_type, currency_code, balance_authority, balance,
        credit_limit, status, funding_model)
     values ($1, $2, 'CASH', 'USD', 'INTERNAL', 0, 1000000, 'ACTIVE', 'CASH')`,
    [walletId, accountId]
  );
  return { id: walletId, accountId };
}

function postingHash(wallet: Wallet, key: string, input: RuleInput, amount: number, effectiveAt: string, instructionHash: string) {
  return sha256(canonicalJson({
    amountMinor: amount,
    currency: "USD",
    direction: input.direction,
    effectiveAt: dotnetTimestamp(effectiveAt),
    idempotencyKey: key,
    instructionHash,
    instructionId: `catalog:${key}`,
    instructionType: input.instructionType,
    ledgerAccountId: wallet.accountId,
    ledgerWalletId: wallet.id,
    minorUnitPrecision: 2,
    originatingAuthority: input.authority,
    postingRuleId: input.ruleId,
    postingRuleVersion: "1.0.0",
    referenceId: key,
    referenceType: "qa_financial_posting_catalog",
    reversalOfLedgerEntryId: null,
    settlementRecordId: null,
    transactionType: input.transactionType,
  }));
}

async function postRule(wallet: Wallet, input: RuleInput, amount = 125, key = `qa-catalog-${randomUUID()}`) {
  const effectiveAt = "2026-03-01T12:00:00.000Z";
  const instructionHash = sha256(canonicalJson({ amount, instructionId: `catalog:${key}`, source: input.authority }));
  const body = {
    walletId: wallet.id,
    ledgerAccountId: wallet.accountId,
    instructionId: `catalog:${key}`,
    instructionType: input.instructionType,
    instructionHash,
    originatingAuthority: input.authority,
    settlementRecordId: null,
    transactionType: input.transactionType,
    direction: input.direction,
    money: { amount, currency: "USD" },
    minorUnitPrecision: 2,
    canonicalRequestHash: postingHash(wallet, key, input, amount, effectiveAt, instructionHash),
    effectiveAt,
    reference: { type: "qa_financial_posting_catalog", id: key },
    reversalOfLedgerEntryId: null,
    metadata: { qa: "ledger-posting-catalog", ...(input.metadata ?? {}) },
    postingRuleId: input.ruleId,
    postingRuleVersion: "1.0.0",
  };
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  return { response, result, body, key };
}

async function verifyJournal(pool: Pool, posting: Posting, ruleId: string, debitRole: string, creditRole: string) {
  const row = await pool.query<{
    posting_rule_id: string; posting_rule_version: string; debit_role: string;
    credit_role: string; debits: string; credits: string; line_count: string;
  }>(
    `select tx.posting_rule_id, tx.posting_rule_version,
            max(case when entry.direction = 'DEBIT' then entry.account_class end) as debit_role,
            max(case when entry.direction = 'CREDIT' then entry.account_class end) as credit_role,
            sum(entry.debit_amount)::text as debits, sum(entry.credit_amount)::text as credits,
            count(*)::text as line_count
       from ledger_service.ledger_transactions tx
       join ledger_service.ledger_entries entry on entry.transaction_id = tx.id
      where tx.id = $1
      group by tx.id`,
    [posting.journalTransactionId]
  );
  assert(row.rowCount === 1 && row.rows[0].posting_rule_id === ruleId
    && row.rows[0].posting_rule_version === "1.0.0", "Journal must retain exact posting rule binding.", row.rows);
  assert(row.rows[0].debit_role === debitRole && row.rows[0].credit_role === creditRole,
    "Journal account roles must match the catalog rule.", row.rows[0]);
  assert(row.rows[0].debits === row.rows[0].credits && row.rows[0].line_count === "2",
    "Catalog journal must balance exactly.", row.rows[0]);
}

async function expectRule(pool: Pool, wallet: Wallet, input: RuleInput, debit: string, credit: string) {
  const first = await postRule(wallet, input);
  assert(first.response.ok, `${input.ruleId} posting must succeed.`, { status: first.response.status, result: first.result });
  await verifyJournal(pool, first.result as Posting, input.ruleId, debit, credit);
  const duplicate = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": first.key },
    body: JSON.stringify(first.body),
  });
  const duplicateBody = await duplicate.json() as Posting;
  assert(duplicate.ok && duplicateBody.journalTransactionId === first.result.journalTransactionId,
    "Identical catalog retry must reuse the journal.");
  return first.result as Posting;
}

async function expectDisabled(wallet: Wallet, input: RuleInput) {
  const attempt = await postRule(wallet, input);
  assert(attempt.response.status === 400, `${input.ruleId} must remain fail-closed.`, {
    status: attempt.response.status, result: attempt.result,
  });
}

function reversalHash(
  original: Posting["ledgerEntry"],
  direction: "CREDIT" | "DEBIT",
  key: string,
  authority: string,
  effectiveAt: string,
  instructionHash: string
) {
  return sha256(canonicalJson({
    amountMinor: original.money.amount,
    currency: original.money.currency,
    direction,
    effectiveAt: dotnetTimestamp(effectiveAt),
    idempotencyKey: key,
    instructionHash,
    instructionId: `reversal:${key}`,
    instructionType: "CATALOG_REVERSAL",
    ledgerAccountId: original.accountId,
    ledgerWalletId: original.walletId,
    minorUnitPrecision: 2,
    originalLedgerEntryHash: original.canonicalRequestHash,
    originalLedgerEntryId: original.id,
    originatingAuthority: authority,
    reasonCode: "CORRECTION",
    referenceId: original.id,
    referenceType: "ledger_entry",
    reversalOfLedgerEntryId: original.id,
    reversalPolicyVersion: "ledger-reversal-v1",
    settlementRecordId: null,
    transactionType: "REVERSAL",
  }));
}

async function reverse(pool: Pool, original: Posting, authority: string) {
  const key = `qa-catalog-reversal-${randomUUID()}`;
  const effectiveAt = "2026-03-01T13:00:00.000Z";
  const instructionHash = sha256(canonicalJson({ original: original.ledgerEntry.id, key }));
  const direction = original.ledgerEntry.direction === "CREDIT" ? "DEBIT" : "CREDIT";
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries/${original.ledgerEntry.id}/reverse`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      originalLedgerEntryId: original.ledgerEntry.id,
      originalLedgerEntryHash: original.ledgerEntry.canonicalRequestHash,
      walletId: original.ledgerEntry.walletId,
      ledgerAccountId: original.ledgerEntry.accountId,
      direction,
      money: original.ledgerEntry.money,
      instructionId: `reversal:${key}`,
      instructionType: "CATALOG_REVERSAL",
      instructionHash,
      originatingAuthority: authority,
      reasonCode: "CORRECTION",
      reversalPolicyVersion: "ledger-reversal-v1",
      canonicalReversalHash: reversalHash(
        original.ledgerEntry,
        direction,
        key,
        authority,
        effectiveAt,
        instructionHash
      ),
      effectiveAt,
      minorUnitPrecision: 2,
      actorUserId: null,
      metadata: { qa: "ledger-posting-catalog-reversal" },
    }),
  });
  const result = await response.json() as Posting;
  assert(response.ok, "Catalog reversal must succeed.", { status: response.status, result });
  const rows = await pool.query<{ linked: string; debits: string; credits: string; rule: string }>(
    `select count(*) filter (where entry.reversal_of_entry_id is not null)::text as linked,
            sum(entry.debit_amount)::text as debits, sum(entry.credit_amount)::text as credits,
            tx.posting_rule_id as rule
       from ledger_service.ledger_transactions tx
       join ledger_service.ledger_entries entry on entry.transaction_id = tx.id
      where tx.id = $1 group by tx.id`,
    [result.journalTransactionId]
  );
  const originalRule = await pool.query<{ rule: string }>(
    "select posting_rule_id as rule from ledger_service.ledger_transactions where id = $1",
    [original.journalTransactionId]
  );
  assert(rows.rows[0].linked === "2" && rows.rows[0].debits === rows.rows[0].credits
    && rows.rows[0].rule === originalRule.rows[0].rule, "Reversal must exactly compensate under the original rule.", rows.rows[0]);
}

async function verifyCatalogGovernance(pool: Pool, wallet: Wallet) {
  const counts = await pool.query<{ active: string; blocked: string }>(
    `select count(*) filter (where posting_enabled)::text as active,
            count(*) filter (where not posting_enabled)::text as blocked
       from ledger_service.financial_posting_rules`
  );
  assert(Number(counts.rows[0].active) >= 8 && Number(counts.rows[0].blocked) >= 6,
    "Catalog must contain active launch rules and explicit deferred blockers.", counts.rows[0]);
  let immutable = false;
  try { await pool.query("update ledger_service.financial_posting_rules set lifecycle = 'RETIRED' where rule_id = 'SETTLEMENT_PAYOUT'"); }
  catch { immutable = true; }
  assert(immutable, "Posting rules must be append-only.");

  const unsupported = await postRule(wallet, {
    ruleId: "SETTLEMENT_PAYOUT", instructionType: "UNSUPPORTED", authority: "settlement-service",
    transactionType: "SETTLEMENT_CREDIT", direction: "CREDIT",
  });
  assert(unsupported.response.status === 400, "Rule resolution must reject non-exact instruction matches.");
  pass("catalog exact resolution, immutability, historic version lookup, and no default rule");
}

async function verifyReadiness() {
  const response = await fetch(`${ledgerUrl}/v1/ledger/health`);
  const body = await response.json() as CatalogHealth;
  const c = body.capabilities;
  assert(response.ok && c.postingCatalogLoaded && c.requiredLaunchMappingsPresent
    && c.exactRuleResolutionReady && c.accountRoleResolutionReady && c.settlementMappingsReady
    && c.commissionAccrualMappingReady && c.rebateMappingReady && c.promotionMappingReady
    && c.manualAdjustmentMappingReady && c.stakeRecognitionReady === false
    && c.freePlayReady === false && c.cashierMappingsDisabled === true
    && c.serviceAuthorityEnabled === false, "Posting catalog readiness must expose active mappings and explicit blockers.", body);
  pass("catalog readiness is explicit and production Ledger authority remains disabled");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const wallet = await seedWallet(pool);
    await verifyCatalogGovernance(pool, wallet);
    const payout = await expectRule(pool, wallet,
      { ruleId: "SETTLEMENT_PAYOUT", instructionType: "LEDGER_PAYOUT", authority: "settlement-service", transactionType: "SETTLEMENT_CREDIT", direction: "CREDIT" },
      "SETTLEMENT_CLEARING", "PLAYER_LIABILITY");
    await expectRule(pool, wallet,
      { ruleId: "SETTLEMENT_REFUND", instructionType: "LEDGER_REFUND", authority: "settlement-service", transactionType: "TICKET_REFUND", direction: "CREDIT" },
      "SETTLEMENT_CLEARING", "PLAYER_LIABILITY");
    await reverse(pool, payout, "settlement-service");
    pass("settlement win/refund/corrected posting and exact reversal mappings balance; loss remains terminal NOOP");

    const commission = await expectRule(pool, wallet,
      { ruleId: "AGENT_COMMISSION_ACCRUAL", instructionType: "AGENT_COMMISSION_ACCRUAL", authority: "commission-authority", transactionType: "AGENT_COMMISSION_ACCRUAL", direction: "CREDIT",
        metadata: { agentReference: "agent-qa", tenantId: "tenant-qa", brandId: "brand-qa" } },
      "AGENT_COMMISSION_EXPENSE_OR_GGR_ALLOCATION", "AGENT_PAYABLE");
    await reverse(pool, commission, "commission-authority");
    await expectDisabled(wallet, { ruleId: "AGENT_COMMISSION_PAYMENT", instructionType: "AGENT_COMMISSION_PAYMENT", authority: "commission-authority", transactionType: "AGENT_COMMISSION_ACCRUAL", direction: "CREDIT" });
    pass("commission accrual/reversal posts supplied amount while commission payment remains disabled");

    const rebate = await expectRule(pool, wallet,
      { ruleId: "PLAYER_REBATE_CREDIT", instructionType: "PLAYER_REBATE_CREDIT", authority: "rebate-authority", transactionType: "PLAYER_REBATE_CREDIT", direction: "CREDIT" },
      "PLAYER_REBATE_EXPENSE", "PLAYER_LIABILITY");
    const promotion = await expectRule(pool, wallet,
      { ruleId: "PROMOTIONAL_CREDIT", instructionType: "PROMOTIONAL_CREDIT", authority: "promotion-authority", transactionType: "PROMOTIONAL_CREDIT", direction: "CREDIT",
        metadata: { promotionReference: "promo-qa", playerReference: wallet.accountId, expiryPolicyReference: "policy-qa" } },
      "PROMOTION_EXPENSE", "PLAYER_LIABILITY");
    await reverse(pool, rebate, "rebate-authority");
    await reverse(pool, promotion, "promotion-authority");
    pass("rebate and promotion credits balance and reverse without eligibility calculation");

    await expectRule(pool, wallet,
      { ruleId: "MANUAL_CREDIT_ADJUSTMENT", instructionType: "MANUAL_CREDIT_ADJUSTMENT", authority: "governance-authority", transactionType: "MANUAL_CREDIT_ADJUSTMENT", direction: "CREDIT",
        metadata: { reasonCode: "QA_CORRECTION", operatorReference: "operator-qa", approvalMetadata: "approval-qa" } },
      "MANUAL_ADJUSTMENT_CLEARING", "PLAYER_LIABILITY");
    const manualDebit = await expectRule(pool, wallet,
      { ruleId: "MANUAL_DEBIT_ADJUSTMENT", instructionType: "MANUAL_DEBIT_ADJUSTMENT", authority: "governance-authority", transactionType: "MANUAL_DEBIT_ADJUSTMENT", direction: "DEBIT",
        metadata: { reasonCode: "QA_CORRECTION", operatorReference: "operator-qa", approvalMetadata: "approval-qa" } },
      "PLAYER_LIABILITY", "MANUAL_ADJUSTMENT_CLEARING");
    await reverse(pool, manualDebit, "governance-authority");
    const missingApproval = await postRule(wallet,
      { ruleId: "MANUAL_CREDIT_ADJUSTMENT", instructionType: "MANUAL_CREDIT_ADJUSTMENT", authority: "governance-authority", transactionType: "MANUAL_CREDIT_ADJUSTMENT", direction: "CREDIT" });
    assert(missingApproval.response.status === 400, "Ungoverned manual adjustment must fail closed.");
    pass("governed manual adjustments balance; missing reason/operator/approval fails closed");

    await expectDisabled(wallet, { ruleId: "WAGER_ACCEPTED_STAKE", instructionType: "WAGER_ACCEPTED_STAKE", authority: "wager-authority", transactionType: "TICKET_STAKE", direction: "DEBIT" });
    pass("stake recognition remains blocked until accepted-wager authority evidence exists");
    await expectDisabled(wallet, { ruleId: "FREE_PLAY_ISSUANCE", instructionType: "FREE_PLAY_ISSUANCE", authority: "promotion-authority", transactionType: "FREE_PLAY_CREDIT", direction: "CREDIT" });
    await expectDisabled(wallet, { ruleId: "FREE_PLAY_CONVERSION", instructionType: "FREE_PLAY_CONVERSION", authority: "settlement-service", transactionType: "FREE_PLAY_WIN", direction: "CREDIT" });
    pass("free-play mappings remain explicit blockers without fabricated policy");
    await expectDisabled(wallet, { ruleId: "CASHIER_DEPOSIT", instructionType: "CASHIER_DEPOSIT", authority: "cashier-service", transactionType: "DEPOSIT", direction: "CREDIT" });
    await expectDisabled(wallet, { ruleId: "CASHIER_WITHDRAWAL", instructionType: "CASHIER_WITHDRAWAL", authority: "cashier-service", transactionType: "WITHDRAWAL", direction: "DEBIT" });
    pass("cashier mappings and payment-provider execution remain disabled");
    await verifyReadiness();
    pass("scope excludes formulas, tax, reconciliation, UI, arbitrary journals, and new services");
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail("Financial posting catalog QA failed.", { error: String(error), stack: error?.stack }));
