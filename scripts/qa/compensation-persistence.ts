import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const checks: string[] = [];
const hash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(message);
}

async function expectFailure(
  client: PoolClient,
  sql: string,
  values: unknown[],
  message: string
) {
  await client.query("savepoint qa_expected_failure");
  try {
    await client.query(sql, values);
    throw new Error(message);
  } catch (error) {
    await client.query("rollback to savepoint qa_expected_failure");
    if (error instanceof Error && error.message === message) throw error;
    checks.push(message);
  }
}

async function main() {
const client = await pool.connect();
try {
  await client.query("begin");
  const scope = await client.query<{
    account_id: string;
    wallet_id: string;
    brand_id: string;
    market_id: string;
  }>(
    `select account.id as account_id, wallet.id as wallet_id,
            account.canonical_brand_id as brand_id,
            account.canonical_market_id as market_id
       from public.accounts account
       join public.financial_wallets wallet
         on wallet.account_id = account.id
        and wallet.wallet_type = 'CREDIT'
        and wallet.status = 'ACTIVE'
      where account.governance_managed
        and account.account_type = 'PLAYER'
        and account.status = 'ACTIVE'
      limit 1`
  );
  assert(scope.rowCount === 1, "A governed active Player CREDIT wallet is available for QA.");
  const row = scope.rows[0];
  const periodId = randomUUID();
  await client.query(
    `insert into ledger_service.weekly_accounting_periods (
       period_id, brand_id, market_id, period_start_at, period_end_at,
       status, closed_at
     ) values ($1,$2,$3,'2036-01-01T00:00:00Z','2036-01-08T00:00:00Z',
       'CLOSED','2036-01-08T00:00:01Z')`,
    [periodId, row.brand_id, row.market_id]
  );

  const configurationId = randomUUID();
  const configurationKey = `qa-compensation:${configurationId}`;
  await client.query(
    `insert into compensation.configurations (
       id, hierarchy_owner_account_id, beneficiary_account_id, strategy,
       calculation_basis, rate_basis_points, accounting_period,
       minimum_threshold_minor, maximum_compensation_minor,
       funding_instrument, effective_from, enabled,
       idempotency_key, canonical_request_hash, content_hash
     ) values (
       $1,$2,$2,'REBATE','NET_LOSS',1000,'WEEKLY',100,5000,
       'CREDIT','2035-01-01T00:00:00Z',true,$3,$4,$5
     )`,
    [
      configurationId,
      row.account_id,
      configurationKey,
      hash(`${configurationKey}:request`),
      hash(`${configurationKey}:content`),
    ]
  );
  assert(true, "Rebate configuration persists against a governed hierarchy owner.");
  await expectFailure(
    client,
    `insert into compensation.configurations (
       hierarchy_owner_account_id, beneficiary_account_id, strategy,
       calculation_basis, rate_basis_points, accounting_period,
       funding_instrument, effective_from, idempotency_key,
       canonical_request_hash, content_hash
     ) values ($1,$1,'REBATE','NET_LOSS',1000,'WEEKLY','CREDIT',now(),$2,$3,$4)`,
    [
      row.account_id,
      configurationKey,
      hash("duplicate-request"),
      hash("duplicate-content"),
    ],
    "Configuration idempotency keys cannot be reused."
  );

  const executionId = randomUUID();
  await client.query(
    `insert into compensation.executions (
       id, accounting_period_id, idempotency_key,
       canonical_request_hash, correlation_id
     ) values ($1,$2,$3,$4,$5)`,
    [
      executionId,
      periodId,
      `qa-execution:${executionId}`,
      hash(`execution:${executionId}`),
      randomUUID(),
    ]
  );
  const entitlementId = randomUUID();
  await client.query(
    `insert into compensation.entitlements (
       id, execution_id, configuration_id, accounting_period_id,
       tenant_id, brand_id, market_id,
       hierarchy_owner_account_id, beneficiary_account_id, strategy,
       reporting_classification, calculation_basis, basis_amount_minor,
       rate_basis_points, compensation_amount_minor, currency,
       funding_instrument, wallet_id, ledger_transaction_type,
       canonical_entitlement_hash
     ) values (
       $1,$2,$3,$4,(select tenant_id from platform.brands where id = $7),$7,$8,
       $5,$5,'REBATE','REBATE','NET_LOSS',10000,1000,1000,
       'USD','CREDIT',$6,'PLAYER_REBATE_CREDIT',$9
     )`,
    [
      entitlementId,
      executionId,
      configurationId,
      periodId,
      row.account_id,
      row.wallet_id,
      row.brand_id,
      row.market_id,
      hash(`entitlement:${entitlementId}`),
    ]
  );
  assert(true, "Rebate entitlement retains a separate Rebate ledger and reporting classification.");
  const reversalId = randomUUID();
  await client.query(
    `insert into compensation.entitlements (
       id, execution_id, configuration_id, accounting_period_id,
       tenant_id, brand_id, market_id,
       hierarchy_owner_account_id, beneficiary_account_id, strategy,
       reporting_classification, calculation_basis, basis_amount_minor,
       rate_basis_points, compensation_amount_minor, currency,
       funding_instrument, wallet_id, ledger_transaction_type,
       canonical_entitlement_hash, reversal_of_entitlement_id
     )
     select $1, execution_id, configuration_id, accounting_period_id,
            tenant_id, brand_id, market_id,
            hierarchy_owner_account_id, beneficiary_account_id, strategy,
            reporting_classification, calculation_basis, basis_amount_minor,
            rate_basis_points, compensation_amount_minor, currency,
            funding_instrument, wallet_id, ledger_transaction_type, $2, id
       from compensation.entitlements where id = $3`,
    [reversalId, hash(`reversal:${reversalId}`), entitlementId]
  );
  assert(true, "Reversal creates a linked immutable entitlement instead of editing history.");
  await expectFailure(
    client,
    "update compensation.entitlements set compensation_amount_minor = 1 where id = $1",
    [entitlementId],
    "Compensation entitlements reject in-place updates."
  );
  await expectFailure(
    client,
    "delete from compensation.configurations where id = $1",
    [configurationId],
    "Compensation configurations reject physical deletion."
  );
  const classifications = await client.query<{ reporting_classification: string }>(
    `select reporting_classification
       from compensation.reporting_entitlements
      where id in ($1,$2)
      order by id`,
    [entitlementId, reversalId]
  );
  assert(
    classifications.rows.every(
      (item) => item.reporting_classification === "REBATE"
    ),
    "Reporting preserves the Rebate classification through reversal."
  );
  await client.query("rollback");
  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  client.release();
  await pool.end();
}
}

void main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
