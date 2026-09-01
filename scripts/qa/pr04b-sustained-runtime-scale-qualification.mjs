import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, hostname, loadavg, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const expectedCommit = "8a474adcceda180377f9889ae269835d1b6aac95";
const expectedCsprngHash = "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c";
const csprngPath = "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const gameEngineBasePort = Number(process.env.PR04B_GAME_ENGINE_BASE_PORT ?? 5594);
const settlementUrl = process.env.SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:5400";
const campaignId = process.env.PR04B_CAMPAIGN_ID ??
  `pr04b-${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(4).toString("hex")}`;
const evidenceRoot = process.env.PR04B_EVIDENCE_DIR ?? `.qa/pr-04b/${campaignId}`;
const qualificationApproved = process.env.PR04B_QUALIFICATION_APPROVED === "true";
const productMixFast = boundedNumber("PR04B_FAST_KENO_PERCENT", 80, 70, 85) / 100;
const pool = new Pool({ connectionString: databaseUrl, max: 36, idleTimeoutMillis: 30_000 });
const children = new Map();
const productSnapshot = new Map();
const availabilityIds = [];
const checks = [];
const anomalies = [];
const failureEvidence = [];
const acceptanceLatencies = [];
const readLatencies = [];
const drawLiabilityReady = new Map();
const scopeLiabilityReady = new Map();
const playerLiabilityReady = new Map();
const tierResults = [];
let shuttingDown = false;
let teardownPromise;

const fullTiers = [
  tier("baseline", 100, 30, 1.0, true),
  tier("pilot", 500, 30, 3.0, true),
  tier("elevated", 2000, 60, 6.0, true),
  tier("stress", boundedInteger("PR04B_STRESS_PLAYERS", 5000, 2000, 10000), 10, 12.0, false),
];
const tiers = fullTiers.filter((item) => {
  const selected = process.env.PR04B_TIERS?.split(",").map((value) => value.trim().toLowerCase());
  return !selected?.length || selected.includes(item.name);
});

function tier(name, players, minutes, ticketsPerSecond, claimable) {
  return {
    name,
    players,
    requiredMinutes: minutes,
    minutes: boundedNumber(`PR04B_${name.toUpperCase()}_MINUTES`, minutes, 0.1, 240),
    ticketsPerSecond: boundedNumber(
      `PR04B_${name.toUpperCase()}_TICKETS_PER_SECOND`, ticketsPerSecond, 0.1, 100,
    ),
    claimable,
  };
}

function boundedNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = boundedNumber(name, fallback, minimum, maximum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableIndex(seed, modulus) {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0) % modulus;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)].toFixed(2));
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? Number(Math.max(...values).toFixed(2)) : null,
  };
}

function check(name, passed, evidence = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", evidence, checkedAt: new Date().toISOString() });
  if (!passed) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
}

function anomaly(code, severity, summary, evidence = {}, disposition = "OPEN") {
  anomalies.push({
    anomalyId: `${campaignId}:${String(anomalies.length + 1).padStart(4, "0")}`,
    code,
    severity,
    summary,
    evidence,
    disposition,
    observedAt: new Date().toISOString(),
  });
}

function writeJson(name, value) {
  const path = `${evidenceRoot}/${name}`;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return path;
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.environment },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [name, ...args].join(" "),
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function requireCommand(name, args, options = {}) {
  const result = command(name, args, options);
  if (result.status !== 0) {
    throw new Error(`${result.command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function waitFor(name, probe, timeoutMs = 180_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (shuttingDown) throw new Error("PR-04B qualification was interrupted.");
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function preflight() {
  mkdirSync(evidenceRoot, { recursive: true });
  const db = new URL(databaseUrl);
  const databaseName = db.pathname.slice(1).toLowerCase();
  const head = requireCommand("git", ["rev-parse", "HEAD"]);
  const status = requireCommand("git", ["status", "--porcelain"]);
  const dirty = status.split("\n").filter(Boolean);
  const allowedDirty = [
    "scripts/operations/local-runtime-inventory.mjs",
    "scripts/qa/local-integrated-runtime.mjs",
    "package.json",
    "scripts/qa/pr04-runtime-scale-qualification.mjs",
    "scripts/qa/durable-scheduler-runtime.mjs",
    "scripts/qa/pilot-product-bundle.mjs",
    "docs/architecture/pr-04b-sustained-runtime-scale-qualification.md",
    "scripts/migrations/local/136_repair_scheduler_public_draw_sequence.sql",
    "scripts/migrations/local/137_enforce_pilot_product_ticket_limits.sql",
    "scripts/migrations/local/138_preserve_non_pilot_ticket_lifecycle_compatibility.sql",
    "scripts/migrations/migration-manifest.json",
    "scripts/migrations/validate-local-migrations.mjs",
    "scripts/qa/pr04b-sustained-runtime-scale-qualification.mjs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresDurableSchedulerPersistence.cs",
  ];
  check("explicit PR-04B qualification approval", qualificationApproved);
  check("exact PR-04A baseline", head === expectedCommit, { expectedCommit, head });
  check("disposable local database", /local|test|qa|ci/.test(databaseName), { databaseName });
  check("production deployment excluded",
    (process.env.DEPLOYMENT_ENVIRONMENT ?? "local").toLowerCase() !== "production");
  check("worktree contains only known or PR-04B changes",
    dirty.every((line) => allowedDirty.some((path) => line.endsWith(path))), { dirty });
  const csprngHash = fileHash(csprngPath);
  check("frozen CSPRNG implementation", csprngHash === expectedCsprngHash, { csprngPath, csprngHash });
  check("Settlement service ready", (await fetch(`${settlementUrl}/health/ready`)).ok, { settlementUrl });
  const dbReady = await pool.query("select current_database() database, clock_timestamp() observed_at");
  const products = await loadProducts();
  check("exact immutable pilot products", products.length === 2 && products.every((item) =>
    item.publication_state === "PUBLISHED" && item.activation_state === "INACTIVE" &&
    item.assignment_state === "UNASSIGNED" && item.active_version_id === null), { products });
  const scopes = await loadScopes();
  check("two active tenant/brand qualification scopes available", scopes.length >= 2,
    { scopeCount: scopes.length });
  writeJson("environment.json", {
    schemaVersion: "mosera.pr04b.environment.v1",
    campaignId,
    generatedAt: new Date().toISOString(),
    baselineCommit: head,
    csprngHash,
    database: dbReady.rows[0],
    host: {
      hostname: hostname(), platform: platform(), release: release(), cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? null, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
      loadAverage: loadavg(), node: process.version,
    },
    products,
    scopes: scopes.map(({ platform_id, organization_id, tenant_id, brand_id, market_id, currency }) =>
      ({ platform_id, organization_id, tenant_id, brand_id, market_id, currency })),
    docker: command("docker", ["compose", "ps", "--format", "json"]),
  });
  return { products, scopes: scopes.slice(0, 2), head, csprngHash };
}

async function loadProducts() {
  return (await pool.query(`
select definition.id product_id, definition.code, definition.active_version_id,
  version.id product_version_id, version.version_number, version.definition_hash,
  version.publication_state, version.activation_state, version.assignment_state,
  version.effective_from, version.effective_to, version.game_manifest_id,
  version.game_manifest_hash, version.math_model_definition_id, version.math_model_hash,
  version.paytable_definition_id, version.paytable_version, version.paytable_hash,
  version.evaluator_version, version.outcome_provider_id, version.outcome_provider_version,
  version.provider_configuration_version, version.schedule_version_id,
  schedule.draw_authority_assignment_id, schedule.schedule_hash,
  module.code engine_name, module_version.version engine_version,
  version.product_configuration
from game_engine.game_definitions definition
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
join game_engine.published_draw_schedule_versions schedule on schedule.schedule_version_id=version.schedule_version_id
join game_engine.game_modules module on module.id=definition.game_module_id
join game_engine.game_module_versions module_version
  on module_version.game_module_id=module.id
 and module_version.version=version.product_configuration->>'engineVersion'
where definition.code in ('FAST_KENO_V1','HOT_SPOT_V1')
order by definition.code,version.version_number desc;
`)).rows;
}

async function loadScopes() {
  return (await pool.query(`
select platform.id platform_id,organization.id organization_id,tenant.id tenant_id,
  brand.id brand_id,market.id market_id,market.currency
from platform.markets market
join platform.brands brand on brand.id=market.brand_id and brand.status='Active'
join platform.tenants tenant on tenant.id=brand.tenant_id and tenant.status='Active'
join platform.organizations organization on organization.id=tenant.organization_id and organization.status='Active'
join platform.platforms platform on platform.id=organization.platform_id and platform.status='Active'
where market.status='Active'
order by tenant.created_at,brand.created_at,market.created_at;
`)).rows;
}

async function activateQualification(products, scopes) {
  for (const product of products) productSnapshot.set(product.product_id, {
    activeVersionId: product.active_version_id,
    activationState: product.activation_state,
    assignmentState: product.assignment_state,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role=replica");
    for (const product of products) {
      await client.query(`
update game_engine.game_definition_versions
set activation_state='ACTIVE',assignment_state='ASSIGNED'
where id=$1`, [product.product_version_id]);
      await client.query("update game_engine.game_definitions set active_version_id=$2 where id=$1",
        [product.product_id, product.product_version_id]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  for (const stage of ["REGISTERED", "READY", "APPROVED", "PRODUCTION_ACTIVE"]) {
    await pool.query(`
insert into game_engine.game_engine_production_activation_events(
  activation_event_id,provider_id,provider_version,configuration_version,stage,
  actor_reference,reason_code,approval_reference,signing_provider_id,
  signing_provider_version,signing_key_version,canonical_request_hash,
  evidence_hash,idempotency_key,created_at)
values($1,'mosera-internal-csprng','2.0.0','2',$2,'qa:pr04b',
  'PR04B_QUALIFICATION_ONLY','qa:pr04b-approved','mosera-software-signing',
  '1.0.0','key-v1',$3,$4,$5,clock_timestamp())`, [
      randomUUID(), stage, hash(`pr04b-provider:${campaignId}:${stage}`),
      hash(`pr04b-provider-evidence:${campaignId}:${stage}`),
      `pr04b-provider:${campaignId}:${stage}`,
    ]);
  }
  for (const scope of scopes) {
    for (const product of products) {
      const id = randomUUID();
      availabilityIds.push(id);
      await pool.query(`
insert into platform.game_availability(
  id,tenant_id,brand_id,market_id,game_id,game_code,game_manifest_reference,
  status,effective_from,version,content_hash,audit_metadata,lifecycle_reason,lifecycle_operator)
values($1,$2,$3,$4,$5,$6,$7,'Active',clock_timestamp()-interval '1 second',$8,$9,$10::jsonb,
  'PR04B_QUALIFICATION_ONLY','qa:pr04b')`, [
        id, scope.tenant_id, scope.brand_id, scope.market_id, product.product_id,
        product.code.toLowerCase(), product.game_manifest_id, campaignId,
        hash(`pr04b-availability:${campaignId}:${scope.tenant_id}:${product.code}`),
        JSON.stringify({ campaignId, qualificationOnly: true }),
      ]);
    }
  }
}

async function restoreQualification() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role=replica");
    for (const [productId, snapshot] of productSnapshot) {
      await client.query(`
update game_engine.game_definition_versions
set activation_state=$2,assignment_state=$3
where game_definition_id=$1`, [productId, snapshot.activationState, snapshot.assignmentState]);
      await client.query("update game_engine.game_definitions set active_version_id=$2 where id=$1",
        [productId, snapshot.activeVersionId]);
    }
    if (availabilityIds.length) {
      await client.query("delete from platform.game_availability where id=any($1::uuid[])", [availabilityIds]);
    }
    await client.query(`
delete from game_engine.game_engine_production_activation_events
where reason_code='PR04B_QUALIFICATION_ONLY'
  and idempotency_key like $1`, [`pr04b-provider:${campaignId}:%`]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    anomaly("QUALIFICATION_TEARDOWN_FAILED", "CRITICAL", "Qualification activation teardown failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

async function createPopulation(scopes, count) {
  const population = [];
  const hierarchyByScope = new Map();
  for (const scope of scopes) {
    const hierarchy = { superId: randomUUID(), masterId: randomUUID(), agentId: randomUUID() };
    hierarchyByScope.set(scope.tenant_id, hierarchy);
    for (const [id, type, parent] of [
      [hierarchy.superId, "SUPER_MASTER", null],
      [hierarchy.masterId, "MASTER_AGENT", hierarchy.superId],
      [hierarchy.agentId, "AGENT", hierarchy.masterId],
    ]) {
      await pool.query(`
insert into public.accounts(
  id,account_type,account_code,display_name,parent_account_id,canonical_tenant_id,
  canonical_brand_id,canonical_market_id,status,governance_managed,idempotency_key,canonical_request_hash)
values($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',true,$9,$10)`, [
        id, type, `pr04b-${campaignId.slice(-8)}-${type.toLowerCase()}-${id.slice(0, 5)}`,
        `PR-04B ${type}`, parent, scope.tenant_id, scope.brand_id, scope.market_id,
        `pr04b-account:${campaignId}:${id}`, hash(`pr04b-account:${campaignId}:${id}`),
      ]);
    }
  }
  for (let offset = 0; offset < count; offset += 250) {
    const batchSize = Math.min(250, count - offset);
    const batch = Array.from({ length: batchSize }, (_, batchIndex) => {
      const index = offset + batchIndex;
      const scope = scopes[index % scopes.length];
      const cohortRoll = stableIndex(`${campaignId}:cohort:${index}`, 100);
      const cohort = cohortRoll < 72 ? "LIGHT" : cohortRoll < 91 ? "ACTIVE" : cohortRoll < 98 ? "HIGH" : "BURST";
      return {
        index, scope, cohort, accountId: randomUUID(), profileId: randomUUID(), walletId: randomUUID(),
        parentId: hierarchyByScope.get(scope.tenant_id).agentId,
      };
    });
    await pool.query(`
insert into public.accounts(
  id,account_type,account_code,display_name,parent_account_id,canonical_tenant_id,
  canonical_brand_id,canonical_market_id,status,governance_managed,idempotency_key,canonical_request_hash)
select id,'PLAYER','pr04b-' || $1 || '-' || ordinal::text,'PR-04B Player ' || ordinal::text,
  parent_id,tenant_id,brand_id,market_id,'ACTIVE',true,
  'pr04b-player:' || $1 || ':' || id::text,'sha256:' || encode(digest('pr04b-player:' || $1 || ':' || id::text,'sha256'),'hex')
from unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[],$6::uuid[]) with ordinality
  as source(id,parent_id,tenant_id,brand_id,market_id,ordinal)`, [campaignId,
      batch.map((item) => item.accountId), batch.map((item) => item.parentId),
      batch.map((item) => item.scope.tenant_id), batch.map((item) => item.scope.brand_id),
      batch.map((item) => item.scope.market_id)]);
    await pool.query(`
insert into public.player_profiles(id,account_id,display_name,status)
select profile_id,account_id,'PR-04B Player ' || ordinal::text,'ACTIVE'
from unnest($1::uuid[],$2::uuid[]) with ordinality as source(profile_id,account_id,ordinal)`, [
      batch.map((item) => item.profileId), batch.map((item) => item.accountId),
    ]);
    await pool.query(`
insert into public.financial_wallets(
  id,account_id,wallet_type,currency_code,balance_authority,status,balance,credit_limit,funding_model)
select wallet_id,account_id,'CREDIT',currency,'INTERNAL','ACTIVE',0,credit_limit,'CREDIT'
from unnest($1::uuid[],$2::uuid[],$3::text[],$4::numeric[])
  as source(wallet_id,account_id,currency,credit_limit)`, [
      batch.map((item) => item.walletId), batch.map((item) => item.accountId),
      batch.map((item) => item.scope.currency),
      batch.map((item) => item.cohort === "LIGHT" ? 100_000_000 : item.cohort === "ACTIVE" ? 500_000_000 : 5_000_000_000),
    ]);
    await pool.query(`
insert into credit_wallet_service.wallet_scopes(
  wallet_id,tenant_id,brand_id,player_id,instrument_code,currency,authority)
select wallet_id,tenant_id,brand_id,player_id,'CREDIT',currency,'CREDIT_WALLET_SERVICE'
from unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::uuid[],$5::text[])
  as source(wallet_id,tenant_id,brand_id,player_id,currency)`, [
      batch.map((item) => item.walletId), batch.map((item) => item.scope.tenant_id),
      batch.map((item) => item.scope.brand_id), batch.map((item) => item.accountId),
      batch.map((item) => item.scope.currency),
    ]);
    population.push(...batch);
  }
  writeJson("workload.json", {
    schemaVersion: "mosera.pr04b.workload.v1", campaignId, productMix: { fastKeno: productMixFast, hotSpot: 1 - productMixFast },
    cohortDistribution: population.reduce((result, player) => {
      result[player.cohort] = (result[player.cohort] ?? 0) + 1;
      return result;
    }, {}),
    playerCount: population.length,
    tenantCount: new Set(population.map((item) => item.scope.tenant_id)).size,
    brandCount: new Set(population.map((item) => item.scope.brand_id)).size,
    tiers,
  });
  return { population, hierarchyByScope };
}

async function insertLiabilityConfiguration(scope, scopeType, scopeReference) {
  const key = `${scope.tenant_id}:${scope.brand_id}:${scopeType}:${String(scopeReference).toLowerCase()}`;
  if (scopeLiabilityReady.has(key)) return scopeLiabilityReady.get(key);
  const work = pool.query(`
with prior as (
  select configuration_id,version from ticket_authority.liability_limit_configurations
  where tenant_id=$1 and brand_id=$2 and scope_type=$3 and scope_reference=$4
  order by version desc limit 1
)
insert into ticket_authority.liability_limit_configurations(
  configuration_id,tenant_id,brand_id,scope_type,scope_reference,
  maximum_wager_minor,maximum_theoretical_payout_minor,maximum_exposure_minor,
  status,effective_from,version,supersedes_configuration_id,content_hash,audit_metadata)
select $5,$1,$2,$3,$4,10000000000,1000000000000,100000000000000,'Active',
  clock_timestamp()-interval '1 millisecond',coalesce(prior.version,0)+1,prior.configuration_id,$6,$7::jsonb
from (select 1) seed left join prior on true`, [
    scope.tenant_id, scope.brand_id, scopeType, String(scopeReference).toLowerCase(), randomUUID(),
    hash(`pr04b-liability:${campaignId}:${key}`), JSON.stringify({ campaignId, qualificationOnly: true }),
  ]);
  scopeLiabilityReady.set(key, work);
  try {
    await work;
  } catch (error) {
    scopeLiabilityReady.delete(key);
    throw error;
  }
}

async function ensurePlayerLiability(player) {
  if (playerLiabilityReady.has(player.accountId)) return playerLiabilityReady.get(player.accountId);
  const work = insertLiabilityConfiguration(player.scope, "PLAYER", player.accountId);
  playerLiabilityReady.set(player.accountId, work);
  try {
    await work;
  } catch (error) {
    playerLiabilityReady.delete(player.accountId);
    throw error;
  }
}

async function ensureDrawLiability(draw, product, player, hierarchyByScope) {
  const hierarchy = hierarchyByScope.get(player.scope.tenant_id);
  const key = `${draw.draw_id}:${player.scope.tenant_id}`;
  if (drawLiabilityReady.has(key)) return drawLiabilityReady.get(key);
  const work = (async () => {
    for (const [scopeType, reference] of [
      ["TENANT", player.scope.tenant_id], ["MASTER_AGENT", hierarchy.masterId],
      ["AGENT", hierarchy.agentId], ["DRAW", draw.draw_id], ["PRODUCT", product.product_id],
      ["GAME", product.code.toLowerCase()],
    ]) await insertLiabilityConfiguration(player.scope, scopeType, reference);
  })();
  drawLiabilityReady.set(key, work);
  try {
    await work;
  } catch (error) {
    drawLiabilityReady.delete(key);
    throw error;
  }
}

async function startGameEngine(instance, publicKeyPem, privateKeyPem, failureStage = "") {
  const port = gameEngineBasePort + instance;
  const logPath = `${evidenceRoot}/game-engine-${instance}-${failureStage || "normal"}.log`;
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn("dotnet", [
    "run", "--no-build", "--no-launch-profile", "--project",
    "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      RABBITMQ_URL: process.env.RABBITMQ_URL ?? "amqp://lottery:lottery_dev_password@127.0.0.1:5672",
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
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
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_PAGE_SIZE: "250",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_CONCURRENCY: "8",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_FAILURE_STAGE: failureStage,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.set(instance, { child, log, port, publicKeyPem, privateKeyPem });
  await waitFor(`Game Engine instance ${instance}`, async () => {
    if (child.exitCode !== null) throw new Error(`Game Engine ${instance} exited ${child.exitCode}.`);
    const response = await fetch(`http://127.0.0.1:${port}/health/live`).catch(() => null);
    return response?.ok ? { port, status: response.status } : null;
  }, 90_000);
  return child;
}

async function stopGameEngine(instance) {
  const registration = children.get(instance);
  if (!registration) return;
  const { child, log } = registration;
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  log.end();
  children.delete(instance);
}

async function restartGameEngine(instance) {
  const registration = children.get(instance);
  if (!registration) throw new Error(`Game Engine ${instance} is not running.`);
  const { publicKeyPem, privateKeyPem } = registration;
  const started = new Date().toISOString();
  await stopGameEngine(instance);
  await sleep(2_000);
  await startGameEngine(instance, publicKeyPem, privateKeyPem);
  failureEvidence.push({ type: "GAME_ENGINE_INSTANCE_RESTART", instance, started, recoveredAt: new Date().toISOString() });
}

async function acceptingDraw(productCode) {
  return (await pool.query(`
select draw_id,product_id,product_version_id,product_code,public_draw_number,
  cutoff_at,scheduled_execution_at,draw_identity_hash,scheduler_state
from game_engine.durable_scheduler_draws
where product_code=$1 and scheduler_state='Accepting' and cutoff_at > clock_timestamp()
order by scheduled_execution_at limit 1`, [productCode])).rows[0] ?? null;
}

async function waitForAcceptingDraws() {
  return waitFor("both pilot products have accepting draws", async () => {
    const fast = await acceptingDraw("FAST_KENO_V1");
    const hot = await acceptingDraw("HOT_SPOT_V1");
    return fast && hot ? { fast, hot } : null;
  }, 180_000, 500);
}

const fastMarkets = [
  ["KenoBigSmall", "BIG", 72000], ["KenoBigSmall", "SMALL", 72000],
  ["KenoOddEven", "ODD", 72000], ["KenoOddEven", "EVEN", 72000],
  ["KenoDragonTiger", "DRAGON", 72000], ["KenoDragonTiger", "TIGER", 72000],
  ["KenoDragonTiger", "DT_TIE", 9000], ["KenoUpDown", "UP", 55400],
  ["KenoUpDown", "DOWN", 55400], ["KenoUpDown", "UD_TIE", 21800],
  ["KenoParlay", "BIG_ODD", 26700], ["KenoParlay", "BIG_EVEN", 26700],
  ["KenoParlay", "SMALL_ODD", 26700], ["KenoParlay", "SMALL_EVEN", 26700],
  ["KenoElement", "GOLD", 8800], ["KenoElement", "WOOD", 20000],
  ["KenoElement", "WATER", 51400], ["KenoElement", "FIRE", 20000],
  ["KenoElement", "EARTH", 8800],
];

function skewedStake(minimum, maximum, seed, exactMaximum = false) {
  if (exactMaximum) return maximum;
  const unit = stableIndex(seed, 10_000) / 10_000;
  return Math.max(minimum, Math.floor((minimum + (maximum - minimum) * unit ** 3) / 100) * 100);
}

function fastItems(seed) {
  const countRoll = stableIndex(`${seed}:count`, 100);
  const count = countRoll < 50 ? 1 : countRoll < 83 ? 2 + stableIndex(`${seed}:medium`, 4) :
    countRoll < 98 ? 6 + stableIndex(`${seed}:high`, 5) : 18 + stableIndex(`${seed}:max`, 3);
  const start = stableIndex(`${seed}:start`, fastMarkets.length);
  return Array.from({ length: count }, (_, index) => {
    const [wagerType, selection, maximum] = fastMarkets[(start + index * 7) % fastMarkets.length];
    return {
      wagerType,
      wagerVersion: "1.0.0",
      selections: { numbers: [1], selection },
      stakeMinor: skewedStake(200, maximum, `${seed}:stake:${index}`, stableIndex(`${seed}:exact:${index}`, 100) === 0),
    };
  });
}

function uniqueNumbers(count, seed) {
  const values = Array.from({ length: 80 }, (_, index) => index + 1);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = stableIndex(`${seed}:${index}`, index + 1);
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values.slice(0, count).sort((left, right) => left - right);
}

function hotSpotItems(seed) {
  const countRoll = stableIndex(`${seed}:plays`, 100);
  const count = countRoll < 65 ? 1 : countRoll < 90 ? 2 + stableIndex(`${seed}:normal`, 3) :
    countRoll < 99 ? 5 + stableIndex(`${seed}:high`, 4) : 10;
  return Array.from({ length: count }, (_, index) => {
    const spotCount = 1 + stableIndex(`${seed}:spots:${index}`, 10);
    const stakeMinor = 100 * (1 + stableIndex(`${seed}:stake:${index}`, 20));
    return {
      wagerType: "KenoSpot",
      wagerVersion: "1.0.0",
      selections: {
        numbers: uniqueNumbers(spotCount, `${seed}:numbers:${index}`),
        bullseyePurchased: stableIndex(`${seed}:bullseye:${index}`, 100) < 35,
      },
      stakeMinor,
    };
  });
}

async function acceptTicket({ tierName, sequence, product, draw, player, items, hierarchyByScope }) {
  await ensurePlayerLiability(player);
  await ensureDrawLiability(draw, product, player, hierarchyByScope);
  const idempotencyKey = `pr04b-ticket:${campaignId}:${tierName}:${sequence}`;
  const started = performance.now();
  try {
    const result = (await pool.query(`
select ticket_authority.accept_ticket(
  $1,$2,'CREDIT',$3,$4,$5,$6,$7,null,$8,$9,$10::jsonb,$11,$12,$13,'qa:pr04b','PR04B'
) result`, [
      player.accountId, player.profileId, player.walletId, product.product_id,
      product.game_manifest_id, product.paytable_definition_id, draw.draw_id,
      `pr04b-${campaignId}-${tierName}-${sequence}`, player.scope.currency, JSON.stringify(items),
      idempotencyKey, `pr04b:${campaignId}:${tierName}:${sequence}`, `draw:${draw.draw_id}`,
    ])).rows[0].result;
    acceptanceLatencies.push(performance.now() - started);
    return { ...result, productCode: product.code, drawId: draw.draw_id, playerId: player.accountId, idempotencyKey };
  } catch (error) {
    acceptanceLatencies.push(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    return { accepted: false, error: message, productCode: product.code, drawId: draw.draw_id, playerId: player.accountId };
  }
}

async function resourceSnapshot(tierName) {
  const observedAt = new Date().toISOString();
  const scheduler = (await pool.query("select * from game_engine.durable_scheduler_operational_status order by product_code")).rows;
  const database = (await pool.query(`
select count(*)::int total,count(*) filter(where state='active')::int active,
  count(*) filter(where wait_event_type='Lock')::int lock_waiters
from pg_stat_activity where datname=current_database()`)).rows[0];
  let rabbit = { unavailable: true };
  try {
    const response = await fetch("http://127.0.0.1:15672/api/queues", {
      headers: { authorization: `Basic ${Buffer.from("lottery:lottery_dev_password").toString("base64")}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) rabbit = (await response.json()).map((queue) => ({
      name: queue.name, messages: queue.messages, ready: queue.messages_ready,
      unacknowledged: queue.messages_unacknowledged, consumers: queue.consumers,
    }));
  } catch (error) {
    rabbit = { error: error instanceof Error ? error.message : String(error) };
  }
  const docker = command("docker", ["stats", "--no-stream", "--format", "{{json .}}"]);
  const snapshot = { tierName, observedAt, scheduler, database, rabbit, docker, host: { freeMemoryBytes: freemem(), loadAverage: loadavg() } };
  appendFileSync(`${evidenceRoot}/metrics.jsonl`, `${JSON.stringify(snapshot)}\n`);
  return snapshot;
}

async function readTraffic() {
  const started = performance.now();
  await Promise.all([
    pool.query("select * from game_engine.durable_scheduler_operational_status order by product_code"),
    pool.query("select product_code,public_draw_number,scheduled_execution_at,scheduler_state from game_engine.durable_scheduler_draws order by scheduled_execution_at desc limit 20"),
    pool.query("select ticket_id,status,lifecycle_state,accepted_at from ticket_authority.tickets where sales_channel='PR04B' order by accepted_at desc limit 20"),
    pool.query("select id wallet_id,balance,credit_limit from public.financial_wallets where account_id in (select player_account_id from ticket_authority.tickets where sales_channel='PR04B') limit 20"),
  ]);
  readLatencies.push(performance.now() - started);
}

function classifyError(message) {
  if (/draw does not permit ticket acceptance/i.test(message)) return "CUTOFF_OR_STALE_DRAW";
  if (/insufficient|credit limit|fund/i.test(message)) return "INSUFFICIENT_FUNDS";
  if (/maximum|minimum|limit/i.test(message)) return "LIMIT_REJECTION";
  if (/idempotency.*conflict/i.test(message)) return "IDEMPOTENCY_CONFLICT";
  return "TRANSIENT_OR_UNKNOWN";
}

async function runTier(tierConfig, products, population, hierarchyByScope) {
  const startedAt = new Date();
  const acceptanceLatencyStart = acceptanceLatencies.length;
  const readLatencyStart = readLatencies.length;
  const deadline = Date.now() + tierConfig.minutes * 60_000;
  const players = population.slice(0, tierConfig.players);
  const counters = { attempted: 0, accepted: 0, duplicates: 0, errors: {}, fastKeno: 0, hotSpot: 0, reads: 0 };
  const acceptedTicketIds = [];
  const productByCode = Object.fromEntries(products.map((item) => [item.code, item]));
  let sequence = 0;
  let lastMetricAt = 0;
  let lastReadAt = 0;
  let nextIssueAt = performance.now();
  let elevatedFailureStage = 0;
  const quickPick = await createCanonicalQuickPickTicket(
    tierConfig, products, players[stableIndex(`${campaignId}:${tierConfig.name}:quick-pick-player`, players.length)],
    hierarchyByScope,
  );
  counters.attempted += 1;
  if (quickPick.accepted) {
    counters.accepted += 1;
    counters.hotSpot += 1;
    acceptedTicketIds.push(quickPick.ticketId);
  } else {
    counters.errors.QUICK_PICK = 1;
  }
  while (Date.now() < deadline) {
    const now = performance.now();
    const elapsedFraction = 1 - (deadline - Date.now()) / (tierConfig.minutes * 60_000);
    if (now >= nextIssueAt) {
      const batchSize = Math.min(24, 1 + Math.floor((now - nextIssueAt) * tierConfig.ticketsPerSecond / 1000));
      const requests = [];
      for (let index = 0; index < batchSize; index += 1) {
        sequence += 1;
        const fast = stableIndex(`${campaignId}:${tierConfig.name}:mix:${sequence}`, 10_000) < productMixFast * 10_000;
        const code = fast ? "FAST_KENO_V1" : "HOT_SPOT_V1";
        const draw = await acceptingDraw(code);
        if (!draw) {
          counters.errors.NO_ACCEPTING_DRAW = (counters.errors.NO_ACCEPTING_DRAW ?? 0) + 1;
          continue;
        }
        const player = players[stableIndex(`${campaignId}:${tierConfig.name}:player:${sequence}`, players.length)];
        const items = fast ? fastItems(`${campaignId}:${tierConfig.name}:${sequence}`) : hotSpotItems(`${campaignId}:${tierConfig.name}:${sequence}`);
        requests.push(acceptTicket({ tierName: tierConfig.name, sequence, product: productByCode[code], draw, player, items, hierarchyByScope }));
      }
      const results = await Promise.all(requests);
      for (const result of results) {
        counters.attempted += 1;
        if (result.accepted) {
          counters.accepted += 1;
          counters[result.productCode === "FAST_KENO_V1" ? "fastKeno" : "hotSpot"] += 1;
          if (result.duplicate) counters.duplicates += 1;
          if (result.ticketId) acceptedTicketIds.push(result.ticketId);
        } else {
          const classification = classifyError(result.error ?? "unknown");
          counters.errors[classification] = (counters.errors[classification] ?? 0) + 1;
          if (classification === "TRANSIENT_OR_UNKNOWN") {
            anomaly("TICKET_ACCEPTANCE_ERROR", "MEDIUM", "Ticket acceptance returned an unclassified error.", result);
          }
        }
      }
      const jitter = 0.75 + stableIndex(`${campaignId}:jitter:${tierConfig.name}:${sequence}`, 5000) / 10_000;
      nextIssueAt = performance.now() + 1000 / tierConfig.ticketsPerSecond * jitter;
    }
    if (now - lastReadAt > 1_000) {
      await readTraffic();
      counters.reads += 4;
      lastReadAt = now;
    }
    if (now - lastMetricAt > 5_000) {
      await resourceSnapshot(tierConfig.name);
      lastMetricAt = now;
    }
    if (tierConfig.name === "elevated" && process.env.PR04B_FAILURE_INJECTION !== "false") {
      if (elevatedFailureStage === 0 && elapsedFraction >= 0.25) {
        await restartGameEngine(0);
        elevatedFailureStage = 1;
      } else if (elevatedFailureStage === 1 && elapsedFraction >= 0.50) {
        const started = new Date().toISOString();
        requireCommand("docker", ["compose", "restart", "worker-settlement"]);
        failureEvidence.push({ type: "SETTLEMENT_WORKER_RESTART", started, recoveredAt: new Date().toISOString() });
        elevatedFailureStage = 2;
      } else if (elevatedFailureStage === 2 && elapsedFraction >= 0.75) {
        const started = new Date().toISOString();
        requireCommand("docker", ["compose", "restart", "rabbitmq"]);
        await waitFor("RabbitMQ recovers", async () => {
          const result = command("docker", ["compose", "exec", "-T", "rabbitmq", "rabbitmq-diagnostics", "-q", "ping"]);
          return result.status === 0;
        }, 120_000, 2_000);
        failureEvidence.push({ type: "RABBITMQ_RESTART", started, recoveredAt: new Date().toISOString() });
        elevatedFailureStage = 3;
      }
    }
    await sleep(20);
  }
  const completed = await waitForTierCompletion(startedAt, acceptedTicketIds, Math.max(300_000, tierConfig.players * 250));
  const evidence = await collectTierEvidence(
    tierConfig, startedAt, new Date(), counters, completed,
    acceptanceLatencies.slice(acceptanceLatencyStart), readLatencies.slice(readLatencyStart), quickPick,
  );
  writeJson(`campaign-${tierConfig.name}.json`, evidence);
  tierResults.push(evidence);
  return evidence;
}

function runHotSpotEvidence(args) {
  const output = requireCommand("dotnet", [
    "run", "--no-build", "--project",
    "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
    "--", "pr04a-hot-spot-evidence", ...args,
  ], { environment: { DATABASE_URL: databaseUrl } });
  return JSON.parse(output.split("\n").filter(Boolean).at(-1));
}

async function createCanonicalQuickPickTicket(tierConfig, products, player, hierarchyByScope) {
  const product = products.find((item) => item.code === "HOT_SPOT_V1");
  const draw = await acceptingDraw("HOT_SPOT_V1");
  if (!draw) return { accepted: false, error: "No accepting Hot Spot draw for canonical Quick Pick." };
  const sequence = `quick-pick-${randomUUID()}`;
  const key = `pr04b-quick-pick:${campaignId}:${tierConfig.name}`;
  const drawCount = ({ baseline: 5, pilot: 10, elevated: 20, stress: 1 })[tierConfig.name] ?? 5;
  const requestId = randomUUID();
  const selection = runHotSpotEvidence([
    "quick-pick", requestId, key, String(1 + stableIndex(key, 10)), product.definition_hash, "qa:pr04b",
  ]);
  const result = await acceptTicket({
    tierName: tierConfig.name,
    sequence,
    product,
    draw,
    player,
    items: [{
      wagerType: "KenoSpot", wagerVersion: "1.0.0",
      selections: {
        numbers: selection.numbers,
        bullseyePurchased: true,
        quickPickSelectionId: selection.selectionId,
        multiDrawCount: drawCount,
      },
      stakeMinor: 100,
    }],
    hierarchyByScope,
  });
  if (!result.accepted) return { ...result, selection };
  let multiDraw;
  try {
    multiDraw = runHotSpotEvidence([
      "multi-draw", randomUUID(), result.ticketId, String(drawCount), "100", key,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    multiDraw = { status: "BLOCKED", drawCount, stakePerDrawMinor: 100, error: message };
    anomaly(
      "HOT_SPOT_MULTI_DRAW_CANONICAL_RESERVATION_BLOCKED",
      "HIGH",
      "Canonical Hot Spot multi-draw cannot bind because ticket acceptance reserved only the first draw and no per-draw execution fanout exists.",
      multiDraw,
    );
  }
  return { ...result, selection, multiDraw };
}

async function waitForTierCompletion(startedAt, ticketIds, timeoutMs) {
  if (!ticketIds.length) return { completed: 0, expected: 0, timeout: false };
  try {
    return await waitFor("tier financial completion", async () => {
      const row = (await pool.query(`
select count(*)::int expected,
  count(completion.completion_id)::int completed,
  count(*) filter(where ticket.status='SETTLED' and ticket.lifecycle_state='REBATE_ELIGIBLE')::int terminal
from ticket_authority.tickets ticket
left join ticket_completion_authority.completion_evidence completion on completion.ticket_id=ticket.ticket_id
where ticket.ticket_id=any($1::uuid[])`, [ticketIds])).rows[0];
      return row.completed === row.expected && row.terminal === row.expected ? { ...row, timeout: false } : null;
    }, timeoutMs, 1_000);
  } catch (error) {
    anomaly("FINANCIAL_COMPLETION_TIMEOUT", "HIGH", "Tier did not clear financial completion before timeout.", {
      startedAt, ticketCount: ticketIds.length, error: error instanceof Error ? error.message : String(error),
    });
    return { completed: 0, expected: ticketIds.length, timeout: true };
  }
}

async function collectTierEvidence(
  tierConfig, startedAt, endedAt, counters, completed, tierAcceptanceLatencies, tierReadLatencies, quickPick,
) {
  const prefix = `pr04b-${campaignId}-${tierConfig.name}-%`;
  const chain = (await pool.query(`
with campaign_tickets as (
  select * from ticket_authority.tickets where external_ticket_id like $1
), campaign_items as (
  select item.* from ticket_authority.ticket_items item join campaign_tickets ticket using(ticket_id)
), campaign_draws as (
  select distinct draw.* from game_engine.durable_scheduler_draws draw
  join campaign_tickets ticket using(draw_id)
), campaign_requests as (
  select request.* from game_engine.outcome_settlement_requests request join campaign_draws draw using(draw_id)
)
select
  (select count(*)::int from campaign_tickets) tickets,
  (select count(*)::int from campaign_items) items,
  (select count(*)::int from campaign_draws) draws,
  (select count(*)::int from campaign_draws where product_code='FAST_KENO_V1') fast_draws,
  (select count(*)::int from campaign_draws where product_code='HOT_SPOT_V1') hot_draws,
  (select count(*)::int from campaign_draws where authoritative_result_at is not null) outcomes,
  (select count(*)::int from game_engine.math_evaluation_certificates certificate
    join campaign_items item on item.ticket_item_id::text=certificate.ticket_reference) math_certificates,
  (select count(*)::int from game_engine.settlement_input_records input
    join campaign_items item on item.ticket_item_id::text=input.ticket_reference) settlement_inputs,
  (select count(*)::int from campaign_requests) settlement_requests,
  (select count(*)::int from settlement_service.authoritative_settlement_records record
    join campaign_requests request using(settlement_request_id)) settlements,
  (select count(*)::int from ticket_completion_authority.completion_evidence completion
    join campaign_tickets ticket using(ticket_id)) completions,
  (select count(*)::int from public.credit_reservations reservation
    join campaign_tickets ticket on ticket.reservation_id=reservation.id
    where reservation.remaining_exposure=0 and reservation.status='CAPTURED') closed_reservations,
  (select count(*)::int from (select execution_manifest_id from game_engine.outcome_events
    where execution_manifest_id in (select execution_manifest_id from game_engine.draw_execution_manifests manifest join campaign_draws draw using(draw_id))
    group by execution_manifest_id having count(*)>1) duplicate) duplicate_outcomes,
  (select count(*)::int from (select settlement_request_id from settlement_service.authoritative_settlement_records
    where settlement_request_id in (select settlement_request_id from campaign_requests)
    group by settlement_request_id having count(*)>1) duplicate) duplicate_settlements,
  (select count(*)::int from (select source.ticket_item_id from ticket_completion_authority.completion_sources source
    join campaign_items item using(ticket_item_id) group by source.ticket_item_id having count(*)>1) duplicate) duplicate_completion_sources,
  (select count(*)::int from campaign_tickets ticket join public.credit_reservations reservation on reservation.id=ticket.reservation_id
    where reservation.player_id<>ticket.player_account_id) cross_player_contamination
`, [prefix])).rows[0];
  const latencyRows = (await pool.query(`
select extract(epoch from (max(wallet.occurred_at)-result.occurred_at))*1000 latency
from game_engine.scheduler_settlement_kpi_events result
join game_engine.scheduler_settlement_kpi_events wallet
  on wallet.draw_id=result.draw_id and wallet.event_type='WALLET_AVAILABLE'
join ticket_authority.tickets ticket on ticket.ticket_id=wallet.ticket_id
where result.event_type='AUTHORITATIVE_RESULT' and ticket.external_ticket_id like $1
group by ticket.ticket_id,result.occurred_at`, [prefix])).rows.map((row) => Number(row.latency));
  const drawLatencyRows = (await pool.query(`
select extract(epoch from (authoritative_result_at-scheduled_execution_at))*1000 latency
from game_engine.durable_scheduler_draws draw
where authoritative_result_at is not null and exists(
  select 1 from ticket_authority.tickets ticket where ticket.draw_id=draw.draw_id and ticket.external_ticket_id like $1)`, [prefix])).rows.map((row) => Number(row.latency));
  const cadence = (await pool.query(`
with draws as (
 select product_code,scheduled_execution_at,
   lag(scheduled_execution_at) over(partition by product_code order by scheduled_execution_at) previous_at,
   authoritative_result_at
 from game_engine.durable_scheduler_draws draw
 where exists(select 1 from ticket_authority.tickets ticket where ticket.draw_id=draw.draw_id and ticket.external_ticket_id like $1)
)
select product_code,count(*)::int draws,
  count(*) filter(where authoritative_result_at is null)::int missed,
  max(abs(extract(epoch from (scheduled_execution_at-previous_at)) -
    case when product_code='FAST_KENO_V1' then 25 else 240 end))::float8 maximum_interval_drift_seconds
from draws group by product_code order by product_code`, [prefix])).rows;
  const backlog = (await pool.query("select * from game_engine.durable_scheduler_operational_status order by product_code")).rows;
  return {
    schemaVersion: "mosera.pr04b.tier-result.v1", campaignId, tier: tierConfig.name,
    requiredMinutes: tierConfig.requiredMinutes, actualMinutes: tierConfig.minutes,
    sustainedDurationSatisfied: tierConfig.minutes >= tierConfig.requiredMinutes,
    configuredPlayers: tierConfig.players, startedAt, endedAt, counters, completed, chain, cadence, backlog,
    canonicalQuickPickAndMultiDraw: quickPick,
    acceptanceLatency: latencySummary(tierAcceptanceLatencies),
    resultGenerationLatency: latencySummary(drawLatencyRows),
    resultToWalletLatency: latencySummary(latencyRows),
    readLatency: latencySummary(tierReadLatencies),
    pass: chain.tickets > 0 && chain.tickets === chain.completions && chain.items === chain.settlements &&
      quickPick.accepted && quickPick.multiDraw?.status !== "BLOCKED" &&
      chain.duplicate_outcomes === 0 && chain.duplicate_settlements === 0 &&
      chain.duplicate_completion_sources === 0 && chain.cross_player_contamination === 0 &&
      cadence.every((row) => row.missed === 0 && Number(row.maximum_interval_drift_seconds ?? 0) === 0) &&
      latencySummary(latencyRows).p95Ms !== null && latencySummary(latencyRows).p95Ms < 5_000 &&
      !completed.timeout,
  };
}

async function runNegativeTests(products, player, hierarchyByScope) {
  const results = [];
  const fast = products.find((item) => item.code === "FAST_KENO_V1");
  const draw = await acceptingDraw("FAST_KENO_V1");
  await ensurePlayerLiability(player);
  await ensureDrawLiability(draw, fast, player, hierarchyByScope);
  const cases = [
    ["below-minimum", [{ ...fastItems("negative-min")[0], stakeMinor: 1 }]],
    ["more-than-20-wagers", Array.from({ length: 21 }, (_, index) => fastItems(`negative-count-${index}`)[0])],
  ];
  for (const [name, items] of cases) {
    const result = await acceptTicket({ tierName: `negative-${name}`, sequence: randomUUID(), product: fast, draw, player, items, hierarchyByScope });
    results.push({ name, rejected: !result.accepted, result });
  }
  const staleDraw = (await pool.query(`
select * from game_engine.durable_scheduler_draws where product_code='FAST_KENO_V1'
  and scheduler_state not in ('Accepting') order by scheduled_execution_at desc limit 1`)).rows[0];
  if (staleDraw) {
    const result = await acceptTicket({ tierName: "negative-stale", sequence: randomUUID(), product: fast, draw: staleDraw, player, items: fastItems("negative-stale"), hierarchyByScope });
    results.push({ name: "stale-draw", rejected: !result.accepted, result });
  }
  writeJson("negative-tests.json", { schemaVersion: "mosera.pr04b.negative-tests.v1", campaignId, results });
  return results;
}

async function finalIntegrity(products) {
  const duplicateEffects = (await pool.query(`
select
  (select count(*)::int from (select settlement_request_id from settlement_service.authoritative_settlement_records
    group by settlement_request_id having count(*)>1) duplicate) settlements,
  (select count(*)::int from (select posting_request_id from ledger_service.ledger_transactions
    group by posting_request_id having count(*)>1) duplicate) ledger,
  (select count(*)::int from (select ticket_id from ticket_completion_authority.completion_evidence
    group by ticket_id having count(*)>1) duplicate) completion
`)).rows[0];
  const providerFallback = Number((await pool.query(`
select count(*)::int count from game_engine.draw_execution_manifests manifest
join game_engine.durable_scheduler_draws draw using(draw_id)
where draw.materialized_at >= (select min(accepted_at) from ticket_authority.tickets where sales_channel='PR04B')
  and draw.product_code in ('FAST_KENO_V1','HOT_SPOT_V1')
  and (manifest.outcome_provider_id<>'mosera-internal-csprng' or manifest.outcome_provider_version<>'2.0.0')
`)).rows[0].count);
  const csprngHash = fileHash(csprngPath);
  return { duplicateEffects, providerFallback, csprngHash, products: products.map((item) => item.code) };
}

function buildManifest() {
  const files = readdirSync(evidenceRoot).filter((name) => statSync(`${evidenceRoot}/${name}`).isFile()).sort();
  return files.map((name) => ({ name, bytes: statSync(`${evidenceRoot}/${name}`).size, sha256: fileHash(`${evidenceRoot}/${name}`) }));
}

function reportMarkdown(summary) {
  const rows = summary.tiers.map((item) =>
    `| ${item.tier} | ${item.configuredPlayers} | ${item.actualMinutes} | ${item.chain.tickets} | ${item.chain.items} | ${item.resultToWalletLatency.p95Ms ?? "n/a"} | ${item.pass ? "PASS" : "BLOCKED"} |`).join("\n");
  return `# PR-04B Sustained Runtime Scale Qualification\n\n` +
    `Campaign: \`${campaignId}\`  \nBaseline: \`${expectedCommit}\`  \nStatus: **${summary.status}**\n\n` +
    `| Tier | Players | Minutes | Tickets | Items | Result-to-wallet p95 ms | Result |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | --- |\n${rows}\n\n` +
    `## Integrity\n\n- CSPRNG: \`${summary.integrity.csprngHash}\`\n` +
    `- Provider fallback count: ${summary.integrity.providerFallback}\n` +
    `- Duplicate effects: \`${JSON.stringify(summary.integrity.duplicateEffects)}\`\n\n` +
    `## Anomalies\n\n${summary.anomalies.length ? summary.anomalies.map((item) =>
      `- ${item.severity} ${item.code}: ${item.summary}`).join("\n") : "None."}\n\n` +
    `Capacity is claimed only for tiers whose full required duration and all correctness gates passed.\n`;
}

async function stopAllChildren() {
  for (const instance of [...children.keys()]) await stopGameEngine(instance);
}

async function teardown() {
  teardownPromise ??= (async () => {
    await stopAllChildren().catch(() => {});
    if (productSnapshot.size) await restoreQualification().catch(() => {});
    await pool.end().catch(() => {});
  })();
  return teardownPromise;
}

async function main() {
  const baseline = await preflight();
  requireCommand("dotnet", ["build", "services/game-engine/GameEngine.sln", "--no-restore"]);
  await activateQualification(baseline.products, baseline.scopes);
  const maxPlayers = Math.max(...tiers.map((item) => item.players));
  const { population, hierarchyByScope } = await createPopulation(baseline.scopes, maxPlayers);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  await startGameEngine(0, publicKeyPem, privateKeyPem);
  await startGameEngine(1, publicKeyPem, privateKeyPem);
  await waitForAcceptingDraws();
  const negativeTests = await runNegativeTests(baseline.products, population[0], hierarchyByScope);
  check("negative ticket cases fail closed", negativeTests.every((item) => item.rejected), { negativeTests });
  for (const tierConfig of tiers) {
    const result = await runTier(tierConfig, baseline.products, population, hierarchyByScope);
    if (!result.pass) {
      anomaly("TIER_BLOCKED", "HIGH", `${tierConfig.name} tier did not satisfy qualification gates.`, result);
      if (tierConfig.name !== "stress") break;
    }
  }
  const integrity = await finalIntegrity(baseline.products);
  check("CSPRNG hash remains frozen", integrity.csprngHash === expectedCsprngHash, integrity);
  check("no provider fallback", integrity.providerFallback === 0, integrity);
  check("no duplicate financial effects", Object.values(integrity.duplicateEffects).every((value) => value === 0), integrity);
  const fullPassing = tierResults.filter((item) => item.pass && item.sustainedDurationSatisfied);
  const highest = fullPassing.at(-1)?.tier ?? null;
  const requiredPass = ["baseline", "pilot", "elevated"].every((name) =>
    tierResults.some((item) => item.tier === name && item.pass && item.sustainedDurationSatisfied));
  const summary = {
    schemaVersion: "mosera.pr04b.qualification-summary.v1",
    campaignId,
    baselineCommit: expectedCommit,
    generatedAt: new Date().toISOString(),
    status: requiredPass ? "PR_04_RUNTIME_SCALE_QUALIFICATION_PASS" : "PR_04_RUNTIME_SCALE_QUALIFICATION_BLOCKED",
    highestVerifiedCapacityTier: highest,
    tiers: tierResults,
    failureInjection: failureEvidence,
    integrity,
    acceptanceLatency: latencySummary(acceptanceLatencies),
    readLatency: latencySummary(readLatencies),
    anomalies,
    checks,
  };
  writeJson("failure-injection.json", { schemaVersion: "mosera.pr04b.failure-injection.v1", campaignId, events: failureEvidence });
  writeJson("anomaly-register.json", { schemaVersion: "mosera.pr04b.anomaly-register.v1", campaignId, appendOnly: true, anomalies });
  writeJson("qualification-summary.json", summary);
  writeFileSync(`${evidenceRoot}/qualification-report.md`, reportMarkdown(summary), { flag: "wx" });
  writeJson("evidence-manifest.json", { schemaVersion: "mosera.pr04b.evidence-manifest.v1", campaignId, artifacts: buildManifest() });
  console.log(JSON.stringify({ status: summary.status, campaignId, evidenceRoot, highestVerifiedCapacityTier: highest, tiers: tierResults.map((item) => ({ tier: item.tier, pass: item.pass, tickets: item.chain.tickets, items: item.chain.items, resultToWallet: item.resultToWalletLatency })) }, null, 2));
  if (!requiredPass) process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shuttingDown = true;
    teardown().finally(() => process.exit(130));
  });
}

try {
  await main();
} catch (error) {
  anomaly("CAMPAIGN_ABORTED", "CRITICAL", "PR-04B campaign aborted before qualification completion.", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  if (statSafe(evidenceRoot)) {
    if (!statSafe(`${evidenceRoot}/anomaly-register.json`)) {
      writeJson("anomaly-register.json", { schemaVersion: "mosera.pr04b.anomaly-register.v1", campaignId, appendOnly: true, anomalies });
    }
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await teardown();
  if (shuttingDown) process.exitCode = 130;
}

function statSafe(path) {
  try { statSync(path); return true; } catch { return false; }
}
