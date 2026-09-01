import { randomUUID } from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const pool = new Pool({ connectionString: databaseUrl, max: 24, application_name: "qa-pr05d-lock-order" });
const checks = [];

function assert(value, message, metadata = {}) {
  if (!value) {
    console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
    process.exitCode = 1;
    throw new Error(message);
  }
}

function pass(name, metadata = {}) {
  checks.push({ name, status: "PASS", metadata });
}

async function walletScope() {
  const result = await pool.query(`
select wallet.id wallet_id, wallet.account_id player_id, scope.tenant_id,
  scope.brand_id, wallet.wallet_type instrument, wallet.currency_code currency
from public.financial_wallets wallet
join credit_wallet_service.wallet_scopes scope on scope.wallet_id=wallet.id
join public.accounts account on account.id=wallet.account_id
where wallet.status='ACTIVE' and wallet.wallet_type='CREDIT'
  and account.status='ACTIVE' and account.governance_managed
order by wallet.id
limit 1`);
  assert(result.rowCount === 1, "An active governed CREDIT wallet fixture is required.");
  return result.rows[0];
}

async function resolveFunding(scope, suffix) {
  return pool.query(`
select * from funding_authority.resolve_funding_instrument(
  $1,'CREDIT',$2,$3,'TICKET_ACCEPTANCE',$4,$5
)`, [
    scope.player_id,
    scope.wallet_id,
    scope.currency,
    `qa-pr05d-funding:${suffix}`,
    `qa-pr05d:${suffix}`,
  ]);
}

async function settlementStyleLock(scope, suffix) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('canonical-wallet:' || $1::uuid::text, 0))",
      [scope.wallet_id],
    );
    await client.query("select id from public.financial_wallets where id=$1 for update", [scope.wallet_id]);
    await client.query("select pg_sleep(0.002)");
    await client.query("commit");
    return suffix;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const definition = (await pool.query(`
select lower(pg_get_functiondef(p.oid)) value
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='funding_authority' and p.proname='resolve_funding_instrument'`)).rows[0]?.value ?? "";
  const lockOffset = definition.indexOf("canonical-wallet:");
  const insertOffset = definition.indexOf("insert into funding_authority.resolution_events");
  assert(lockOffset >= 0 && insertOffset > lockOffset,
    "Funding resolution must take the canonical wallet lock before evidence insertion.",
    { lockOffset, insertOffset });
  pass("canonical wallet lock precedes funding evidence FK acquisition");

  const scope = await walletScope();
  const before = (await pool.query(`
select deadlocks::bigint deadlocks from pg_stat_database where datname=current_database()`)).rows[0];
  const financialBefore = (await pool.query(`
select
  (select count(*)::bigint from ledger_service.ledger_transactions) ledger,
  (select count(*)::bigint from public.credit_settlement_applications) wallet,
  (select count(*)::bigint from ticket_completion_authority.completion_evidence) completion`)).rows[0];

  const holder = await pool.connect();
  try {
    await holder.query("begin");
    await holder.query(`
select * from funding_authority.resolve_funding_instrument(
  $1,'CREDIT',$2,$3,'TICKET_ACCEPTANCE',$4,$5
)`, [scope.player_id, scope.wallet_id, scope.currency,
      `qa-pr05d-held:${randomUUID()}`, `qa-pr05d-held:${randomUUID()}`]);

    const waiter = await pool.connect();
    try {
      await waiter.query("begin");
      await waiter.query("set local lock_timeout='250ms'");
      let lockTimedOut = false;
      try {
        await waiter.query(
          "select pg_advisory_xact_lock(hashtextextended('canonical-wallet:' || $1::uuid::text, 0))",
          [scope.wallet_id],
        );
      } catch (error) {
        lockTimedOut = error?.code === "55P03";
      }
      assert(lockTimedOut, "A competing wallet operation must wait at the shared canonical lock boundary.");
      await waiter.query("rollback");
    } finally {
      waiter.release();
    }
    await holder.query("commit");
  } catch (error) {
    await holder.query("rollback").catch(() => {});
    throw error;
  } finally {
    holder.release();
  }
  pass("ticket funding and wallet settlement-style work serialize at one lock boundary");

  const tasks = [];
  for (let index = 0; index < 48; index += 1) {
    tasks.push(resolveFunding(scope, `concurrent:${index}:${randomUUID()}`));
    tasks.push(settlementStyleLock(scope, `settlement:${index}`));
  }
  await Promise.all(tasks);

  const after = (await pool.query(`
select deadlocks::bigint deadlocks from pg_stat_database where datname=current_database()`)).rows[0];
  assert(BigInt(after.deadlocks) === BigInt(before.deadlocks),
    "Focused funding/wallet contention must not create a PostgreSQL deadlock.", { before, after });
  pass("96 concurrent funding and wallet lock contenders complete without a lock cycle", { deadlocks: 0 });

  const financialAfter = (await pool.query(`
select
  (select count(*)::bigint from ledger_service.ledger_transactions) ledger,
  (select count(*)::bigint from public.credit_settlement_applications) wallet,
  (select count(*)::bigint from ticket_completion_authority.completion_evidence) completion`)).rows[0];
  assert(JSON.stringify(financialAfter) === JSON.stringify(financialBefore),
    "Lock-order QA must not create Ledger, Wallet settlement, or Completion effects.",
    { financialBefore, financialAfter });
  pass("lock-order proof creates no financial or completion effects");

  console.log(JSON.stringify({ status: "PASS", scope: { walletId: scope.wallet_id }, checks }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}
