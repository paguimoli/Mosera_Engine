import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const runId = randomUUID();
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const checks = [];
const services = new Set();
const originalActiveVersions = new Map();

function hash(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function check(name, condition, evidence = {}) {
  if (!condition) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  checks.push({ name, status: "PASS", evidence });
}

function command(name, args, environment = {}) {
  const result = spawnSync(name, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitFor(name, probe, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) {
        check(name, true, last);
        return last;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

async function loadScope() {
  const result = await pool.query(`
select platform.id platform_id,organization.id organization_id,
  tenant.id tenant_id,brand.id brand_id,market.id market_id,market.currency
from platform.markets market
join platform.brands brand on brand.id=market.brand_id and brand.status='Active'
join platform.tenants tenant on tenant.id=brand.tenant_id and tenant.status='Active'
join platform.organizations organization on organization.id=tenant.organization_id and organization.status='Active'
join platform.platforms platform on platform.id=organization.platform_id and platform.status='Active'
where market.status='Active'
order by market.created_at,market.id limit 1;
`);
  if (!result.rows[0]) throw new Error("An active canonical Platform hierarchy is required.");
  return result.rows[0];
}

async function loadProduct(code) {
  const result = await pool.query(`
select definition.id product_id,definition.active_version_id,definition.code,
  version.id product_version_id,version.version_number,version.definition_hash,
  version.game_manifest_id,version.game_manifest_hash,
  version.math_model_definition_id,version.math_model_hash,
  version.paytable_definition_id,version.paytable_version,version.paytable_hash,
  version.evaluator_version,version.outcome_provider_id,version.outcome_provider_version,
  version.provider_configuration_version,version.schedule_version_id,
  schedule.draw_authority_assignment_id,schedule.schedule_hash,
  assignment.draw_authority_version_id,module.code engine_name,
  module_version.version engine_version
from game_engine.game_definitions definition
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
join game_engine.published_draw_schedule_versions schedule on schedule.schedule_version_id=version.schedule_version_id
join game_engine.draw_authority_assignments assignment on assignment.id=schedule.draw_authority_assignment_id
join game_engine.game_modules module on module.id=definition.game_module_id
join game_engine.game_module_versions module_version
  on module_version.game_module_id=module.id
 and module_version.version=version.product_configuration->>'engineVersion'
where definition.code=$1 and version.publication_state='PUBLISHED'
  and version.activation_state='INACTIVE' and version.assignment_state='UNASSIGNED'
order by version.version_number desc limit 1;
`, [code]);
  if (!result.rows[0]) throw new Error(`${code} immutable pilot product was not found.`);
  return result.rows[0];
}

async function activateQualificationProvider() {
  const latest = (await pool.query(`
select stage from game_engine.game_engine_production_activation_events
where provider_id='mosera-internal-csprng' and provider_version='2.0.0'
  and configuration_version='2'
order by created_at desc,activation_event_id desc limit 1;
`)).rows[0]?.stage;
  const stages = ["REGISTERED", "READY", "APPROVED", "PRODUCTION_ACTIVE"];
  if (latest === "PRODUCTION_ACTIVE") return;
  const start = latest ? stages.indexOf(latest) + 1 : 0;
  if (latest && start === 0) throw new Error(`Unsupported provider activation stage ${latest}.`);
  for (const stage of stages.slice(start)) {
    await pool.query(`
insert into game_engine.game_engine_production_activation_events (
  activation_event_id,provider_id,provider_version,configuration_version,stage,
  actor_reference,reason_code,approval_reference,signing_provider_id,
  signing_provider_version,signing_key_version,canonical_request_hash,
  evidence_hash,idempotency_key,created_at)
values ($1,'mosera-internal-csprng','2.0.0','2',$2,'qa:pr04a',
  'PR04A_QUALIFICATION_ONLY','qa:pr04a-approved','mosera-software-signing',
  '1.0.0','key-v1',$3,$4,$5,clock_timestamp());
`, [randomUUID(), stage, hash(`activation:${runId}:${stage}`),
      hash(`activation-evidence:${runId}:${stage}`), `pr04a:${runId}:${stage}`]);
  }
}

async function resetQualificationProviderActivation() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(`
delete from game_engine.game_engine_production_activation_events
where provider_id='mosera-internal-csprng'
  and provider_version='2.0.0'
  and configuration_version='2'
  and reason_code='PR04A_QUALIFICATION_ONLY';
`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createAccounts(scope, count) {
  const ids = { super: randomUUID(), master: randomUUID(), agent: randomUUID(), players: [] };
  const insertAccount = async (id, type, parent = null) => pool.query(`
insert into public.accounts (
  id,account_type,account_code,display_name,parent_account_id,
  canonical_tenant_id,canonical_brand_id,canonical_market_id,status,
  governance_managed,idempotency_key,canonical_request_hash)
values ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',true,$9,$10);
`, [id, type, `pr04a-${runId.slice(0, 8)}-${type.toLowerCase()}-${id.slice(0, 4)}`,
      `PR-04A ${type}`, parent, scope.tenant_id, scope.brand_id, scope.market_id,
      `pr04a-account:${id}`, hash(`account:${id}`)]);
  await insertAccount(ids.super, "SUPER_MASTER");
  await insertAccount(ids.master, "MASTER_AGENT", ids.super);
  await insertAccount(ids.agent, "AGENT", ids.master);
  for (let index = 0; index < count; index += 1) {
    const player = { accountId: randomUUID(), profileId: randomUUID(), walletId: randomUUID() };
    await insertAccount(player.accountId, "PLAYER", ids.agent);
    await pool.query(`
insert into public.player_profiles(id,account_id,display_name,status)
values ($1,$2,$3,'ACTIVE');
`, [player.profileId, player.accountId, `PR-04A Player ${index + 1}`]);
    await pool.query(`
insert into public.financial_wallets(
  id,account_id,wallet_type,currency_code,balance_authority,status,balance,credit_limit,funding_model)
values ($1,$2,'CREDIT',$3,'INTERNAL','ACTIVE',0,5000000000,'CREDIT');
`, [player.walletId, player.accountId, scope.currency]);
    await pool.query(`
insert into credit_wallet_service.wallet_scopes(
  wallet_id,tenant_id,brand_id,player_id,instrument_code,currency,authority)
values ($1,$2,$3,$4,'CREDIT',$5,'CREDIT_WALLET_SERVICE');
`, [player.walletId, scope.tenant_id, scope.brand_id, player.accountId, scope.currency]);
    ids.players.push(player);
  }
  return ids;
}

async function enableProductForQualification(product) {
  originalActiveVersions.set(product.product_id, product.active_version_id);
  await pool.query("update game_engine.game_definitions set active_version_id=$2 where id=$1", [
    product.product_id, product.product_version_id,
  ]);
}

async function createAvailability(scope, product) {
  const id = randomUUID();
  await pool.query(`
insert into platform.game_availability(
  id,tenant_id,brand_id,market_id,game_id,game_code,game_manifest_reference,
  status,effective_from,version,content_hash,audit_metadata,lifecycle_reason,lifecycle_operator)
values ($1,$2,$3,$4,$5,$6,$7,'Active',clock_timestamp()-interval '1 second',$8,$9,$10::jsonb,
  'PR04A_QUALIFICATION_ONLY','qa:pr04a');
`, [id, scope.tenant_id, scope.brand_id, scope.market_id, product.product_id,
      product.code.toLowerCase(), product.game_manifest_id,
      `pr04a-${runId}`, hash(`availability:${product.code}:${runId}`),
      JSON.stringify({ runId, qualificationOnly: true })]);
  return id;
}

async function createDraw(product, { target = true, sequenceOffset = 0, targetDelaySeconds = 30 } = {}) {
  const drawId = randomUUID();
  const executionManifestId = randomUUID();
  const publicDrawNumber = Number((await pool.query(`
select coalesce(max(public_draw_number),0)::bigint + 1 value
from game_engine.durable_scheduler_draws where product_code=$1;
`, [product.code])).rows[0].value) + sequenceOffset;
  const now = Date.now();
  const scheduledAt = target
    ? new Date(now + targetDelaySeconds * 1_000)
    : new Date(now + (targetDelaySeconds + 1 + sequenceOffset) * 1_000);
  const salesOpenAt = new Date(now - 120_000);
  const cutoffAt = target ? new Date(now + 25_000) : new Date(scheduledAt.getTime() - 5_000);
  const drawHash = hash(`draw:${drawId}`);
  const manifestHash = hash(`execution:${drawId}:${product.product_version_id}:${scheduledAt.toISOString()}`);
  const state = "Accepting";
  await pool.query(`
insert into game_engine.draw_schedules(
  id,game_definition_id,draw_authority_assignment_id,sales_open_at,sales_close_at,
  draw_at,status,schedule_version_id,scheduled_execution_at,schedule_hash,draw_identity_hash)
values ($1,$2,$3,$4,$5,$6,'SalesOpen',$7,$6,$8,$9);
`, [drawId, product.product_id, product.draw_authority_assignment_id, salesOpenAt,
      cutoffAt, scheduledAt, product.schedule_version_id, product.schedule_hash, drawHash]);
  await pool.query(`
insert into game_engine.draw_execution_manifests(
  execution_manifest_id,draw_id,schedule_version_id,game_definition_version_id,
  draw_authority_version_id,engine_name,engine_version,outcome_provider_id,
  outcome_provider_version,provider_configuration_version,evaluator_version,
  paytable_version,scheduled_execution_at,schedule_hash,draw_identity_hash,
  canonical_manifest_hash,created_at)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,clock_timestamp());
`, [executionManifestId, drawId, product.schedule_version_id, product.product_version_id,
      product.draw_authority_version_id, product.engine_name, product.engine_version,
      product.outcome_provider_id, product.outcome_provider_version,
      product.provider_configuration_version, product.evaluator_version,
      product.paytable_version, scheduledAt, product.schedule_hash, drawHash, manifestHash]);
  await pool.query(`
insert into game_engine.durable_scheduler_draws(
  draw_id,product_id,product_version_id,product_code,schedule_version_id,
  public_draw_number,sales_open_at,cutoff_at,scheduled_execution_at,
  draw_identity_hash,scheduler_state,recovery_deadline_at,materialized_at)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '30 minutes',clock_timestamp());
`, [drawId, product.product_id, product.product_version_id, product.code,
      product.schedule_version_id, publicDrawNumber, salesOpenAt, cutoffAt,
      scheduledAt, drawHash, state]);
  return { drawId, executionManifestId, manifestHash, publicDrawNumber, scheduledAt };
}

async function insertLiability(scope, accounts, product, draw, players, wagerTypes) {
  const scopes = [
    ["TENANT", scope.tenant_id], ["MASTER_AGENT", accounts.master], ["AGENT", accounts.agent],
    ["DRAW", draw.drawId], ["PRODUCT", product.product_id], ["GAME", product.code.toLowerCase()],
    ...players.map((player) => ["PLAYER", player.accountId]),
    ...wagerTypes.map((wagerType) => ["WAGER_TYPE", wagerType.toLowerCase()]),
  ];
  for (const [scopeType, scopeReference] of scopes) {
    const previous = (await pool.query(`
select configuration_id,version from ticket_authority.liability_limit_configurations
where tenant_id=$1 and brand_id=$2 and scope_type=$3 and scope_reference=$4
order by version desc limit 1;
`, [scope.tenant_id, scope.brand_id, scopeType, String(scopeReference).toLowerCase()])).rows[0];
    const version = Number(previous?.version ?? 0) + 1;
    await pool.query(`
insert into ticket_authority.liability_limit_configurations(
  configuration_id,tenant_id,brand_id,scope_type,scope_reference,
  maximum_wager_minor,maximum_theoretical_payout_minor,maximum_exposure_minor,
  status,effective_from,version,supersedes_configuration_id,content_hash,audit_metadata)
values ($1,$2,$3,$4,$5,5000000000,500000000000,500000000000,'Active',
  clock_timestamp()-interval '1 millisecond',$6,$7,$8,$9::jsonb);
`, [randomUUID(), scope.tenant_id, scope.brand_id, scopeType,
        String(scopeReference).toLowerCase(), version, previous?.configuration_id ?? null,
        hash(`liability:${runId}:${scopeType}:${scopeReference}:${version}`),
        JSON.stringify({ runId, authority: "TicketLiabilityAuthority" })]);
  }
}

async function acceptTicket(product, draw, player, scope, items, label, paytableId = product.paytable_definition_id) {
  const result = (await pool.query(`
select ticket_authority.accept_ticket(
  $1,$2,'CREDIT',$3,$4,$5,$6,$7,null,$8,$9,$10::jsonb,$11,$12,$13,$14,$15
) result;
`, [player.accountId, player.profileId, player.walletId, product.product_id,
      product.game_manifest_id, paytableId, draw.drawId, `pr04a-${label}`,
      scope.currency, JSON.stringify(items), `pr04a-ticket:${runId}:${label}`,
      `pr04a:${runId}:${label}`, `draw:${draw.drawId}`, "qa:pr04a", "QA"])).rows[0].result;
  if (!result.accepted) throw new Error(`Ticket ${label} was not accepted: ${JSON.stringify(result)}`);
  const ticket = (await pool.query(`
select ticket.*,wallet.balance::text initial_balance
from ticket_authority.tickets ticket
join public.financial_wallets wallet on wallet.id=ticket.wallet_id
where ticket.ticket_id=$1;
`, [result.ticketId])).rows[0];
  return { ...result, ...ticket, label };
}

function fastItems() {
  return [
    ["KenoBigSmall", "BIG", 1000], ["KenoBigSmall", "SMALL", 1300],
    ["KenoOddEven", "ODD", 1700], ["KenoOddEven", "EVEN", 2100],
    ["KenoDragonTiger", "DRAGON", 900], ["KenoDragonTiger", "TIGER", 1100],
    ["KenoUpDown", "UP", 1500], ["KenoUpDown", "DOWN", 1900],
    ["KenoParlay", "BIG_ODD", 2300], ["KenoElement", "WATER", 2700],
  ].map(([wagerType, selection, stakeMinor]) => ({
    wagerType, wagerVersion: "1.0.0", selections: { numbers: [1], selection }, stakeMinor,
  }));
}

function fastCapItems() {
  return Array.from({ length: 16 }, (_, index) => ({
    wagerType: "KenoBigSmall",
    wagerVersion: "1.0.0",
    selections: { numbers: [1], selection: index < 8 ? "BIG" : "SMALL" },
    stakeMinor: 72000,
  }));
}

function hotSpotCoverageItems(offset, bullseyePurchased = false) {
  return Array.from({ length: 10 }, (_, index) => ({
    wagerType: "KenoSpot",
    wagerVersion: "1.0.0",
    selections: { numbers: [offset + index + 1], bullseyePurchased },
    stakeMinor: 100,
  }));
}

function runHotSpotHarness(args) {
  const stdout = command("dotnet", [
    "run", "--no-build", "--project",
    "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
    "--", "pr04a-hot-spot-evidence", ...args,
  ], { DATABASE_URL: databaseUrl });
  const line = stdout.split("\n").filter(Boolean).at(-1);
  return JSON.parse(line);
}

async function makeDrawDue(draw) {
  const waitMs = draw.scheduledAt.getTime() - Date.now() + 100;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  await pool.query("update game_engine.draw_schedules set status='AwaitingResult' where id=$1", [draw.drawId]);
  await pool.query(
    "update game_engine.durable_scheduler_draws set scheduler_state='ExecutionDue' where draw_id=$1",
    [draw.drawId],
  );
}

async function startService(port, publicKeyPem, privateKeyPem, failureStage = "", pageSize = 100) {
  mkdirSync(".qa/pr-04a", { recursive: true });
  const log = createWriteStream(`.qa/pr-04a/game-engine-${runId}-${port}-${failureStage || "normal"}.log`, { flags: "a" });
  const service = spawn("dotnet", [
    "run", "--no-build", "--no-launch-profile", "--project",
    "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
      DEPLOYMENT_ENVIRONMENT: "local",
      OUTCOME_CANONICAL_PIPELINE_ENABLED: "true",
      OUTCOME_LEGACY_PUBLICATION_ENABLED: "false",
      GAME_ENGINE_PRODUCTION_ACTIVATION_ENABLED: "true",
      GAME_ENGINE_PRODUCTION_SIGNING_ENABLED: "true",
      GAME_ENGINE_SIGNING_PROVIDER_ID: "mosera-software-signing",
      GAME_ENGINE_SIGNING_PROVIDER_VERSION: "1.0.0",
      GAME_ENGINE_SIGNING_KEY_VERSION: "key-v1",
      GAME_ENGINE_SIGNING_PUBLIC_KEY_PEM: publicKeyPem,
      GAME_ENGINE_DURABLE_SCHEDULER_ENABLED: "true",
      GAME_ENGINE_DURABLE_SCHEDULER_PRODUCTION_EXECUTION_ENABLED: "true",
      GAME_ENGINE_SCHEDULER_POLL_INTERVAL_MS: "250",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_ENABLED: "true",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_QUALIFICATION_MODE: "true",
      GAME_ENGINE_QUALIFICATION_SIGNING_PRIVATE_KEY_PEM: privateKeyPem,
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_PAGE_SIZE: String(pageSize),
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_CONCURRENCY: "4",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_FAILURE_STAGE: failureStage,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  services.add(service);
  service.stdout.pipe(log);
  service.stderr.pipe(log);
  await waitFor(`Game Engine ${port}/${failureStage || "normal"} starts`, async () => {
    if (service.exitCode !== null) throw new Error(`Game Engine exited with ${service.exitCode}`);
    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    return response.ok ? { port, failureStage, status: response.status } : null;
  }, 60_000);
  return service;
}

async function stopService(service) {
  if (!service || service.exitCode !== null) {
    services.delete(service);
    return;
  }
  service.kill("SIGTERM");
  await Promise.race([once(service, "exit"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (service.exitCode === null) service.kill("SIGKILL");
  services.delete(service);
}

async function waitForRecovery(draw, minimumAttempt, predicate = () => true) {
  return waitFor(`draw ${draw.drawId} records recoverable attempt ${minimumAttempt}`, async () => {
    const row = (await pool.query(`
select runtime.scheduler_state,
  (select count(*)::int from game_engine.durable_scheduler_execution_attempts attempt
    where attempt.draw_id=runtime.draw_id and attempt.attempt_status='RECOVERY_REQUIRED') recoveries,
  (select count(*)::int from game_engine.outcome_events event
    where event.execution_manifest_id=$2) certificates,
  (select count(*)::int from game_engine.math_evaluation_events evaluation
    where evaluation.idempotency_key like 'scheduler-math:%') all_math,
  (select count(*)::int from game_engine.settlement_input_records input
    join game_engine.outcome_certificates certificate
      on certificate.certificate_id=input.outcome_certificate_id
    where certificate.draw_id=$1) inputs,
  (select count(*)::int from game_engine.outcome_settlement_requests request
    where request.draw_id=$1) requests
from game_engine.durable_scheduler_draws runtime where runtime.draw_id=$1;
`, [draw.drawId, draw.executionManifestId])).rows[0];
    return row?.scheduler_state === "RecoveryRequired" && row.recoveries >= minimumAttempt && predicate(row) ? row : null;
  });
}

async function waitForFinancialCompletion(draw, tickets, expectedItems) {
  return waitFor(`draw ${draw.drawId} reaches canonical financial completion`, async () => {
    const row = (await pool.query(`
with outcome as (
  select outcome_version_id from game_engine.canonical_outcome_versions where draw_id=$1
), ticket_set as (
  select unnest($2::uuid[]) ticket_id
), item_set as (
  select item.ticket_item_id,item.ticket_id from ticket_authority.ticket_items item
  join ticket_set selected on selected.ticket_id=item.ticket_id
), requests as (
  select request.* from game_engine.outcome_settlement_requests request
  join outcome on outcome.outcome_version_id=request.outcome_version_id
), settlements as (
  select record.* from settlement_service.authoritative_settlement_records record
  join requests on requests.settlement_request_id=record.settlement_request_id
)
select
  (select count(*)::int from item_set) items,
  (select count(*)::int from game_engine.math_evaluation_events evaluation
    join item_set on evaluation.ticket_reference=item_set.ticket_item_id::text) evaluations,
  (select count(*)::int from game_engine.settlement_input_records input
    join item_set on input.ticket_reference=item_set.ticket_item_id::text) inputs,
  (select count(*)::int from requests) requests,
  (select count(*)::int from settlements) settlements,
  (select count(*)::int from game_engine.outcome_settlement_acknowledgements acknowledgement
    join requests on requests.settlement_request_id=acknowledgement.settlement_request_id) acknowledgements,
  (select count(*)::int from game_engine.canonical_draw_completion_evidence completion
    join requests on requests.settlement_request_id=completion.settlement_request_id) draw_completions,
  (select count(*)::int from ticket_completion_authority.completion_sources source
    join item_set on item_set.ticket_item_id=source.ticket_item_id) completion_sources,
  (select count(*)::int from ticket_completion_authority.completion_evidence completion
    join ticket_set on ticket_set.ticket_id=completion.ticket_id) ticket_completions,
  (select count(*)::int from ticket_authority.tickets ticket
    join ticket_set on ticket_set.ticket_id=ticket.ticket_id
    where ticket.status='SETTLED' and ticket.lifecycle_state='REBATE_ELIGIBLE') settled_tickets,
  (select count(*)::int from settlement_service.financial_instruction_execution_attempts attempt
    join settlements on settlements.settlement_id=attempt.settlement_id
    where attempt.status in ('Posted','Skipped','Reused')) financial_attempts
;
`, [draw.drawId, tickets.map((ticket) => ticket.ticket_id)])).rows[0];
    const complete = row?.items === expectedItems && row.evaluations === expectedItems &&
      row.inputs === expectedItems && row.requests === expectedItems &&
      row.settlements === expectedItems && row.acknowledgements === expectedItems &&
      row.draw_completions === expectedItems && row.completion_sources === expectedItems &&
      row.ticket_completions === tickets.length && row.settled_tickets === tickets.length &&
      row.financial_attempts >= expectedItems * 2;
    return complete ? row : null;
  }, 300_000);
}

async function verifyNoDuplicates(draw, tickets, expectedItems) {
  const evidence = (await pool.query(`
with outcome as (
  select outcome_version_id from game_engine.canonical_outcome_versions where draw_id=$1
), ticket_set as (select unnest($2::uuid[]) ticket_id),
item_set as (
  select item.ticket_item_id,item.ticket_id from ticket_authority.ticket_items item
  join ticket_set selected on selected.ticket_id=item.ticket_id
), requests as (
  select request.* from game_engine.outcome_settlement_requests request
  join outcome on outcome.outcome_version_id=request.outcome_version_id
), settlements as (
  select record.* from settlement_service.authoritative_settlement_records record
  join requests on requests.settlement_request_id=record.settlement_request_id
)
select
  (select count(*)::int from game_engine.outcome_events event
    join game_engine.draw_execution_manifests manifest on manifest.execution_manifest_id=event.execution_manifest_id
    where manifest.draw_id=$1) outcome_events,
  (select count(*)::int from game_engine.canonical_outcome_versions where draw_id=$1) outcome_versions,
  (select count(*)::int from requests) requests,
  (select count(*)::int from settlements) settlements,
  (select count(*)::int from ticket_completion_authority.completion_sources source
    join item_set on item_set.ticket_item_id=source.ticket_item_id) sources,
  (select count(*)::int from ticket_completion_authority.completion_evidence completion
    join ticket_set on ticket_set.ticket_id=completion.ticket_id) completions,
  (select count(*)::int from (
    select settlement_request_id from settlements group by settlement_request_id having count(*)>1) duplicate) duplicate_settlements,
  (select count(*)::int from (
    select ticket_item_id from ticket_completion_authority.completion_sources source
    join item_set using(ticket_item_id) group by ticket_item_id having count(*)>1) duplicate) duplicate_sources;
`, [draw.drawId, tickets.map((ticket) => ticket.ticket_id)])).rows[0];
  check(`draw ${draw.drawId} has singular authority evidence and zero duplicate effects`,
    evidence.outcome_events === 1 && evidence.outcome_versions === 1 &&
      evidence.requests === expectedItems && evidence.settlements === expectedItems &&
      evidence.sources === expectedItems && evidence.completions === tickets.length &&
      evidence.duplicate_settlements === 0 && evidence.duplicate_sources === 0,
    evidence);
  return evidence;
}

async function verifyTicketFinancials(tickets) {
  const evidence = (await pool.query(`
with math as (
  select item.ticket_id,
    sum(round(item.stake_minor * (evaluation.prize_facts->>'Multiplier')::numeric))::bigint math_payout_minor,
    sum(coalesce((evaluation.prize_facts->'OutcomeDerivedFacts'->>'uncappedPayoutMinor')::numeric,0))::bigint
      uncapped_payout_minor
  from ticket_authority.ticket_items item
  join game_engine.math_evaluation_events evaluation
    on evaluation.ticket_reference=item.ticket_item_id::text
  where item.ticket_id=any($1::uuid[])
  group by item.ticket_id
), settlement as (
  select item.ticket_id,
    sum(record.stake_amount_minor)::bigint settlement_stake_minor,
    sum(record.gross_payout_amount_minor)::bigint gross_payout_minor,
    sum(record.net_result_amount_minor)::bigint net_result_minor,
    max(record.gross_payout_amount_minor)::bigint maximum_play_payout_minor
  from ticket_authority.ticket_items item
  join game_engine.settlement_input_records input
    on input.ticket_reference=item.ticket_item_id::text
  join settlement_service.authoritative_settlement_records record
    on record.settlement_input_id=input.settlement_input_id
  where item.ticket_id=any($1::uuid[])
  group by item.ticket_id
), effects as (
  select item.ticket_id,
    sum(case ledger.direction when 'CREDIT' then ledger.amount else -ledger.amount end)::bigint
      ledger_effect_minor,
    sum(wallet.balance_impact_minor)::bigint wallet_effect_minor
  from ticket_authority.ticket_items item
  join ticket_completion_authority.completion_sources source
    on source.ticket_item_id=item.ticket_item_id
  left join public.financial_ledger_entries ledger on ledger.id=source.ledger_entry_id
  left join credit_wallet_service.wallet_operation_requests wallet
    on wallet.operation_id=source.wallet_operation_id
  where item.ticket_id=any($1::uuid[])
  group by item.ticket_id
)
select ticket.ticket_id,ticket.external_ticket_id,ticket.status,ticket.lifecycle_state,
  ticket.total_stake_minor,ticket.reservation_id,reservation.status reservation_status,
  reservation.captured_amount,reservation.released_amount,reservation.remaining_exposure,
  wallet.balance::text final_balance,count(source.source_id)::int source_count,
  count(source.ledger_execution_attempt_id)::int ledger_attempts,
  count(source.wallet_execution_attempt_id)::int wallet_attempts,
  completion.completion_id,definition.code product_code,
  math.math_payout_minor,math.uncapped_payout_minor,
  settlement.settlement_stake_minor,settlement.gross_payout_minor,
  settlement.net_result_minor,settlement.maximum_play_payout_minor,
  effects.ledger_effect_minor,effects.wallet_effect_minor
from ticket_authority.tickets ticket
join public.credit_reservations reservation on reservation.id=ticket.reservation_id
join public.financial_wallets wallet on wallet.id=ticket.wallet_id
join game_engine.game_definitions definition on definition.id=ticket.product_id
join math on math.ticket_id=ticket.ticket_id
join settlement on settlement.ticket_id=ticket.ticket_id
join effects on effects.ticket_id=ticket.ticket_id
left join ticket_authority.ticket_items item on item.ticket_id=ticket.ticket_id
left join ticket_completion_authority.completion_sources source on source.ticket_item_id=item.ticket_item_id
left join ticket_completion_authority.completion_evidence completion on completion.ticket_id=ticket.ticket_id
where ticket.ticket_id=any($1::uuid[])
group by ticket.ticket_id,reservation.id,wallet.id,completion.completion_id,definition.id,
  math.ticket_id,math.math_payout_minor,math.uncapped_payout_minor,
  settlement.ticket_id,settlement.settlement_stake_minor,settlement.gross_payout_minor,
  settlement.net_result_minor,settlement.maximum_play_payout_minor,
  effects.ticket_id,effects.ledger_effect_minor,effects.wallet_effect_minor
order by ticket.external_ticket_id;
`, [tickets.map((ticket) => ticket.ticket_id)])).rows;
  const accepted = new Map(tickets.map((ticket) => [ticket.ticket_id, ticket]));
  for (const row of evidence) {
    const ticket = accepted.get(row.ticket_id);
    row.starting_balance = Number(ticket?.initial_balance);
    row.expected_ending_balance =
      row.starting_balance +
      Number(row.ledger_effect_minor) +
      Number(row.wallet_effect_minor);
  }
  check("every accepted ticket reconciles reservation, Ledger, Wallet, and Completion evidence",
    evidence.length === tickets.length && evidence.every((row) =>
      row.status === "SETTLED" && row.lifecycle_state === "REBATE_ELIGIBLE" &&
      row.completion_id && row.source_count > 0 && row.ledger_attempts === row.source_count &&
      row.wallet_attempts === row.source_count && ["CAPTURED", "RELEASED"].includes(row.reservation_status) &&
      Number(row.captured_amount) + Number(row.released_amount) === Number(row.total_stake_minor) &&
      Number(row.settlement_stake_minor) === Number(row.total_stake_minor) &&
      Number(row.math_payout_minor) === Number(row.gross_payout_minor) &&
      Number(row.gross_payout_minor) - Number(row.total_stake_minor) === Number(row.net_result_minor) &&
      Number(row.ledger_effect_minor) === Number(row.gross_payout_minor) &&
      Number(row.wallet_effect_minor) === -Number(row.total_stake_minor) &&
      Number(row.ledger_effect_minor) + Number(row.wallet_effect_minor) === Number(row.net_result_minor) &&
      Number(row.final_balance) === row.expected_ending_balance),
    { tickets: evidence });
  const fastCap = evidence.find((row) => row.external_ticket_id === "pr04a-fast-cap");
  check("Fast Keno applies one 10,000 dollar cap to the combined ticket payout",
    fastCap?.product_code === "FAST_KENO_V1" && Number(fastCap.gross_payout_minor) === 1_000_000 &&
      Number(fastCap.uncapped_payout_minor) > 1_000_000,
    { fastCap });
  check("Hot Spot applies its 50,000 dollar cap independently to each play",
    evidence.filter((row) => row.product_code === "HOT_SPOT_V1").every((row) =>
      Number(row.maximum_play_payout_minor) <= 5_000_000),
    { hotSpot: evidence.filter((row) => row.product_code === "HOT_SPOT_V1") });
  return evidence;
}

async function restoreActiveVersions() {
  for (const [productId, activeVersionId] of originalActiveVersions) {
    await pool.query("update game_engine.game_definitions set active_version_id=$2 where id=$1", [
      productId, activeVersionId,
    ]);
  }
}

try {
  const csprngPath = "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
  const csprngHash = createHash("sha256").update(readFileSync(csprngPath)).digest("hex");
  check("qualified CSPRNG source remains unchanged",
    csprngHash === "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c",
    { csprngHash });

  const scope = await loadScope();
  const fast = await loadProduct("FAST_KENO_V1");
  const hot = await loadProduct("HOT_SPOT_V1");
  check("pilot products retain published inactive unassigned immutable versions",
    !fast.active_version_id && !hot.active_version_id, {
      fast: fast.product_version_id, hotSpot: hot.product_version_id,
    });
  await enableProductForQualification(fast);
  await enableProductForQualification(hot);
  await createAvailability(scope, fast);
  await createAvailability(scope, hot);
  await activateQualificationProvider();

  const accounts = await createAccounts(scope, 12);
  const fastDraw = await createDraw(fast);
  const hotDraw = await createDraw(hot, { targetDelaySeconds: 120 });
  const futureHotDraws = [];
  for (let index = 1; index < 5; index += 1) {
    futureHotDraws.push(await createDraw(hot, {
      target: false,
      sequenceOffset: index,
      targetDelaySeconds: 120,
    }));
  }
  await insertLiability(scope, accounts, fast, fastDraw, accounts.players.slice(0, 3),
    ["KenoBigSmall", "KenoOddEven", "KenoDragonTiger", "KenoUpDown", "KenoParlay", "KenoElement"]);
  await insertLiability(scope, accounts, hot, hotDraw, accounts.players.slice(3, 12), ["KenoSpot"]);

  let mismatchRejected = false;
  try {
    await acceptTicket(fast, fastDraw, accounts.players[0], scope, fastItems().slice(0, 1),
      "mismatched-paytable", hot.paytable_definition_id);
  } catch (error) {
    mismatchRejected = /paytable|lineage|manifest/i.test(error instanceof Error ? error.message : String(error));
  }
  check("genuinely mismatched paytable lineage fails closed", mismatchRejected);

  const fastTickets = [
    await acceptTicket(fast, fastDraw, accounts.players[0], scope, fastItems(), "fast-opposing-a"),
    await acceptTicket(fast, fastDraw, accounts.players[1], scope, fastItems().reverse(), "fast-opposing-b"),
    await acceptTicket(fast, fastDraw, accounts.players[2], scope, fastCapItems(), "fast-cap"),
  ];

  const hotTickets = [];
  for (let block = 0; block < 8; block += 1) {
    hotTickets.push(await acceptTicket(
      hot, hotDraw, accounts.players[3 + block], scope,
      hotSpotCoverageItems(block * 10, block % 2 === 1), `hot-coverage-${block + 1}`));
  }
  const quickPickKey = `pr04a-quick-pick:${runId}`;
  const quickPickRequestId = randomUUID();
  const quickPick = runHotSpotHarness([
    "quick-pick", quickPickRequestId, quickPickKey, "10", hot.definition_hash, "qa:pr04a",
  ]);
  const quickPickTicket = await acceptTicket(hot, hotDraw, accounts.players[11], scope, [{
    wagerType: "KenoSpot",
    wagerVersion: "1.0.0",
    selections: {
      numbers: quickPick.numbers,
      quickPickSelectionId: quickPick.selectionId,
      quickPickSelectionHash: quickPick.selectionHash,
      bullseyePurchased: true,
    },
    stakeMinor: 500,
  }], "hot-quick-pick-multi-draw");
  hotTickets.push(quickPickTicket);
  const multiDraw = runHotSpotHarness([
    "multi-draw", randomUUID(), quickPickTicket.ticket_id, "5", "100", quickPickKey,
  ]);
  check("Quick Pick and exact five-draw lineage are durably bound to the accepted ticket",
    multiDraw.ticketId === quickPickTicket.ticket_id && multiDraw.drawCount === 5 &&
      multiDraw.bindings.length === 5 && multiDraw.quickPick?.selectionHash === quickPick.selectionHash &&
      multiDraw.bindings[0].drawId === hotDraw.drawId &&
      futureHotDraws.every((draw) => multiDraw.bindings.some((binding) => binding.drawId === draw.drawId)),
    { quickPick, multiDraw });

  const fastItemCount = fastTickets.reduce((total, ticket) => total +
    (ticket.label === "fast-cap" ? 16 : 10), 0);
  const hotItemCount = hotTickets.reduce((total, ticket) => total +
    (ticket.label === "hot-quick-pick-multi-draw" ? 1 : 10), 0);
  await makeDrawDue(fastDraw);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

  const fastA = await startService(5594, publicKeyPem, privateKeyPem);
  const fastB = await startService(5595, publicKeyPem, privateKeyPem);
  await waitFor("concurrent scheduler instances produce one Fast Keno fanout", async () => {
    const row = (await pool.query(`
select runtime.scheduler_state,
  (select count(*)::int from game_engine.outcome_events event where event.execution_manifest_id=$2) events,
  (select count(*)::int from game_engine.outcome_settlement_requests request where request.draw_id=$1) requests,
  (select count(*)::int from game_engine.durable_scheduler_execution_attempts attempt
    where attempt.draw_id=$1 and attempt.attempt_status='CLAIMED') claims
from game_engine.durable_scheduler_draws runtime where runtime.draw_id=$1;
`, [fastDraw.drawId, fastDraw.executionManifestId])).rows[0];
    return row?.scheduler_state === "SettlementTriggered" && row.events === 1 &&
      row.requests === fastItemCount && row.claims === 1 ? row : null;
  });
  await stopService(fastA);
  await stopService(fastB);

  await makeDrawDue(hotDraw);

  const failureStages = [
    ["AfterCertificateBeforeFanout", 1, (row) => row.certificates === 1 && row.inputs === 0],
    ["AfterMathBeforeSettlementInput", 2, (row) => row.inputs === 0],
    ["AfterSettlementInputBeforeRequest", 3, (row) => row.inputs >= 1 && row.requests === 0],
    ["AfterCompletedPages", 4, (row) => row.requests > 0 && row.requests < hotItemCount],
  ];
  let recoveryPort = 5601;
  for (const [failureStage, attempt, predicate] of failureStages) {
    const service = await startService(recoveryPort, publicKeyPem, privateKeyPem, failureStage, 1);
    await waitForRecovery(hotDraw, attempt, predicate);
    await stopService(service);
    recoveryPort += 1;
  }
  const hotService = await startService(recoveryPort, publicKeyPem, privateKeyPem, "", 5);
  await waitFor("Hot Spot recovered fanout reaches Settlement request completion", async () => {
    const row = (await pool.query(`
select scheduler_state from game_engine.durable_scheduler_draws where draw_id=$1;
`, [hotDraw.drawId])).rows[0];
    const requests = Number((await pool.query(`
select count(*) count from game_engine.outcome_settlement_requests where draw_id=$1;
`, [hotDraw.drawId])).rows[0].count);
    return row?.scheduler_state === "SettlementTriggered" && requests === hotItemCount
      ? { ...row, requests } : null;
  });
  await stopService(hotService);

  await waitForFinancialCompletion(fastDraw, fastTickets, fastItemCount);
  await waitForFinancialCompletion(hotDraw, hotTickets, hotItemCount);
  const fastSingular = await verifyNoDuplicates(fastDraw, fastTickets, fastItemCount);
  const hotSingular = await verifyNoDuplicates(hotDraw, hotTickets, hotItemCount);
  const ticketFinancials = await verifyTicketFinancials([...fastTickets, ...hotTickets]);

  const outcomeFacts = (await pool.query(`
select version.draw_id,version.validated_primary_result,
  bullseye.bullseye_number,
  count(*) filter (where (event.prize_facts->>'Outcome')::int=0)::int wins,
  count(*) filter (where (event.prize_facts->>'Outcome')::int=1)::int losses,
  count(*) filter (where (event.prize_facts->'OutcomeDerivedFacts'->>'bullseyePurchased')::boolean)::int bullseye_plays,
  count(*) filter (where (event.prize_facts->'OutcomeDerivedFacts'->>'bullseyeMatch')::boolean)::int bullseye_wins,
  count(*) filter (where (event.prize_facts->'OutcomeDerivedFacts'->>'capApplied')::boolean)::int capped
from game_engine.canonical_outcome_versions version
join game_engine.outcome_certificates certificate on certificate.certificate_id=version.outcome_certificate_id
join game_engine.math_evaluation_events event on event.outcome_certificate_id=certificate.certificate_id
left join game_engine.hot_spot_bullseye_evidence bullseye on bullseye.draw_id=version.draw_id
where version.draw_id in ($1,$2)
group by version.draw_id,version.validated_primary_result,bullseye.bullseye_number;
`, [fastDraw.drawId, hotDraw.drawId])).rows;
  const fastFacts = outcomeFacts.find((row) => row.draw_id === fastDraw.drawId);
  const hotFacts = outcomeFacts.find((row) => row.draw_id === hotDraw.drawId);
  check("Fast Keno includes authoritative winners, losers, opposing wagers, and cap behavior",
    fastFacts?.wins > 0 && fastFacts?.losses > 0 && fastFacts?.capped === 1, fastFacts);
  check("Hot Spot includes authoritative winners, losers, Bullseye designation, and Bullseye plays",
    hotFacts?.wins > 0 && hotFacts?.losses > 0 && hotFacts?.bullseye_number && hotFacts?.bullseye_plays > 0,
    hotFacts);

  const quickPickEvidence = (await pool.query(`
select selection.selection_id,selection.selection_hash,selection.product_version_hash,
  purchase.ticket_id,purchase.canonical_plan_hash,count(binding.binding_id)::int binding_count,
  bool_and(binding.draw_identity_hash=runtime.draw_identity_hash) exact_identity
from game_engine.hot_spot_quick_pick_selections selection
join game_engine.hot_spot_multi_draw_purchases purchase on purchase.quick_pick_selection_id=selection.selection_id
join game_engine.hot_spot_multi_draw_bindings binding on binding.purchase_id=purchase.purchase_id
join game_engine.durable_scheduler_draws runtime on runtime.draw_id=binding.draw_id
where selection.idempotency_key=$1
group by selection.selection_id,purchase.purchase_id;
`, [quickPickKey])).rows[0];
  check("Quick Pick and multi-draw provenance remain immutable and exact after financial completion",
    quickPickEvidence?.ticket_id === quickPickTicket.ticket_id &&
      quickPickEvidence?.product_version_hash === hot.definition_hash &&
      quickPickEvidence?.binding_count === 5 && quickPickEvidence?.exact_identity,
    quickPickEvidence);

  await restoreActiveVersions();
  await resetQualificationProviderActivation();
  const restored = (await pool.query(`
select definition.code,definition.active_version_id,version.activation_state,version.assignment_state
from game_engine.game_definitions definition
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
where definition.code in ('FAST_KENO_V1','HOT_SPOT_V1') and version.publication_state='PUBLISHED'
order by definition.code;
`)).rows;
  check("qualification teardown restores pilot products to inactive unassigned state",
    restored.length === 2 && restored.every((row) => !row.active_version_id &&
      row.activation_state === "INACTIVE" && row.assignment_state === "UNASSIGNED"), { restored });
  const activeQualificationProvider = Number((await pool.query(`
select count(*)::int count
from game_engine.game_engine_production_activation_events
where provider_id='mosera-internal-csprng'
  and provider_version='2.0.0'
  and configuration_version='2'
  and stage='PRODUCTION_ACTIVE';
`)).rows[0].count);
  check("qualification teardown leaves canonical production provider activation disabled",
    activeQualificationProvider === 0, { activeQualificationProvider });

  console.log(JSON.stringify({
    status: "PASS",
    disposition: "PR04A_CANONICAL_PILOT_CHAIN_QUALIFIED",
    runId,
    products: {
      fastKeno: { drawId: fastDraw.drawId, tickets: fastTickets.length, items: fastItemCount, evidence: fastSingular },
      hotSpot: { drawId: hotDraw.drawId, tickets: hotTickets.length, items: hotItemCount, evidence: hotSingular },
    },
    recoveryStages: failureStages.map(([stage]) => stage),
    ticketFinancials,
    checks,
  }, null, 2));
} finally {
  for (const service of [...services]) await stopService(service);
  await restoreActiveVersions().catch(() => {});
  await resetQualificationProviderActivation().catch(() => {});
  await pool.end();
}
