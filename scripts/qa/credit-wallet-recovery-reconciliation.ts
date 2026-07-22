import { randomUUID } from "node:crypto";
import { Pool } from "pg";

type Check = { name: string; status: "PASS" };
const checks: Check[] = [];
const serviceUrl = (process.env.CREDIT_SERVICE_URL ?? "http://localhost:5300").replace(/\/$/, "");
const apiKey = process.env.CREDIT_WALLET_INTERNAL_API_KEY ?? "local-credit-wallet-internal-key";

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) fail(message, metadata);
}
function pass(name: string) { checks.push({ name, status: "PASS" }); }
async function body(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}
function headers() {
  return { "content-type": "application/json", "x-internal-service-name": "app",
    authorization: `Bearer ${apiKey}`, "x-correlation-id": `qa-wallet-recovery-${randomUUID()}` };
}
async function post(path: string, payload: unknown = {}) {
  const response = await fetch(`${serviceUrl}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(payload) });
  return { response, body: await body(response) };
}

async function seedScope(pool: Pool) {
  const organizationId = randomUUID(), tenantId = randomUUID(), brandId = randomUUID(), playerId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  await pool.query(`insert into platform.organizations(id,organization_code,name,status,version,content_hash)
    values($1,$2,$2,'Active','1.0.0',$3)`, [organizationId, `qa-recovery-org-${suffix}`, `sha256:${randomUUID().replaceAll("-", "")}`]);
  await pool.query(`insert into platform.tenants(id,organization_id,tenant_code,name,status,default_language,
    default_currency,default_timezone,credit_enabled,cashier_enabled,version,content_hash)
    values($1,$2,$3,$3,'Active','en','USD','UTC',true,false,'1.0.0',$4)`,
    [tenantId, organizationId, `qa-recovery-tenant-${suffix}`, `sha256:${randomUUID().replaceAll("-", "")}`]);
  await pool.query(`insert into platform.brands(id,tenant_id,brand_code,name,display_name,status,version,content_hash)
    values($1,$2,$3,$3,$3,'Active','1.0.0',$4)`,
    [brandId, tenantId, `qa-recovery-brand-${suffix}`, `sha256:${randomUUID().replaceAll("-", "")}`]);
  await pool.query(`insert into public.accounts(id,account_type,account_code,display_name,status)
    values($1,'PLAYER',$2,$2,'ACTIVE')`, [playerId, `qa-recovery-player-${suffix}`]);
  const wallet = await pool.query<{ id: string }>(`insert into public.financial_wallets(account_id,wallet_type,
    currency_code,balance_authority,status,balance,credit_limit,funding_model)
    values($1,'CREDIT','USD','INTERNAL','ACTIVE',100,100000,'CREDIT') returning id::text`, [playerId]);
  const walletId = wallet.rows[0].id;
  await pool.query(`insert into credit_wallet_service.wallet_scopes(wallet_id,tenant_id,brand_id,player_id,
    instrument_code,currency,authority) values($1,$2,$3,$4,'CREDIT','USD','CREDIT_WALLET_SERVICE')`,
    [walletId, tenantId, brandId, playerId]);
  return { tenantId, brandId, playerId, walletId };
}

async function reserve(scope: Awaited<ReturnType<typeof seedScope>>, amount = 250) {
  const requestId = randomUUID(), ticketId = randomUUID(), key = `qa-wallet-recovery-${randomUUID()}`;
  const request = {
    requestId, tenantId: scope.tenantId, brandId: scope.brandId, playerId: scope.playerId,
    walletId: scope.walletId, instrument: "CREDIT", operation: "RESERVE",
    money: { amount, currency: "USD" }, balanceImpact: null, authority: "CREDIT_WALLET_SERVICE",
    effectiveAt: "2026-07-18T00:00:00Z", ticketId, reservationId: null, settlementId: null,
    settlementBatchId: null, settlementInstructionId: null, settlementInstructionSequence: null,
    settlementInstructionHash: null, settlementVersion: null, settlementHash: null,
    settlementOutcome: null, ledgerInstructionId: null, ledgerPostingRequired: null,
    originalOperationId: null, correctsOperationId: null, reasonCode: "QA_RECOVERY",
    sourceService: "app", auditMetadata: { qa: "credit-wallet-recovery" },
  };
  const response = await fetch(`${serviceUrl}/v1/credit-wallets/internal/operations`, {
    method: "POST", headers: { ...headers(), "idempotency-key": key }, body: JSON.stringify(request),
  });
  const result = await body(response);
  assert(response.ok && result?.status === "COMMITTED", "Reserve fixture must commit.", { result });
  return { operationId: result.operationId as string, reservationId: result.effectReferenceId as string };
}

async function simulateCrash(pool: Pool, fixture: Awaited<ReturnType<typeof reserve>>, removeEffect: boolean) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("delete from credit_wallet_service.wallet_operation_terminal_results where operation_id=$1", [fixture.operationId]);
    if (removeEffect) await client.query("delete from public.credit_reservations where id=$1", [fixture.reservationId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const healthResponse = await fetch(`${serviceUrl}/v1/credit-wallets/health`);
    const health = await body(healthResponse);
    assert(healthResponse.ok && health?.canonicalOperations?.recovery?.durableRecoveryRepositoryReady === true,
      "Recovery readiness must be visible.", { health });
    assert(health.canonicalOperations.recovery.productionReady === false,
      "Recovery must not promote production authority.");
    pass("recovery readiness is durable and non-production");

    const scope = await seedScope(pool);
    const committed = await reserve(scope);
    const replay = await post(`/v1/credit-wallets/internal/operations/${committed.operationId}/replay`);
    assert(replay.response.ok && replay.body?.replayResult === "MATCH", "Committed replay must match.", { replay });
    const replayAgain = await post(`/v1/credit-wallets/internal/operations/${committed.operationId}/replay`);
    assert(replayAgain.response.ok && replayAgain.body?.replayResult === "MATCH", "Duplicate replay must be side-effect free.");
    const effectCount = await pool.query<{ count: string }>("select count(*)::text count from public.credit_reservations where id=$1", [committed.reservationId]);
    assert(effectCount.rows[0].count === "1", "Replay must not duplicate financial effects.");
    pass("deterministic replay is duplicate-safe");

    const settlementOperations = await pool.query<{ operation_id: string; operation_type: string }>(`select r.operation_id::text, r.operation_type
      from credit_wallet_service.wallet_operation_requests r
      join credit_wallet_service.settlement_instruction_authentication_evidence e using(operation_id)
      join credit_wallet_service.wallet_operation_terminal_results t using(operation_id)
      where r.operation_type in ('SETTLE','REVERSE') and t.terminal_status='COMMITTED'
      order by r.created_at desc`);
    for (const operation of settlementOperations.rows.filter((item, index, rows) =>
      rows.findIndex(candidate => candidate.operation_type === item.operation_type) === index)) {
      const authorityReplay = await post(`/v1/credit-wallets/internal/operations/${operation.operation_id}/replay`);
      assert(authorityReplay.response.ok && authorityReplay.body?.replayResult === "MATCH",
        `${operation.operation_type} replay must verify Settlement authentication and Ledger references.`, { authorityReplay });
    }
    assert(new Set(settlementOperations.rows.map(item => item.operation_type)).size >= 2,
      "Settlement and reversal fixtures are required for authority replay QA.");
    pass("settlement and reversal/correction replay verify authority references");

    const unknown = await reserve(scope);
    await simulateCrash(pool, unknown, false);
    const startup = await post("/v1/credit-wallets/internal/operations/recovery/startup-scan");
    assert(startup.response.ok && startup.body?.recovered >= 1, "Startup scan must reconstruct unknown terminal evidence.", { startup });
    const recoveredTerminal = await pool.query("select 1 from credit_wallet_service.wallet_operation_terminal_results where operation_id=$1", [unknown.operationId]);
    assert(recoveredTerminal.rowCount === 1, "Unknown operation must gain one terminal result.");
    pass("startup recovery reconstructs proven unknown outcome");

    const incomplete = await reserve(scope);
    await simulateCrash(pool, incomplete, true);
    const blocked = await post(`/v1/credit-wallets/internal/operations/${incomplete.operationId}/recover`, { allowRetry: false });
    assert(blocked.response.ok && blocked.body?.classification === "BLOCKED", "Incomplete operation must not auto-retry.", { blocked });
    const retried = await post(`/v1/credit-wallets/internal/operations/${incomplete.operationId}/recover`, { allowRetry: true });
    assert(retried.response.ok && retried.body?.classification === "COMMITTED", "Governed canonical retry must commit.", { retried });
    pass("incomplete operation requires governed retry");

    const concurrent = await reserve(scope);
    await simulateCrash(pool, concurrent, true);
    const recoveries = await Promise.all([
      post(`/v1/credit-wallets/internal/operations/${concurrent.operationId}/recover`, { allowRetry: true }),
      post(`/v1/credit-wallets/internal/operations/${concurrent.operationId}/recover`, { allowRetry: true }),
    ]);
    assert(recoveries.every(item => item.response.ok), "Concurrent recovery calls must resolve safely.", { recoveries });
    const concurrentEffects = await pool.query<{ count: string }>("select count(*)::text count from public.credit_reservations where idempotency_key=$1", [`canonical-wallet:${concurrent.operationId.replaceAll("-", "")}:RESERVE`]);
    assert(concurrentEffects.rows[0].count === "1", "Concurrent recovery must create one effect.");
    pass("concurrent recovery preserves one canonical effect");

    const failedKey = `qa-wallet-recovery-failed-${randomUUID()}`;
    const failedRequest = {
      requestId: randomUUID(), tenantId: scope.tenantId, brandId: scope.brandId, playerId: scope.playerId,
      walletId: scope.walletId, instrument: "CREDIT", operation: "RESERVE", money: { amount: 999999999, currency: "USD" },
      balanceImpact: null, authority: "CREDIT_WALLET_SERVICE", effectiveAt: "2026-07-18T00:00:00Z",
      ticketId: randomUUID(), reservationId: null, settlementId: null, settlementBatchId: null,
      settlementInstructionId: null, settlementInstructionSequence: null, settlementInstructionHash: null,
      settlementVersion: null, settlementHash: null, settlementOutcome: null, ledgerInstructionId: null,
      ledgerPostingRequired: null, originalOperationId: null, correctsOperationId: null,
      reasonCode: "QA_FAILURE", sourceService: "app", auditMetadata: {},
    };
    const failedResponse = await fetch(`${serviceUrl}/v1/credit-wallets/internal/operations`, {
      method: "POST", headers: { ...headers(), "idempotency-key": failedKey }, body: JSON.stringify(failedRequest),
    });
    assert(failedResponse.status === 400, "Failure fixture must fail.");
    const failedOperation = await pool.query<{ operation_id: string }>("select operation_id::text from credit_wallet_service.wallet_operation_requests where idempotency_key=$1", [failedKey]);
    const failedRecovery = await post(`/v1/credit-wallets/internal/operations/${failedOperation.rows[0].operation_id}/recover`, { allowRetry: true });
    assert(failedRecovery.response.ok && failedRecovery.body?.classification === "BLOCKED", "Terminal failure must remain blocked.");
    pass("failed operation remains terminal and blocked");

    const projection = await post(`/v1/credit-wallets/internal/operations/reconciliation/projection/${scope.walletId}`);
    assert(projection.response.ok && projection.body?.result === "MATCH", "Initial projection must reconstruct.", { projection });
    await pool.query("update public.financial_wallets set balance=balance+1 where id=$1", [scope.walletId]);
    const drift = await post(`/v1/credit-wallets/internal/operations/reconciliation/projection/${scope.walletId}`);
    assert(drift.response.ok && drift.body?.result === "DRIFT" && drift.body?.findings?.includes("WALLET_BALANCE_DRIFT"),
      "Projection drift must be reported without repair.", { drift });
    const stillDrifted = await pool.query<{ balance: string }>("select balance::text from public.financial_wallets where id=$1", [scope.walletId]);
    assert(Number(stillDrifted.rows[0].balance) === Number(drift.body.observedBalance),
      "Verification must not repair the wallet.", { observed: drift.body.observedBalance, persisted: stillDrifted.rows[0].balance });
    pass("balance reconstruction detects drift without repair");

    const reservation = await pool.query<{ id: string }>(`select id::text from public.credit_reservations
      where wallet_id=$1 and remaining_exposure > 1 order by created_at desc limit 1`, [scope.walletId]);
    const projectionClient = await pool.connect();
    try {
      await projectionClient.query("begin");
      await projectionClient.query("select set_config('credit_wallet_service.projection_mutation','approved',true)");
      await projectionClient.query(`update public.credit_reservations set released_amount=released_amount+1,
        remaining_exposure=remaining_exposure-1 where id=$1`, [reservation.rows[0].id]);
      await projectionClient.query("commit");
    } catch (error) {
      await projectionClient.query("rollback");
      throw error;
    } finally { projectionClient.release(); }
    const reservationDrift = await post(`/v1/credit-wallets/internal/operations/reconciliation/projection/${scope.walletId}`);
    assert(reservationDrift.response.ok && reservationDrift.body?.findings?.includes("RESERVATION_EXPOSURE_DRIFT"),
      "Reservation projection drift must be detected.", { reservationDrift });
    pass("reservation drift is detected without repair");

    const ledger = await post("/v1/credit-wallets/internal/operations/reconciliation/ledger");
    const settlement = await post("/v1/credit-wallets/internal/operations/reconciliation/settlement");
    assert(ledger.response.ok && ["MATCH", "MISMATCH"].includes(ledger.body?.result), "Ledger reconciliation must persist a deterministic report.", { ledger });
    assert(settlement.response.ok && ["MATCH", "MISMATCH"].includes(settlement.body?.result), "Settlement reconciliation must persist a deterministic report.", { settlement });
    pass("Ledger and Settlement reconciliation evidence persists");

    const statisticsResponse = await fetch(`${serviceUrl}/v1/credit-wallets/internal/operations/recovery/statistics`, { headers: headers() });
    const statistics = await body(statisticsResponse);
    assert(statisticsResponse.ok && typeof statistics?.replayBacklog === "number" &&
      typeof statistics?.ledgerMismatchFindings === "number" && typeof statistics?.settlementMismatchFindings === "number",
      "Operational recovery statistics must expose all diagnostic backlogs.", { statistics });
    pass("operational recovery and mismatch statistics are exposed");

    const evidence = await pool.query<{ recovery: string; replay: string; projection: string; reconciliation: string }>(`select
      (select count(*) from credit_wallet_service.wallet_recovery_evidence)::text recovery,
      (select count(*) from credit_wallet_service.wallet_replay_evidence)::text replay,
      (select count(*) from credit_wallet_service.wallet_projection_verifications)::text projection,
      (select count(*) from credit_wallet_service.wallet_reconciliation_evidence)::text reconciliation`);
    assert(Object.values(evidence.rows[0]).every(value => Number(value) > 0), "All evidence families must be populated.", { evidence: evidence.rows[0] });
    try {
      await pool.query("update credit_wallet_service.wallet_replay_evidence set replay_result='MISMATCH' where operation_id=$1", [committed.operationId]);
      fail("Replay evidence update should be blocked.");
    } catch { pass("recovery and reconciliation evidence is append-only"); }

    console.log(JSON.stringify({ status: "PASS", checkCount: checks.length, checks }, null, 2));
  } finally { await pool.end(); }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
