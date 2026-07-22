import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { seedSettlementFixture } from "./lib/credit-wallet-settlement-fixture";

type Check = { name: string; status: "PASS" };
type Scope = {
  tenantId: string;
  brandId: string;
  otherBrandId: string;
  playerId: string;
  wallets: Record<"CREDIT" | "CASH" | "FREE_PLAY", string>;
};

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
async function readJson(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function post(body: Record<string, unknown>, key = `qa-wallet-lifecycle-${randomUUID()}`) {
  const serviceName = String(body.sourceService ?? "app");
  const response = await fetch(`${serviceUrl}/v1/credit-wallets/internal/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-internal-service-name": serviceName,
      authorization: `Bearer ${apiKey}`,
      "x-correlation-id": `qa-wallet-lifecycle-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await readJson(response), key };
}

async function seedScope(pool: Pool, creditLimit = 2000): Promise<Scope> {
  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const playerId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const hash = () => `sha256:${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `insert into platform.organizations(id, organization_code, name, status, version, content_hash)
     values ($1,$2,$3,'Active','1.0.0',$4)`,
    [organizationId, `qa-life-org-${suffix}`, `QA Life Org ${suffix}`, hash()]
  );
  await pool.query(
    `insert into platform.tenants(id, organization_id, tenant_code, name, status,
       default_language, default_currency, default_timezone, credit_enabled, cashier_enabled,
       version, content_hash)
     values ($1,$2,$3,$4,'Active','en','USD','UTC',true,false,'1.0.0',$5)`,
    [tenantId, organizationId, `qa-life-tenant-${suffix}`, `QA Life Tenant ${suffix}`, hash()]
  );
  for (const [id, code] of [[brandId, `qa-life-brand-${suffix}`], [otherBrandId, `qa-life-other-${suffix}`]]) {
    await pool.query(
      `insert into platform.brands(id, tenant_id, brand_code, name, display_name, status, version, content_hash)
       values ($1,$2,$3,$3,$3,'Active','1.0.0',$4)`,
      [id, tenantId, code, hash()]
    );
  }
  await pool.query(
    `insert into public.accounts(id, account_type, account_code, display_name, status)
     values ($1,'PLAYER',$2,$3,'ACTIVE')`,
    [playerId, `qa-life-player-${suffix}`, `QA Life Player ${suffix}`]
  );
  const wallets = {} as Scope["wallets"];
  for (const instrument of ["CREDIT", "CASH", "FREE_PLAY"] as const) {
    const result = await pool.query<{ id: string }>(
      `insert into public.financial_wallets(account_id, wallet_type, currency_code,
         balance_authority, status, balance, credit_limit, funding_model)
       values ($1,$2,'USD','INTERNAL','ACTIVE',$3,$4,$5) returning id::text`,
      [playerId, instrument, instrument === "CREDIT" ? 100 : 1500,
        instrument === "CREDIT" ? creditLimit : null,
        instrument === "CREDIT" ? "CREDIT" : "CASH"]
    );
    wallets[instrument] = result.rows[0].id;
    await pool.query(
      `insert into credit_wallet_service.wallet_scopes(
         wallet_id, tenant_id, brand_id, player_id, instrument_code, currency, authority)
       values ($1,$2,$3,$4,$5,'USD','CREDIT_WALLET_SERVICE')`,
      [wallets[instrument], tenantId, brandId, playerId, instrument]
    );
  }
  return { tenantId, brandId, otherBrandId, playerId, wallets };
}

function request(scope: Scope, instrument: keyof Scope["wallets"], operation: string, amount: number) {
  return {
    requestId: randomUUID(), tenantId: scope.tenantId, brandId: scope.brandId,
    playerId: scope.playerId, walletId: scope.wallets[instrument], instrument, operation,
    money: { amount, currency: "USD" }, balanceImpact: null,
    authority: "SETTLEMENT_AUTHORITY", effectiveAt: "2026-07-01T00:00:00Z",
    ticketId: randomUUID(), reservationId: null, settlementId: null,
    settlementBatchId: null, settlementInstructionId: null,
    settlementInstructionSequence: null, settlementOutcome: null,
    originalOperationId: null, reasonCode: null, sourceService: "app",
    auditMetadata: { qa: "credit-wallet-reservation-lifecycle" },
  };
}

async function reserve(scope: Scope, instrument: keyof Scope["wallets"], amount: number) {
  const body = request(scope, instrument, "RESERVE", amount);
  const result = await post(body);
  assert(result.response.ok && result.body?.status === "COMMITTED", "Reserve must commit.", { instrument, result });
  return { body, result, reservationId: result.body.effectReferenceId as string };
}

async function reservation(pool: Pool, id: string) {
  const result = await pool.query<{
    status: string; reserved_amount: string; released_amount: string;
    captured_amount: string; remaining_exposure: string;
  }>(`select status, reserved_amount::text, released_amount::text,
      captured_amount::text, remaining_exposure::text
      from public.credit_reservations where id=$1`, [id]);
  assert(result.rowCount === 1, "Reservation projection must exist.", { id });
  return result.rows[0];
}

function releaseBody(base: Record<string, unknown>, reservationId: string, amount: number) {
  return { ...base, requestId: randomUUID(), operation: "RELEASE", reservationId,
    money: { amount, currency: "USD" }, reasonCode: "QA_RELEASE" };
}
function cancelBody(base: Record<string, unknown>, reservationId: string, amount: number) {
  return { ...base, requestId: randomUUID(), operation: "CANCEL", reservationId,
    money: { amount, currency: "USD" }, reasonCode: "QA_CANCEL" };
}
async function captureBody(pool: Pool, base: Record<string, unknown>, reservationId: string,
  amount: number, impact = 0) {
  const fixture = await seedSettlementFixture(pool, {
    reservationId,
    ticketId: String(base.ticketId),
    amountMinor: amount,
    balanceImpactMinor: impact,
  });
  return { ...base, requestId: randomUUID(), operation: "SETTLE", reservationId,
    money: { amount, currency: "USD" }, balanceImpact: { amount: impact, currency: "USD" },
    authority: "settlement-service", sourceService: "settlement-service",
    settlementId: fixture.settlementId, settlementBatchId: randomUUID(),
    settlementInstructionId: fixture.creditInstructionId, settlementInstructionSequence: 2,
    settlementInstructionHash: fixture.creditInstructionHash,
    settlementVersion: fixture.settlementVersion, settlementHash: fixture.settlementHash,
    ledgerInstructionId: fixture.ledgerInstructionId, ledgerPostingRequired: false,
    settlementOutcome: "WIN", reasonCode: "QA_CAPTURE" };
}

async function verifyLifecycle(pool: Pool, scope: Scope) {
  const partial = await reserve(scope, "CREDIT", 500);
  let result = await post(releaseBody(partial.body, partial.reservationId, 100));
  assert(result.response.ok, "Partial release must succeed.", { result });
  let row = await reservation(pool, partial.reservationId);
  assert(row.status === "PARTIALLY_RELEASED" && row.remaining_exposure === "400", "Partial release transition is invalid.", { row });
  result = await post(await captureBody(pool, partial.body, partial.reservationId, 150, 25));
  assert(result.response.ok, "Capture after release must succeed.", { result });
  row = await reservation(pool, partial.reservationId);
  assert(row.status === "PARTIALLY_CAPTURED" && row.captured_amount === "150" && row.remaining_exposure === "250", "Partial capture transition is invalid.", { row });
  result = await post(releaseBody(partial.body, partial.reservationId, 250));
  assert(result.response.ok, "Release after capture must succeed.", { result });
  row = await reservation(pool, partial.reservationId);
  assert(row.status === "RELEASED" && Number(row.released_amount) + Number(row.captured_amount) === 500 && row.remaining_exposure === "0", "Full release completion invariant failed.", { row });
  pass("partial/full release and capture transitions");

  const captured = await reserve(scope, "CREDIT", 300);
  const capture = await captureBody(pool, captured.body, captured.reservationId, 300, 0);
  const captureKey = `qa-capture-${randomUUID()}`;
  result = await post(capture, captureKey);
  assert(result.response.ok, "Full zero-impact capture must succeed.", { result });
  const sameKey = await post(capture, captureKey);
  assert(sameKey.response.ok && sameKey.body?.reused === true, "Same-key capture must reuse result.", { sameKey });
  const otherKey = await post({ ...capture, requestId: randomUUID() });
  assert(otherKey.response.ok && otherKey.body?.effectReferenceId === result.body?.effectReferenceId,
    "Same authoritative instruction under another key must not apply twice.", { otherKey, result });
  const conflict = await post({ ...capture, requestId: randomUUID(), money: { amount: 299, currency: "USD" } });
  assert([400, 409].includes(conflict.response.status), "Conflicting authoritative instruction must fail closed.", { conflict });
  row = await reservation(pool, captured.reservationId);
  assert(row.status === "CAPTURED" && row.captured_amount === "300" && row.remaining_exposure === "0", "Full capture terminal state failed.", { row });
  const terminalRelease = await post(releaseBody(captured.body, captured.reservationId, 1));
  assert(terminalRelease.response.status === 400, "Terminal reservation mutation must fail.", { terminalRelease });
  pass("full capture, duplicate settlement protection, and terminal enforcement");

  const cancelled = await reserve(scope, "CREDIT", 200);
  result = await post(cancelBody(cancelled.body, cancelled.reservationId, 200));
  assert(result.response.ok, "Cancellation must succeed.", { result });
  row = await reservation(pool, cancelled.reservationId);
  assert(row.status === "CANCELLED" && row.released_amount === "200" && row.remaining_exposure === "0", "Cancellation projection failed.", { row });
  const repeated = await post(cancelBody(cancelled.body, cancelled.reservationId, 200));
  assert(repeated.response.status === 400, "Repeated cancellation with a new identity must be rejected.", { repeated });
  const cancellationEvidence = await pool.query(`select 1 from credit_wallet_service.wallet_reservation_cancellations where reservation_id=$1`, [cancelled.reservationId]);
  assert(cancellationEvidence.rowCount === 1, "Cancellation evidence must be append-only and durable.");
  pass("canonical cancellation and repeated-cancellation rejection");
}

async function verifyInstrumentsAndExposure(pool: Pool, scope: Scope) {
  const cash = await reserve(scope, "CASH", 200);
  const freePlay = await reserve(scope, "FREE_PLAY", 300);
  assert((await reservation(pool, cash.reservationId)).remaining_exposure === "200", "CASH exposure missing.");
  assert((await reservation(pool, freePlay.reservationId)).remaining_exposure === "300", "FREE_PLAY exposure missing.");
  const response = await fetch(`${serviceUrl}/v1/credit-wallets/internal/exposure/${scope.playerId}`, {
    headers: { "x-internal-service-name": "app", authorization: `Bearer ${apiKey}` },
  });
  const exposure = await readJson(response);
  assert(response.ok && exposure?.byInstrument?.length === 3, "Exposure must group all instruments.", { exposure });
  const byInstrument = Object.fromEntries(exposure.byInstrument.map((line: { instrument: string; remainingExposure: number }) => [line.instrument, line.remainingExposure]));
  assert(byInstrument.CASH === 200 && byInstrument.FREE_PLAY === 300, "Instrument exposure totals are incorrect.", { byInstrument });
  pass("CREDIT, CASH, and FREE_PLAY authoritative exposure");

  const unsupported = await fetch(`${serviceUrl}/v1/credit-wallets/${scope.playerId}/exposure?marketId=${randomUUID()}`);
  assert(unsupported.status === 400, "Ignored market/draw filters must be rejected.", { status: unsupported.status });
  pass("unsupported exposure filters fail explicitly");
}

async function verifyScopeStatusConcurrency(pool: Pool, scope: Scope) {
  const mismatch = request(scope, "CREDIT", "RESERVE", 10);
  const crossBrand = await post({ ...mismatch, brandId: scope.otherBrandId });
  assert(crossBrand.response.status === 400, "Cross-brand operation must fail.", { crossBrand });
  const currency = await post({ ...mismatch, money: { amount: 10, currency: "EUR" } });
  assert(currency.response.status === 400, "Currency mismatch must fail.", { currency });
  const instrument = await post({ ...mismatch, instrument: "CASH" });
  assert(instrument.response.status === 400, "Instrument mismatch must fail.", { instrument });
  pass("scope, instrument, and currency enforcement");

  await pool.query(`update public.financial_wallets set status='SUSPENDED' where id=$1`, [scope.wallets.CASH]);
  const suspendedReserve = await post(request(scope, "CASH", "RESERVE", 10));
  assert(suspendedReserve.response.status === 400, "SUSPENDED wallet must block reserve.", { suspendedReserve });
  await pool.query(`update public.financial_wallets set status='ACTIVE' where id=$1`, [scope.wallets.CASH]);
  const releasable = await reserve(scope, "CASH", 50);
  await pool.query(`update public.financial_wallets set status='CLOSED' where id=$1`, [scope.wallets.CASH]);
  const closedReserve = await post(request(scope, "CASH", "RESERVE", 10));
  assert(closedReserve.response.status === 400, "CLOSED wallet must block reserve.", { closedReserve });
  const closedRelease = await post(releaseBody(releasable.body, releasable.reservationId, 50));
  assert(closedRelease.response.ok, "CLOSED wallet must permit exposure-reducing release.", { closedRelease });
  pass("ACTIVE, SUSPENDED, and CLOSED wallet status enforcement");

  const contention = await seedScope(pool, 1000);
  const one = request(contention, "CREDIT", "RESERVE", 700);
  const two = request(contention, "CREDIT", "RESERVE", 700);
  const concurrent = await Promise.all([post(one), post(two)]);
  assert(concurrent.filter((item) => item.response.ok).length === 1 && concurrent.filter((item) => item.response.status === 400).length === 1,
    "Concurrent reserves must not over-reserve the wallet.", { statuses: concurrent.map((item) => item.response.status) });
  pass("concurrent wallet locking prevents over-reservation");
}

async function verifyGuardsAndLegacyAdapter(pool: Pool, scope: Scope) {
  const guarded = await reserve(scope, "CREDIT", 75);
  try {
    await pool.query(`update public.credit_reservations set remaining_exposure=1 where id=$1`, [guarded.reservationId]);
    fail("Direct canonical projection update must fail.");
  } catch { pass("canonical projection update bypass blocked"); }
  try {
    await pool.query(`delete from credit_wallet_service.wallet_reservation_cancellations`);
    fail("Cancellation evidence delete must fail.");
  } catch { pass("append-only cancellation evidence enforced"); }
  const legacy = await pool.query<{ id: string }>(
    `select id::text from public.reserve_credit_exposure($1,$2,25,'USD',$3,'qa-legacy','{}'::jsonb)`,
    [scope.playerId, randomUUID(), `qa-legacy-${randomUUID()}`]
  );
  const cancelled = await pool.query<{ status: string }>(
    `select status from public.cancel_credit_reservation($1,'qa-legacy','QA_LEGACY')`, [legacy.rows[0].id]
  );
  assert(cancelled.rows[0].status === "CANCELLED", "Legacy cancellation adapter must remain isolated and functional.");
  try {
    await pool.query(`select * from public.cancel_credit_reservation($1,'qa-bypass','QA_BYPASS')`, [guarded.reservationId]);
    fail("Legacy cancellation must not mutate canonical reservations.");
  } catch { pass("legacy cancellation cannot bypass canonical authority"); }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const scope = await seedScope(pool);
    await verifyLifecycle(pool, scope);
    await verifyInstrumentsAndExposure(pool, scope);
    await verifyScopeStatusConcurrency(pool, scope);
    await verifyGuardsAndLegacyAdapter(pool, scope);
    const health = await fetch(`${serviceUrl}/v1/credit-wallets/health`).then(readJson);
    assert(health?.canonicalOperations?.reservationLifecycle?.productionReady === false,
      "Production readiness must remain false.", { health });
    assert(health?.canonicalOperations?.reservationLifecycle?.expiryDecision === "NOT_REQUIRED_FOR_CURRENT_CREDIT_ONLY_LAUNCH",
      "Expiry decision must be explicit.", { health });
    pass("readiness and launch expiry decision are explicit");
    console.log(JSON.stringify({ status: "PASS", checkCount: checks.length, checks }, null, 2));
  } finally { await pool.end(); }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
