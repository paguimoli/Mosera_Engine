import { randomUUID } from "node:crypto";
import { Pool } from "pg";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };

const checks: Check[] = [];
const serviceUrl = (process.env.CREDIT_SERVICE_URL ?? "http://localhost:5300").replace(/\/$/, "");
const internalApiKey = process.env.CREDIT_WALLET_INTERNAL_API_KEY ?? "local-credit-wallet-internal-key";

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}

function assert(condition: unknown, message: string, metadata: Record<string, unknown> = {}): asserts condition {
  if (!condition) fail(message, metadata);
}

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

async function json(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function postOperation(body: Record<string, unknown>, idempotencyKey: string) {
  const response = await fetch(`${serviceUrl}/v1/credit-wallets/internal/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-correlation-id": `qa-canonical-wallet-${randomUUID()}`,
      "x-internal-service-name": "app",
      authorization: `Bearer ${internalApiKey}`,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await json(response) };
}

async function expectDatabaseRejection(action: () => Promise<unknown>, name: string) {
  try {
    await action();
    fail(`${name} should be rejected.`);
  } catch (error) {
    assert(error instanceof Error, `${name} should return a database error.`);
    pass(name);
  }
}

async function seedScope(pool: Pool) {
  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const playerId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

  await pool.query(
    `insert into platform.organizations
       (id, organization_code, name, status, version, content_hash, audit_metadata)
     values ($1, $2, $3, 'Active', '1.0.0', $4, '{"source":"qa"}')`,
    [organizationId, `qa-wallet-org-${suffix}`, `QA Wallet Org ${suffix}`, `sha256:${randomUUID().replaceAll("-", "")}`]
  );
  await pool.query(
    `insert into platform.tenants
       (id, organization_id, tenant_code, name, status, default_language, default_currency,
        default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata)
     values ($1, $2, $3, $4, 'Active', 'en', 'USD', 'UTC', true, false, '1.0.0', $5, '{"source":"qa"}')`,
    [tenantId, organizationId, `qa-wallet-tenant-${suffix}`, `QA Wallet Tenant ${suffix}`, `sha256:${randomUUID().replaceAll("-", "")}`]
  );
  for (const [id, code] of [[brandId, `qa-wallet-brand-${suffix}`], [otherBrandId, `qa-wallet-other-${suffix}`]]) {
    await pool.query(
      `insert into platform.brands
         (id, tenant_id, brand_code, name, display_name, status, version, content_hash, audit_metadata)
       values ($1, $2, $3, $4, $4, 'Active', '1.0.0', $5, '{"source":"qa"}')`,
      [id, tenantId, code, code, `sha256:${randomUUID().replaceAll("-", "")}`]
    );
  }
  await pool.query(
    `insert into public.accounts (id, account_type, account_code, display_name, status)
     values ($1, 'PLAYER', $2, $3, 'ACTIVE')`,
    [playerId, `qa-wallet-player-${suffix}`, `QA Wallet Player ${suffix}`]
  );
  const wallet = await pool.query<{ id: string }>(
    `insert into public.financial_wallets
       (account_id, wallet_type, currency_code, balance_authority, status, balance, credit_limit, funding_model)
     values ($1, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', 100, 100000, 'CREDIT')
     returning id::text`,
    [playerId]
  );
  const walletId = wallet.rows[0].id;
  await pool.query(
    `insert into credit_wallet_service.wallet_scopes
       (wallet_id, tenant_id, brand_id, player_id, instrument_code, currency, authority, audit_metadata)
     values ($1, $2, $3, $4, 'CREDIT', 'USD', 'CREDIT_WALLET_SERVICE', '{"source":"qa"}')`,
    [walletId, tenantId, brandId, playerId]
  );
  return { tenantId, brandId, otherBrandId, playerId, walletId };
}

function reserveRequest(scope: Awaited<ReturnType<typeof seedScope>>, requestId = randomUUID()) {
  return {
    requestId,
    tenantId: scope.tenantId,
    brandId: scope.brandId,
    playerId: scope.playerId,
    walletId: scope.walletId,
    instrument: "CREDIT",
    operation: "RESERVE",
    money: { amount: 250, currency: "USD" },
    balanceImpact: null,
    authority: "CREDIT_WALLET_SERVICE",
    effectiveAt: "2026-01-01T00:00:00Z",
    ticketId: randomUUID(),
    reservationId: null,
    settlementId: null,
    settlementBatchId: null,
    settlementOutcome: null,
    originalOperationId: null,
    reasonCode: "QA_RESERVE",
    sourceService: "app",
    auditMetadata: { alpha: "one", beta: "two" },
  };
}

async function verifySecurityAndReadiness() {
  const unauthorized = await fetch(`${serviceUrl}/v1/credit-wallets/internal/instruments`);
  assert(unauthorized.status === 401, "Internal instrument catalog must reject missing service authentication.", { status: unauthorized.status });
  pass("internal authorization fails closed");

  const response = await fetch(`${serviceUrl}/v1/credit-wallets/internal/instruments`, {
    headers: { "x-internal-service-name": "app", authorization: `Bearer ${internalApiKey}` },
  });
  const body = await json(response);
  assert(response.ok && Array.isArray(body), "Instrument catalog should be available to an authorized service.", { status: response.status, body });
  assert(body.map((item: { instrument: string }) => item.instrument).sort().join(",") === "CASH,CREDIT,FREE_PLAY", "Initial instrument catalog must be exact.", { body });
  pass("wallet instrument catalog is durable and exact");

  const healthResponse = await fetch(`${serviceUrl}/v1/credit-wallets/health`);
  const health = await json(healthResponse);
  assert(healthResponse.ok, "Credit Wallet health must pass.", { health });
  const readiness = health?.canonicalOperations;
  assert(readiness && Object.entries(readiness).filter(([key]) => key.endsWith("Ready")).every(([, value]) => value === true), "Canonical readiness markers must pass.", { readiness });
  assert(readiness?.internalAuthorizationHookReady === true, "Internal authorization hook must be ready.", { readiness });
  assert(readiness?.disabledOperations?.includes("MANUAL_ADJUSTMENT"), "Manual adjustment must remain disabled.", { readiness });
  pass("canonical wallet readiness markers pass");
}

async function verifyCanonicalOperations(pool: Pool, scope: Awaited<ReturnType<typeof seedScope>>) {
  const idempotencyKey = `qa-wallet-canonical-${randomUUID()}`;
  const request = reserveRequest(scope);
  const first = await postOperation(request, idempotencyKey);
  assert(first.response.ok && first.body?.status === "COMMITTED" && first.body?.reused === false, "First canonical reserve must commit.", { first });

  const reordered = { ...request, auditMetadata: { beta: "two", alpha: "one" } };
  const duplicate = await postOperation(reordered, idempotencyKey);
  assert(duplicate.response.ok && duplicate.body?.reused === true, "Semantically identical duplicate must reuse the terminal result.", { duplicate });
  assert(duplicate.body?.operationId === first.body?.operationId && duplicate.body?.canonicalRequestHash === first.body?.canonicalRequestHash, "Duplicate must preserve operation identity and canonical hash.", { first: first.body, duplicate: duplicate.body });
  pass("canonical hashing and deterministic duplicate reuse");

  const conflict = await postOperation({ ...request, money: { amount: 251, currency: "USD" } }, idempotencyKey);
  assert(conflict.response.status === 409, "Conflicting idempotency payload must fail closed.", { status: conflict.response.status, body: conflict.body });
  const conflictAttempts = await pool.query<{ count: string }>(
    `select count(*)::text as count from credit_wallet_service.wallet_operation_attempts
     where operation_id = $1 and result = 'CONFLICT'`,
    [first.body.operationId]
  );
  assert(Number(conflictAttempts.rows[0].count) === 1, "Conflict evidence must be durable.");
  pass("conflicting payload rejected with durable evidence");

  const concurrentKey = `qa-wallet-concurrent-${randomUUID()}`;
  const concurrentRequest = reserveRequest(scope);
  const concurrent = await Promise.all([
    postOperation(concurrentRequest, concurrentKey),
    postOperation(concurrentRequest, concurrentKey),
  ]);
  assert(concurrent.every((result) => result.response.ok), "Concurrent identical requests must both resolve deterministically.", { concurrent });
  assert(new Set(concurrent.map((result) => result.body.operationId)).size === 1, "Concurrent duplicates must share one operation.", { concurrent });
  const concurrentRows = await pool.query<{ requests: string; terminals: string; reservations: string }>(
    `select
       (select count(*) from credit_wallet_service.wallet_operation_requests where idempotency_key = $1)::text as requests,
       (select count(*) from credit_wallet_service.wallet_operation_terminal_results t join credit_wallet_service.wallet_operation_requests r using (operation_id) where r.idempotency_key = $1)::text as terminals,
       (select count(*) from public.credit_reservations where idempotency_key like 'canonical-wallet:%')::text as reservations`,
    [concurrentKey]
  );
  assert(concurrentRows.rows[0].requests === "1" && concurrentRows.rows[0].terminals === "1", "Concurrent duplicates must create one request and terminal result.", { row: concurrentRows.rows[0] });
  pass("concurrent duplicate protection is atomic");

  const wrongScope = await postOperation({ ...reserveRequest(scope), brandId: scope.otherBrandId }, `qa-wallet-scope-${randomUUID()}`);
  assert(wrongScope.response.status === 400, "Cross-scope operation must fail closed.", { status: wrongScope.response.status, body: wrongScope.body });
  const wrongInstrument = await postOperation({ ...reserveRequest(scope), instrument: "CASH" }, `qa-wallet-instrument-${randomUUID()}`);
  assert(wrongInstrument.response.status === 400, "Instrument mismatch must fail closed.", { status: wrongInstrument.response.status, body: wrongInstrument.body });
  pass("tenant, brand, player, wallet, currency, and instrument scope is enforced");

  const failedKey = `qa-wallet-failure-${randomUUID()}`;
  const failed = await postOperation({ ...reserveRequest(scope), money: { amount: 999999999, currency: "USD" } }, failedKey);
  assert(failed.response.status === 400, "Rejected wallet mutation must fail closed.", { status: failed.response.status, body: failed.body });
  const failureEvidence = await pool.query<{ terminal_status: string; attempt_result: string }>(
    `select t.terminal_status, a.result as attempt_result
       from credit_wallet_service.wallet_operation_requests r
       join credit_wallet_service.wallet_operation_terminal_results t using (operation_id)
       join credit_wallet_service.wallet_operation_attempts a using (operation_id)
      where r.idempotency_key = $1`,
    [failedKey]
  );
  assert(failureEvidence.rows.some((row) => row.terminal_status === "FAILED" && row.attempt_result === "FAILED"), "Failure and terminal evidence must persist.", { rows: failureEvidence.rows });
  pass("operation failure and terminal evidence is durable");

  await expectDatabaseRejection(
    () => pool.query(`update credit_wallet_service.wallet_operation_requests set authority = 'TAMPERED' where operation_id = $1`, [first.body.operationId]),
    "operation request update blocked"
  );
  await expectDatabaseRejection(
    () => pool.query(`delete from credit_wallet_service.wallet_operation_attempts where operation_id = $1`, [first.body.operationId]),
    "operation attempt delete blocked"
  );
  await expectDatabaseRejection(
    () => pool.query(`update credit_wallet_service.wallet_operation_terminal_results set terminal_status = 'FAILED' where operation_id = $1`, [first.body.operationId]),
    "terminal result update blocked"
  );

  const constraints = await pool.query<{ name: string }>(
    `select conname as name from pg_constraint
      where conrelid = 'public.credit_reservations'::regclass
        and conname in ('credit_reservations_exposure_equation', 'credit_reservations_component_bounds')
      order by conname`
  );
  assert(constraints.rowCount === 2, "Credit reservation database invariants must be installed.", { constraints: constraints.rows });
  pass("database exposure and component invariants are installed");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required for canonical Credit Wallet QA.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await verifySecurityAndReadiness();
    const scope = await seedScope(pool);
    await verifyCanonicalOperations(pool, scope);
    console.log(JSON.stringify({ status: "PASS", checkCount: checks.length, checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
