import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");
const checks: Array<{ name: string; status: "PASS" }> = [];
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalJson = (value: Record<string, unknown>) => JSON.stringify(
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
).replaceAll("+", "\\u002B");
const dotnetTimestamp = (value: string) => new Date(value).toISOString().replace("Z", "0000+00:00");
const pass = (name: string) => checks.push({ name, status: "PASS" });
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) {
    console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
    process.exit(1);
  }
}
async function json(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}
function postingHash(input: Record<string, unknown>) {
  return sha256(canonicalJson(input));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  assert(databaseUrl, "DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const organizationId = randomUUID();
    const tenantId = randomUUID();
    const brandId = randomUUID();
    const marketId = randomUUID();
    const accountId = randomUUID();
    const walletId = randomUUID();
    await pool.query(`insert into platform.organizations
      (id, organization_code, name, status, version, content_hash, audit_metadata)
      values ($1,$2,$3,'Active','1.0.0',$4,'{}')`,
      [organizationId, `qa-period-org-${suffix}`, `QA Period Org ${suffix}`, sha256(`org:${suffix}`)]);
    await pool.query(`insert into platform.tenants
      (id, organization_id, tenant_code, name, status, default_language, default_currency,
       default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata)
      values ($1,$2,$3,$4,'Active','en','USD','UTC',true,false,'1.0.0',$5,'{}')`,
      [tenantId, organizationId, `qa-period-tenant-${suffix}`, `QA Period Tenant ${suffix}`, sha256(`tenant:${suffix}`)]);
    await pool.query(`insert into platform.brands
      (id, tenant_id, brand_code, name, display_name, status, version, content_hash, audit_metadata)
      values ($1,$2,$3,$3,$3,'Active','1.0.0',$4,'{}')`,
      [brandId, tenantId, `qa-period-brand-${suffix}`, sha256(`brand:${suffix}`)]);
    await pool.query(`insert into platform.markets
      (id, brand_id, market_code, name, display_name, language, currency, timezone,
       status, version, content_hash, audit_metadata)
      values ($1,$2,$3,$3,$3,'en','USD','UTC','Active','1.0.0',$4,'{}')`,
      [marketId, brandId, `qa-period-market-${suffix}`, sha256(`market:${suffix}`)]);
    await pool.query(`insert into public.accounts
      (id, account_type, account_code, display_name, status)
      values ($1,'PLAYER',$2,$3,'ACTIVE')`, [accountId, `qa-period-${suffix}`, `QA Period ${suffix}`]);
    await pool.query(`insert into public.financial_wallets
      (id, account_id, wallet_type, currency_code, balance_authority, status, balance, credit_limit, funding_model)
      values ($1,$2,'CREDIT','USD','INTERNAL','ACTIVE',0,100000,'CREDIT')`, [walletId, accountId]);
    await pool.query(`insert into credit_wallet_service.wallet_scopes
      (wallet_id, tenant_id, brand_id, player_id, instrument_code, currency, authority, audit_metadata)
      values ($1,$2,$3,$4,'CREDIT','USD','CREDIT_WALLET_SERVICE','{}')`,
      [walletId, tenantId, brandId, accountId]);

    const closedPeriodId = randomUUID();
    const openPeriodId = randomUUID();
    const closedStart = "2026-01-01T00:00:00.000Z";
    const closedEnd = "2026-01-08T00:00:00.000Z";
    const now = new Date();
    const openStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const openEnd = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(`insert into ledger_service.weekly_accounting_periods
      (period_id, brand_id, market_id, period_start_at, period_end_at, status, closed_at)
      values ($1,$2,$3,$4,$5,'CLOSED',$5), ($6,$2,$3,$7,$8,'OPEN',null)`,
      [closedPeriodId, brandId, marketId, closedStart, closedEnd, openPeriodId, openStart, openEnd]);

    async function post(effectiveAt: string, accountingPostedAt: string, key: string) {
      const instructionHash = sha256(`instruction:${key}`);
      const material = {
        amountMinor: 100, currency: "USD", direction: "CREDIT", effectiveAt: dotnetTimestamp(effectiveAt),
        idempotencyKey: key, instructionHash, instructionId: key, instructionType: "DEPOSIT",
        ledgerAccountId: accountId, ledgerWalletId: walletId, minorUnitPrecision: 2,
        originatingAuthority: "ledger-accounting-period-qa", referenceId: key,
        referenceType: "qa_accounting_period", reversalOfLedgerEntryId: null,
        settlementRecordId: null, transactionType: "DEPOSIT",
      };
      const response = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          walletId, ledgerAccountId: accountId, instructionId: key, instructionType: "DEPOSIT",
          instructionHash, originatingAuthority: "ledger-accounting-period-qa", settlementRecordId: null,
          transactionType: "DEPOSIT", direction: "CREDIT", money: { amount: 100, currency: "USD" },
          minorUnitPrecision: 2, canonicalRequestHash: postingHash(material), effectiveAt,
          accountingPostedAt, accountingMarketId: marketId,
          reference: { type: "qa_accounting_period", id: key }, reversalOfLedgerEntryId: null,
          metadata: { source: "qa:ledger-accounting-period-enforcement" },
        }),
      });
      return { response, body: await json(response) };
    }

    const open = await post(now.toISOString(), now.toISOString(), `qa-open-period-${randomUUID()}`);
    assert(open.response.ok, "Posting in the current open period must succeed.", { open });
    pass("posting into open week succeeds");

    const closed = await post(closedStart, "2026-01-02T00:00:00.000Z", `qa-closed-period-${randomUUID()}`);
    assert(closed.response.status === 400 && closed.body?.error?.details?.field === "accountingPeriod",
      "Direct posting into a closed period must fail closed.", { closed });
    pass("new posting into closed week is rejected");

    const delayedKey = `qa-delayed-period-${randomUUID()}`;
    const delayed = await post(closedStart, now.toISOString(), delayedKey);
    assert(delayed.response.ok, "Delayed effect must post in the current open period.", { delayed });
    const delayedRecord = await pool.query(`select * from ledger_service.ledger_posting_requests where id=$1`,
      [delayed.body.postingRequestId]);
    assert(delayedRecord.rows[0].original_accounting_period_id === closedPeriodId
      && delayedRecord.rows[0].posting_accounting_period_id === openPeriodId,
    "Delayed posting must preserve original and current period references.", { row: delayedRecord.rows[0] });
    assert(new Date(delayedRecord.rows[0].effective_at).toISOString() === new Date(closedStart).toISOString(),
      "Delayed posting must preserve the original business timestamp.");
    pass("delayed posting preserves business time and posts in open week");

    const original = delayed.body.ledgerEntry;
    const reversalKey = `qa-period-reversal-${randomUUID()}`;
    const reversalInstructionHash = sha256(`instruction:${reversalKey}`);
    const reversalMaterial = {
      amountMinor: 100, currency: "USD", direction: "DEBIT", effectiveAt: dotnetTimestamp(closedStart),
      idempotencyKey: reversalKey, instructionHash: reversalInstructionHash, instructionId: reversalKey,
      instructionType: "LEDGER_REVERSAL", ledgerAccountId: accountId, ledgerWalletId: walletId,
      minorUnitPrecision: 2, originalLedgerEntryHash: original.canonicalRequestHash,
      originalLedgerEntryId: original.id, originatingAuthority: "ledger-reversal-qa", reasonCode: "CORRECTION",
      referenceId: original.id, referenceType: "ledger_entry", reversalOfLedgerEntryId: original.id,
      reversalPolicyVersion: "ledger-reversal-v1", settlementRecordId: null, transactionType: "REVERSAL",
    };
    const reversalResponse = await fetch(`${ledgerUrl}/v1/ledger/entries/${original.id}/reverse`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": reversalKey },
      body: JSON.stringify({
        originalLedgerEntryId: original.id, originalLedgerEntryHash: original.canonicalRequestHash,
        walletId, ledgerAccountId: accountId, direction: "DEBIT", money: { amount: 100, currency: "USD" },
        instructionId: reversalKey, instructionType: "LEDGER_REVERSAL", instructionHash: reversalInstructionHash,
        originatingAuthority: "ledger-reversal-qa", reasonCode: "CORRECTION",
        reversalPolicyVersion: "ledger-reversal-v1", canonicalReversalHash: postingHash(reversalMaterial),
        effectiveAt: closedStart, minorUnitPrecision: 2, actorUserId: null,
        accountingPostedAt: now.toISOString(), accountingMarketId: marketId,
        metadata: { source: "qa:ledger-accounting-period-enforcement" },
      }),
    });
    const reversal = await json(reversalResponse);
    assert(reversalResponse.ok, "Closed-week correction reversal must post in the current open period.", { reversal });
    const reversalRecord = await pool.query(`select * from ledger_service.ledger_posting_requests where id=$1`,
      [reversal.postingRequestId]);
    assert(reversalRecord.rows[0].original_accounting_period_id === closedPeriodId
      && reversalRecord.rows[0].posting_accounting_period_id === openPeriodId
      && reversalRecord.rows[0].original_ledger_entry_id === original.id,
    "Reversal must preserve original transaction and accounting-period references.", { row: reversalRecord.rows[0] });
    pass("closed-week reversal/correction posts in current open week with immutable links");

    console.log(JSON.stringify({ status: "PASS", checks, authorities: {
      ledger: "MONOLITH", credit: "MONOLITH", settlement: "MONOLITH",
    } }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: "FAIL", error: String(error?.stack ?? error), checks }, null, 2));
  process.exit(1);
});
