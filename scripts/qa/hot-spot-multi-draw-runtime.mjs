import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const runId = randomUUID();
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const services = new Set();
const checks = [];
let originalActiveVersion = null;
let product = null;

const hash = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

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

async function waitFor(name, probe, timeoutMs = 300_000) {
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

async function loadScopeAndProduct() {
  const scope = (await pool.query(`
select platform.id platform_id,organization.id organization_id,
  tenant.id tenant_id,brand.id brand_id,market.id market_id,market.currency
from platform.markets market
join platform.brands brand on brand.id=market.brand_id and brand.status='Active'
join platform.tenants tenant on tenant.id=brand.tenant_id and tenant.status='Active'
join platform.organizations organization on organization.id=tenant.organization_id and organization.status='Active'
join platform.platforms platform on platform.id=organization.platform_id and platform.status='Active'
where market.status='Active'
order by market.created_at,market.id limit 1;
`)).rows[0];
  product = (await pool.query(`
select definition.id product_id,definition.active_version_id,definition.code,
  version.id product_version_id,version.definition_hash,
  version.game_manifest_id,version.paytable_definition_id,version.paytable_version,
  version.evaluator_version,version.outcome_provider_id,version.outcome_provider_version,
  version.provider_configuration_version,version.schedule_version_id,
  schedule.draw_authority_assignment_id,schedule.schedule_hash,
  assignment.draw_authority_version_id,module.code engine_name,module_version.version engine_version
from game_engine.game_definitions definition
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
join game_engine.published_draw_schedule_versions schedule on schedule.schedule_version_id=version.schedule_version_id
join game_engine.draw_authority_assignments assignment on assignment.id=schedule.draw_authority_assignment_id
join game_engine.game_modules module on module.id=definition.game_module_id
join game_engine.game_module_versions module_version on module_version.game_module_id=module.id
  and module_version.version=version.product_configuration->>'engineVersion'
where definition.code='HOT_SPOT_V1' and version.publication_state='PUBLISHED'
  and version.activation_state='INACTIVE' and version.assignment_state='UNASSIGNED'
order by version.version_number desc limit 1;
`)).rows[0];
  if (!scope || !product) throw new Error("Canonical scope and immutable Hot Spot product are required.");
  return scope;
}

async function activateQualificationOnly(scope) {
  originalActiveVersion = product.active_version_id;
  await pool.query("update game_engine.game_definitions set active_version_id=$2 where id=$1", [
    product.product_id, product.product_version_id,
  ]);
  await pool.query(`
insert into platform.game_availability(
  id,tenant_id,brand_id,market_id,game_id,game_code,game_manifest_reference,
  status,effective_from,version,content_hash,audit_metadata,lifecycle_reason,lifecycle_operator)
values ($1,$2,$3,$4,$5,'hot_spot_v1',$6,'Active',clock_timestamp()-interval '1 second',
  $7,$8,$9::jsonb,'PR04C_QUALIFICATION_ONLY','qa:pr04c');
`, [randomUUID(), scope.tenant_id, scope.brand_id, scope.market_id, product.product_id,
      product.game_manifest_id, `pr04c-${runId}`, hash(`availability:${runId}`),
      JSON.stringify({ runId, qualificationOnly: true })]);
  const latest = (await pool.query(`
select stage from game_engine.game_engine_production_activation_events
where provider_id='mosera-internal-csprng' and provider_version='2.0.0' and configuration_version='2'
order by created_at desc,activation_event_id desc limit 1;
`)).rows[0]?.stage;
  const stages = ["REGISTERED", "READY", "APPROVED", "PRODUCTION_ACTIVE"];
  const start = latest ? stages.indexOf(latest) + 1 : 0;
  if (latest && start === 0 && latest !== "PRODUCTION_ACTIVE") {
    throw new Error(`Unsupported provider activation stage ${latest}.`);
  }
  for (const stage of stages.slice(start)) {
    await pool.query(`
insert into game_engine.game_engine_production_activation_events(
  activation_event_id,provider_id,provider_version,configuration_version,stage,
  actor_reference,reason_code,approval_reference,signing_provider_id,signing_provider_version,
  signing_key_version,canonical_request_hash,evidence_hash,idempotency_key,created_at)
values($1,'mosera-internal-csprng','2.0.0','2',$2,'qa:pr04c','PR04C_QUALIFICATION_ONLY',
  'qa:pr04c-approved','mosera-software-signing','1.0.0','key-v1',$3,$4,$5,clock_timestamp());
`, [randomUUID(), stage, hash(`activation:${runId}:${stage}`),
        hash(`activation-evidence:${runId}:${stage}`), `pr04c:${runId}:${stage}`]);
  }
}

async function resetQualificationOnly() {
  if (product) {
    await pool.query("update game_engine.game_definitions set active_version_id=$2 where id=$1", [
      product.product_id, originalActiveVersion,
    ]).catch(() => {});
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(`
delete from game_engine.game_engine_production_activation_events
where provider_id='mosera-internal-csprng' and provider_version='2.0.0'
  and configuration_version='2' and reason_code='PR04C_QUALIFICATION_ONLY';
`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function restoreProductActivation() {
  if (!product) return;
  await pool.query("update game_engine.game_definitions set active_version_id=$2 where id=$1", [
    product.product_id, originalActiveVersion,
  ]);
}

async function createAccounts(scope, count) {
  const hierarchy = { super: randomUUID(), master: randomUUID(), agent: randomUUID(), players: [] };
  const addAccount = (id, type, parent = null) => pool.query(`
insert into public.accounts(id,account_type,account_code,display_name,parent_account_id,
  canonical_tenant_id,canonical_brand_id,canonical_market_id,status,governance_managed,
  idempotency_key,canonical_request_hash)
values($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',true,$9,$10);
`, [id, type, `pr04c-${runId.slice(0, 8)}-${type.toLowerCase()}-${id.slice(0, 4)}`,
      `PR-04C ${type}`, parent, scope.tenant_id, scope.brand_id, scope.market_id,
      `pr04c-account:${id}`, hash(`account:${id}`)]);
  await addAccount(hierarchy.super, "SUPER_MASTER");
  await addAccount(hierarchy.master, "MASTER_AGENT", hierarchy.super);
  await addAccount(hierarchy.agent, "AGENT", hierarchy.master);
  for (let index = 0; index < count; index += 1) {
    const player = { accountId: randomUUID(), profileId: randomUUID(), walletId: randomUUID() };
    await addAccount(player.accountId, "PLAYER", hierarchy.agent);
    await pool.query("insert into public.player_profiles(id,account_id,display_name,status) values($1,$2,$3,'ACTIVE')", [
      player.profileId, player.accountId, `PR-04C Player ${index + 1}`,
    ]);
    await pool.query(`
insert into public.financial_wallets(id,account_id,wallet_type,currency_code,balance_authority,
  status,balance,credit_limit,funding_model)
values($1,$2,'CREDIT',$3,'INTERNAL','ACTIVE',0,5000000000,'CREDIT');
`, [player.walletId, player.accountId, scope.currency]);
    await pool.query(`
insert into credit_wallet_service.wallet_scopes(
  wallet_id,tenant_id,brand_id,player_id,instrument_code,currency,authority)
values($1,$2,$3,$4,'CREDIT',$5,'CREDIT_WALLET_SERVICE');
`, [player.walletId, scope.tenant_id, scope.brand_id, player.accountId, scope.currency]);
    hierarchy.players.push(player);
  }
  return hierarchy;
}

async function createDraw(delaySeconds, sequenceOffset) {
  const drawId = randomUUID();
  const executionManifestId = randomUUID();
  const publicDrawNumber = Number((await pool.query(`
select coalesce(max(public_draw_number),0)::bigint + 1 value
from game_engine.durable_scheduler_draws where product_code='HOT_SPOT_V1';
`)).rows[0].value) + sequenceOffset;
  const scheduledAt = new Date(Date.now() + delaySeconds * 1000);
  const salesOpenAt = new Date(Date.now() - 120_000);
  const cutoffAt = new Date(scheduledAt.getTime() - 15_000);
  const drawHash = hash(`draw:${drawId}`);
  const manifestHash = hash(`manifest:${drawId}:${product.product_version_id}`);
  await pool.query(`
insert into game_engine.draw_schedules(id,game_definition_id,draw_authority_assignment_id,
  sales_open_at,sales_close_at,draw_at,status,schedule_version_id,scheduled_execution_at,
  schedule_hash,draw_identity_hash)
values($1,$2,$3,$4,$5,$6,'SalesOpen',$7,$6,$8,$9);
`, [drawId, product.product_id, product.draw_authority_assignment_id, salesOpenAt, cutoffAt,
      scheduledAt, product.schedule_version_id, product.schedule_hash, drawHash]);
  await pool.query(`
insert into game_engine.draw_execution_manifests(execution_manifest_id,draw_id,schedule_version_id,
  game_definition_version_id,draw_authority_version_id,engine_name,engine_version,outcome_provider_id,
  outcome_provider_version,provider_configuration_version,evaluator_version,paytable_version,
  scheduled_execution_at,schedule_hash,draw_identity_hash,canonical_manifest_hash,created_at)
values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,clock_timestamp());
`, [executionManifestId, drawId, product.schedule_version_id, product.product_version_id,
      product.draw_authority_version_id, product.engine_name, product.engine_version,
      product.outcome_provider_id, product.outcome_provider_version,
      product.provider_configuration_version, product.evaluator_version, product.paytable_version,
      scheduledAt, product.schedule_hash, drawHash, manifestHash]);
  await pool.query(`
insert into game_engine.durable_scheduler_draws(draw_id,product_id,product_version_id,product_code,
  schedule_version_id,public_draw_number,sales_open_at,cutoff_at,scheduled_execution_at,
  draw_identity_hash,scheduler_state,recovery_deadline_at,materialized_at)
values($1,$2,$3,'HOT_SPOT_V1',$4,$5,$6,$7,$8,$9,'Accepting',
  clock_timestamp()+interval '30 minutes',clock_timestamp());
`, [drawId, product.product_id, product.product_version_id, product.schedule_version_id,
      publicDrawNumber, salesOpenAt, cutoffAt, scheduledAt, drawHash]);
  await pool.query(`
insert into game_engine.durable_scheduler_product_sequences(product_code,next_public_draw_number,updated_at)
values('HOT_SPOT_V1',$1,clock_timestamp())
on conflict(product_code) do update
set next_public_draw_number=greatest(
      game_engine.durable_scheduler_product_sequences.next_public_draw_number,
      excluded.next_public_draw_number),
    updated_at=clock_timestamp();
`, [publicDrawNumber + 1]);
  return { drawId, executionManifestId, scheduledAt };
}

async function addLiability(scope, hierarchy, draws) {
  const scopes = [
    ["TENANT", scope.tenant_id], ["MASTER_AGENT", hierarchy.master], ["AGENT", hierarchy.agent],
    ["PRODUCT", product.product_id], ["GAME", "hot_spot_v1"], ["WAGER_TYPE", "kenospot"],
    ...hierarchy.players.map((player) => ["PLAYER", player.accountId]),
    ...draws.map((draw) => ["DRAW", draw.drawId]),
  ];
  for (const [scopeType, scopeReference] of scopes) {
    const previous = (await pool.query(`
select configuration_id,version from ticket_authority.liability_limit_configurations
where tenant_id=$1 and brand_id=$2 and scope_type=$3 and scope_reference=$4
order by version desc limit 1;
`, [scope.tenant_id, scope.brand_id, scopeType, String(scopeReference).toLowerCase()])).rows[0];
    const version = Number(previous?.version ?? 0) + 1;
    await pool.query(`
insert into ticket_authority.liability_limit_configurations(configuration_id,tenant_id,brand_id,
  scope_type,scope_reference,maximum_wager_minor,maximum_theoretical_payout_minor,
  maximum_exposure_minor,status,effective_from,version,supersedes_configuration_id,
  content_hash,audit_metadata)
values($1,$2,$3,$4,$5,5000000000,500000000000,500000000000,'Active',
  clock_timestamp()-interval '1 millisecond',$6,$7,$8,$9::jsonb);
`, [randomUUID(), scope.tenant_id, scope.brand_id, scopeType,
        String(scopeReference).toLowerCase(), version, previous?.configuration_id ?? null,
        hash(`liability:${runId}:${scopeType}:${scopeReference}:${version}`),
        JSON.stringify({ runId, qualificationOnly: true })]);
  }
}

async function acceptTicket(scope, player, firstDraw, label, items) {
  const result = (await pool.query(`
select ticket_authority.accept_ticket(
  $1,$2,'CREDIT',$3,$4,$5,$6,$7,null,$8,$9,$10::jsonb,$11,$12,$13,$14,$15
) result;
`, [player.accountId, player.profileId, player.walletId, product.product_id,
      product.game_manifest_id, product.paytable_definition_id, firstDraw.drawId,
      `pr04c-${label}`, scope.currency, JSON.stringify(items), `pr04c-ticket:${runId}:${label}`,
      `pr04c:${runId}:${label}`, `draw:${firstDraw.drawId}`, "qa:pr04c", "PR04C"])).rows[0].result;
  if (!result.accepted) throw new Error(`Ticket ${label} rejected: ${JSON.stringify(result)}`);
  return (await pool.query(`
select ticket.*,reservation.reserved_amount,reservation.remaining_exposure,wallet.balance::text initial_balance
from ticket_authority.tickets ticket
join public.credit_reservations reservation on reservation.id=ticket.reservation_id
join public.financial_wallets wallet on wallet.id=ticket.wallet_id
where ticket.ticket_id=$1;
`, [result.ticketId])).rows[0];
}

function runHarness(args) {
  const stdout = command("dotnet", ["run", "--no-build", "--project",
    "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
    "--", "pr04a-hot-spot-evidence", ...args], { DATABASE_URL: databaseUrl });
  return JSON.parse(stdout.split("\n").filter(Boolean).at(-1));
}

async function startService(port, publicKeyPem, privateKeyPem) {
  mkdirSync(".qa/pr-04c", { recursive: true });
  const log = createWriteStream(`.qa/pr-04c/game-engine-${runId}-${port}.log`, { flags: "a" });
  const service = spawn("dotnet", ["run", "--no-build", "--no-launch-profile", "--project",
    "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj"], {
    cwd: process.cwd(),
    env: {
      ...process.env, DATABASE_URL: databaseUrl, ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
      DEPLOYMENT_ENVIRONMENT: "local", OUTCOME_CANONICAL_PIPELINE_ENABLED: "true",
      OUTCOME_LEGACY_PUBLICATION_ENABLED: "false", GAME_ENGINE_PRODUCTION_ACTIVATION_ENABLED: "true",
      GAME_ENGINE_PRODUCTION_SIGNING_ENABLED: "true",
      GAME_ENGINE_SIGNING_PROVIDER_ID: "mosera-software-signing",
      GAME_ENGINE_SIGNING_PROVIDER_VERSION: "1.0.0", GAME_ENGINE_SIGNING_KEY_VERSION: "key-v1",
      GAME_ENGINE_SIGNING_PUBLIC_KEY_PEM: publicKeyPem,
      GAME_ENGINE_DURABLE_SCHEDULER_ENABLED: "true",
      GAME_ENGINE_DURABLE_SCHEDULER_PRODUCTION_EXECUTION_ENABLED: "true",
      GAME_ENGINE_SCHEDULER_POLL_INTERVAL_MS: "250",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_ENABLED: "true",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_QUALIFICATION_MODE: "true",
      GAME_ENGINE_QUALIFICATION_SIGNING_PRIVATE_KEY_PEM: privateKeyPem,
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_PAGE_SIZE: "8",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_CONCURRENCY: "4",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  services.add(service);
  service.stdout.pipe(log);
  service.stderr.pipe(log);
  await waitFor(`Game Engine ${port} starts`, async () => {
    if (service.exitCode !== null) throw new Error(`Game Engine exited with ${service.exitCode}`);
    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    return response.ok ? { port } : null;
  }, 60_000);
  return service;
}

async function stopService(service) {
  if (!service || service.exitCode !== null) return services.delete(service);
  service.kill("SIGTERM");
  await Promise.race([once(service, "exit"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (service.exitCode === null) service.kill("SIGKILL");
  services.delete(service);
}

async function makeDue(draws) {
  const waitMs = Math.max(...draws.map((draw) => draw.scheduledAt.getTime())) - Date.now() + 100;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const ids = draws.map((draw) => draw.drawId);
  await pool.query("update game_engine.draw_schedules set status='AwaitingResult' where id=any($1::uuid[])", [ids]);
  await pool.query("update game_engine.durable_scheduler_draws set scheduler_state='ExecutionDue' where draw_id=any($1::uuid[])", [ids]);
}

async function waitForDrawSettlements(draw, expected) {
  return waitFor(`draw ${draw.drawId} settles ${expected} participations`, async () => {
    const row = (await pool.query(`
select
  (select count(*)::int from game_engine.canonical_outcome_versions where draw_id=$1) outcomes,
  (select count(*)::int from game_engine.outcome_settlement_requests where draw_id=$1) requests,
  (select count(*)::int from settlement_service.authoritative_settlement_records settlement
    join game_engine.outcome_settlement_requests request on request.settlement_request_id=settlement.settlement_request_id
    where request.draw_id=$1) settlements
`, [draw.drawId])).rows[0];
    return row.outcomes === 1 && row.requests === expected && row.settlements === expected ? row : null;
  });
}

try {
  const csprngHash = command("shasum", ["-a", "256",
    "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs"])
    .split(/\s+/)[0];
  check("qualified CSPRNG source remains unchanged",
    csprngHash === "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c",
    { csprngHash });
  const scope = await loadScopeAndProduct();
  await activateQualificationOnly(scope);
  const hierarchy = await createAccounts(scope, 5);
  const draws = [];
  draws.push(await createDraw(90, 0));
  for (let index = 1; index < 20; index += 1) draws.push(await createDraw(120 + index * 0.05, index));
  await addLiability(scope, hierarchy, draws);

  const quickPickKey = `pr04c-quick-pick:${runId}`;
  const quickPick = runHarness(["quick-pick", randomUUID(), quickPickKey, "10",
    product.definition_hash, "qa:pr04c"]);
  const definitions = [
    { label: "one", count: 1, player: 0, items: [{ wagerType: "KenoSpot", wagerVersion: "1.0.0",
      selections: { numbers: [1], multiDrawCount: 1, bullseyePurchased: false }, stakeMinor: 100 }] },
    { label: "five", count: 5, player: 1, items: [
      { wagerType: "KenoSpot", wagerVersion: "1.0.0",
        selections: { numbers: [2], multiDrawCount: 5, bullseyePurchased: false }, stakeMinor: 100 },
      { wagerType: "KenoSpot", wagerVersion: "1.0.0",
        selections: { numbers: [3], multiDrawCount: 5, bullseyePurchased: true }, stakeMinor: 200 },
    ] },
    { label: "ten", count: 10, player: 2, items: [{ wagerType: "KenoSpot", wagerVersion: "1.0.0",
      selections: { numbers: [4], multiDrawCount: 10, bullseyePurchased: false }, stakeMinor: 150 }] },
    { label: "twenty", count: 20, player: 3, quickPickKey, items: [{
      wagerType: "KenoSpot", wagerVersion: "1.0.0", selections: {
        numbers: quickPick.numbers, quickPickSelectionId: quickPick.selectionId,
        quickPickSelectionHash: quickPick.selectionHash, multiDrawCount: 20, bullseyePurchased: true,
      }, stakeMinor: 250,
    }] },
    { label: "cancel", count: 5, player: 4, items: [{ wagerType: "KenoSpot", wagerVersion: "1.0.0",
      selections: { numbers: [5], multiDrawCount: 5, bullseyePurchased: false }, stakeMinor: 125 }] },
  ];
  for (const definition of definitions) {
    definition.stakePerDraw = definition.items.reduce((sum, item) => sum + item.stakeMinor, 0);
    definition.ticket = await acceptTicket(scope, hierarchy.players[definition.player], draws[0],
      definition.label, definition.items);
    definition.purchaseId = randomUUID();
    definition.plan = runHarness(["multi-draw", definition.purchaseId, definition.ticket.ticket_id,
      String(definition.count), String(definition.stakePerDraw),
      ...(definition.quickPickKey ? [definition.quickPickKey] : [])]);
    const expectedDraws = draws.slice(0, definition.count).map((draw) => draw.drawId);
    check(`${definition.count}-draw ticket binds exact immutable sequence and full upfront reservation`,
      definition.plan.bindings.map((binding) => binding.drawId).join() === expectedDraws.join() &&
      Number(definition.ticket.total_stake_minor) === definition.stakePerDraw * definition.count &&
      Number(definition.ticket.reserved_amount) === definition.stakePerDraw * definition.count,
      { label: definition.label, plan: definition.plan, totalStake: definition.ticket.total_stake_minor });
    const retry = runHarness(["multi-draw", definition.purchaseId, definition.ticket.ticket_id,
      String(definition.count), String(definition.stakePerDraw),
      ...(definition.quickPickKey ? [definition.quickPickKey] : [])]);
    check(`${definition.label} binding retry is idempotent`, retry.duplicate &&
      retry.canonicalPlanHash === definition.plan.canonicalPlanHash, { retry });
  }

  const bindingEvidence = (await pool.query(`
select purchase.purchase_id,purchase.draw_count,purchase.stake_per_draw_minor,
  purchase.total_reservation_minor,count(distinct binding.binding_id)::int bindings,
  count(participation.participation_id)::int participations,
  sum(participation.allocated_stake_minor)::bigint allocated,
  bool_and(item.normalized_selections->>'multiDrawCount'=purchase.draw_count::text) exact_count
from game_engine.hot_spot_multi_draw_purchases purchase
join game_engine.hot_spot_multi_draw_bindings binding on binding.purchase_id=purchase.purchase_id
join game_engine.hot_spot_multi_draw_participations participation on participation.binding_id=binding.binding_id
join ticket_authority.ticket_items item on item.ticket_item_id=participation.ticket_item_id
where purchase.purchase_id=any($1::uuid[])
group by purchase.purchase_id;
`, [definitions.map((definition) => definition.purchaseId)])).rows;
  check("all plays use one bound sequence with exact per-draw allocations",
    bindingEvidence.length === definitions.length && bindingEvidence.every((row) =>
      row.bindings === row.draw_count && row.participations === row.draw_count *
        definitions.find((definition) => definition.purchaseId === row.purchase_id).items.length &&
      Number(row.allocated) === Number(row.total_reservation_minor) && row.exact_count),
    { bindingEvidence });

  let immutableRejected = false;
  try {
    await pool.query("update game_engine.hot_spot_multi_draw_bindings set draw_id=$2 where purchase_id=$1 and sequence=1", [
      definitions[0].purchaseId, draws[1].drawId,
    ]);
  } catch (error) {
    immutableRejected = /immutable|mutation|update/i.test(String(error));
  }
  check("accepted draw sequence is immutable", immutableRejected);

  // The accepted fixtures retain exact immutable product and draw references. Remove the
  // qualification-only catalog activation before starting the scheduler so it cannot
  // materialize unrelated draws while processing those fixtures.
  await restoreProductActivation();

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  await makeDue([draws[0]]);
  const firstService = await startService(5611, publicKeyPem, privateKeyPem);
  await waitForDrawSettlements(draws[0], 6);
  await stopService(firstService);

  const loadPartialCompletion = async () => (await pool.query(`
select ticket.ticket_id,ticket.status,ticket.lifecycle_state,
  count(completion.completion_id)::int completions
from ticket_authority.tickets ticket
left join ticket_completion_authority.completion_evidence completion on completion.ticket_id=ticket.ticket_id
where ticket.ticket_id=any($1::uuid[])
group by ticket.ticket_id;
`, [definitions.map((definition) => definition.ticket.ticket_id)])).rows;
  const partial = await waitFor("Draw 1 completion evidence reaches the one-draw parent", async () => {
    const rows = await loadPartialCompletion();
    return rows.filter((row) => row.completions === 1).length === 1 ? rows : null;
  });
  const one = definitions.find((definition) => definition.label === "one");
  check("Draw 1 completes only the one-draw parent while later participations remain pending",
    partial.find((row) => row.ticket_id === one.ticket.ticket_id)?.completions === 1 &&
      partial.filter((row) => row.ticket_id !== one.ticket.ticket_id).every((row) => row.completions === 0),
    { partial });

  const cancellationDefinition = definitions.find((definition) => definition.label === "cancel");
  const cancellationKey = `pr04c-cancel:${runId}`;
  const cancellationArgs = ["cancel-future", cancellationDefinition.purchaseId, cancellationKey,
    "AUTHORIZED_FUTURE_ONLY", "qa:pr04c", `pr04c:${runId}:cancel`];
  const cancellation = runHarness(cancellationArgs);
  const cancellationRetry = runHarness(cancellationArgs);
  check("future-only cancellation releases exactly four undrawn allocations once",
    cancellation.cancelledParticipationCount === 4 && cancellation.releasedAmountMinor === 500 &&
      cancellationRetry.duplicate && cancellationRetry.evidenceHash === cancellation.evidenceHash,
    { cancellation, cancellationRetry });
  await waitFor("future cancellation completes the parent from canonical terminal evidence", async () => {
    const row = (await pool.query(`
select reservation.captured_amount,reservation.released_amount,reservation.remaining_exposure,
  count(completion.completion_id)::int completions,completion.cancelled_participation_count
from ticket_authority.tickets ticket
join public.credit_reservations reservation on reservation.id=ticket.reservation_id
left join ticket_completion_authority.completion_evidence completion on completion.ticket_id=ticket.ticket_id
where ticket.ticket_id=$1
group by reservation.id,completion.completion_id;
`, [cancellationDefinition.ticket.ticket_id])).rows[0];
    return Number(row?.captured_amount) === 125 && Number(row?.released_amount) === 500 &&
      Number(row?.remaining_exposure) === 0 && row?.completions === 1 &&
      row?.cancelled_participation_count === 4 ? row : null;
  });

  await makeDue(draws.slice(1));
  const restartA = await startService(5612, publicKeyPem, privateKeyPem);
  const restartB = await startService(5613, publicKeyPem, privateKeyPem);
  const expectedByDraw = draws.map((_, index) => definitions.reduce((sum, definition) =>
    sum + (index < definition.count && definition.label !== "cancel" ? definition.items.length : 0), 0));
  for (let index = 1; index < draws.length; index += 1) {
    await waitForDrawSettlements(draws[index], expectedByDraw[index]);
  }
  await stopService(restartA);
  await stopService(restartB);

  await waitFor("all non-cancelled parents complete after every bound draw", async () => {
    const row = (await pool.query(`
select count(*) filter (where ticket.status='SETTLED' and ticket.lifecycle_state='REBATE_ELIGIBLE')::int settled,
  count(completion.completion_id)::int completions
from ticket_authority.tickets ticket
left join ticket_completion_authority.completion_evidence completion on completion.ticket_id=ticket.ticket_id
where ticket.ticket_id=any($1::uuid[]);
`, [definitions.map((definition) => definition.ticket.ticket_id)])).rows[0];
    return row.settled === 5 && row.completions === 5 ? row : null;
  });

  const finalEvidence = (await pool.query(`
with selected as (select unnest($1::uuid[]) ticket_id), items as (
  select item.* from ticket_authority.ticket_items item join selected using(ticket_id)
), active as (
  select participation.* from game_engine.hot_spot_multi_draw_participations participation
  join items on items.ticket_item_id=participation.ticket_item_id
  left join game_engine.hot_spot_multi_draw_participation_events cancellation
    on cancellation.participation_id=participation.participation_id and cancellation.event_type='CANCELLED'
  where cancellation.participation_id is null
)
select
  (select count(*)::int from active) active_participations,
  (select count(*)::int from game_engine.hot_spot_multi_draw_participation_events event
    join game_engine.hot_spot_multi_draw_participations participation using(participation_id)
    join items on items.ticket_item_id=participation.ticket_item_id) cancelled_participations,
  (select count(*)::int from game_engine.math_evaluation_events evaluation
    join active on evaluation.ticket_reference=active.ticket_item_id::text) evaluations,
  (select count(*)::int from settlement_service.authoritative_settlement_records settlement
    join active on settlement.ticket_line_id=active.ticket_item_id::text) settlements,
  (select count(*)::int from ticket_completion_authority.completion_sources source
    join active on active.ticket_item_id=source.ticket_item_id) completion_sources,
  (select count(*)::int from (
    select evaluation.ticket_reference from game_engine.math_evaluation_events evaluation
    join active on evaluation.ticket_reference=active.ticket_item_id::text
    group by evaluation.ticket_reference having count(*)>1) duplicate) duplicate_evaluations,
  (select count(*)::int from (
    select settlement.ticket_line_id from settlement_service.authoritative_settlement_records settlement
    join active on settlement.ticket_line_id=active.ticket_item_id::text
    group by settlement.ticket_line_id having count(*)>1) duplicate) duplicate_settlements;
`, [definitions.map((definition) => definition.ticket.ticket_id)])).rows[0];
  check("restart and concurrent fanout preserve one evaluation, settlement, payout, and completion source",
    finalEvidence.active_participations === 42 && finalEvidence.cancelled_participations === 4 &&
      finalEvidence.evaluations === 42 && finalEvidence.settlements === 42 &&
      finalEvidence.completion_sources === 42 && finalEvidence.duplicate_evaluations === 0 &&
      finalEvidence.duplicate_settlements === 0, { finalEvidence });

  const reservations = (await pool.query(`
select ticket.ticket_id,ticket.total_stake_minor,reservation.reserved_amount,
  reservation.captured_amount,reservation.released_amount,reservation.remaining_exposure,
  count(distinct settlement.settlement_id)::int settlements,
  coalesce(sum(distinct_item.stake_minor),0)::bigint settled_stake_minor
from ticket_authority.tickets ticket
join public.credit_reservations reservation on reservation.id=ticket.reservation_id
left join lateral (
  select item.ticket_item_id,item.stake_minor from ticket_authority.ticket_items item
  join settlement_service.authoritative_settlement_records settlement
    on settlement.ticket_line_id=item.ticket_item_id::text
  where item.ticket_id=ticket.ticket_id
) distinct_item on true
left join settlement_service.authoritative_settlement_records settlement
  on settlement.ticket_line_id=distinct_item.ticket_item_id::text
where ticket.ticket_id=any($1::uuid[])
group by ticket.ticket_id,reservation.id;
`, [definitions.map((definition) => definition.ticket.ticket_id)])).rows;
  check("reservation accounting equals stake per draw times bound draw count",
    reservations.every((row) => Number(row.total_stake_minor) === Number(row.reserved_amount) &&
      Number(row.captured_amount) + Number(row.released_amount) === Number(row.reserved_amount) &&
      Number(row.remaining_exposure) === 0 && Number(row.captured_amount) === Number(row.settled_stake_minor)),
    { reservations });

  const invariant = (await pool.query(`
select purchase.purchase_id,
  count(distinct item.normalized_selections->>'quickPickSelectionHash')
    filter (where item.normalized_selections ? 'quickPickSelectionHash')::int quick_pick_hashes,
  count(distinct item.normalized_selections->'numbers')::int number_sets,
  count(distinct item.normalized_selections->>'bullseyePurchased')::int bullseye_modes,
  count(distinct item.stake_minor)::int stake_values
from game_engine.hot_spot_multi_draw_purchases purchase
join game_engine.hot_spot_multi_draw_participations participation on participation.purchase_id=purchase.purchase_id
join ticket_authority.ticket_items item on item.ticket_item_id=participation.ticket_item_id
where purchase.purchase_id=$1
group by purchase.purchase_id;
`, [definitions.find((definition) => definition.label === "twenty").purchaseId])).rows[0];
  check("Quick Pick numbers, Bullseye mode, and stake remain identical across all bound draws",
    invariant.quick_pick_hashes === 1 && invariant.number_sets === 1 &&
      invariant.bullseye_modes === 1 && invariant.stake_values === 1, { invariant });

  await resetQualificationOnly();
  const teardown = (await pool.query(`
select definition.active_version_id,
  (select count(*)::int from game_engine.game_engine_production_activation_events
    where provider_id='mosera-internal-csprng' and provider_version='2.0.0'
      and configuration_version='2' and stage='PRODUCTION_ACTIVE') active_provider_events
from game_engine.game_definitions definition where definition.id=$1;
`, [product.product_id])).rows[0];
  check("qualification activation is fully removed", !teardown.active_version_id &&
    teardown.active_provider_events === 0, { teardown });

  console.log(JSON.stringify({
    status: "PASS", disposition: "PR_04C_HOT_SPOT_MULTI_DRAW_PASS", runId,
    tickets: definitions.map((definition) => ({
      label: definition.label, drawCount: definition.count,
      ticketId: definition.ticket.ticket_id, purchaseId: definition.purchaseId,
    })),
    checks,
  }, null, 2));
} finally {
  for (const service of [...services]) await stopService(service);
  await resetQualificationOnly().catch(() => {});
  await pool.end();
}
