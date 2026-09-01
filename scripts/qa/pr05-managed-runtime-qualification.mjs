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
import amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;
const expectedCommit = "8a474adcceda180377f9889ae269835d1b6aac95";
const expectedCsprngHash = "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c";
const csprngPath = "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const gameEngineBasePort = Number(process.env.PR05_GAME_ENGINE_BASE_PORT ?? 5594);
const settlementUrl = process.env.SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:5400";
const campaignId = process.env.PR05_CAMPAIGN_ID ??
  `pr05-${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(4).toString("hex")}`;
const evidenceRoot = process.env.PR05_EVIDENCE_DIR ?? `.qa/pr-05/${campaignId}`;
const qualificationApproved = process.env.PR05_QUALIFICATION_APPROVED === "true";
const diagnosticOnly = process.env.PR05_DIAGNOSTIC_ONLY === "true";
const rabbitOnlyFailureInjection =
  process.env.PR05_RABBIT_ONLY_FAILURE_INJECTION === "true";
const pr05kQualification = process.env.PR05K_QUALIFICATION === "true";
const pr05lShortGate = process.env.PR05L_SHORT_GATE === "true";
const pr05pQualification = process.env.PR05P_QUALIFICATION === "true";
const pr05dQualification = process.env.PR05D_QUALIFICATION === "true" || pr05kQualification;
const pr05cQualification = process.env.PR05C_QUALIFICATION === "true" || pr05dQualification;
const collectorIntervalMs = boundedInteger("PR05_COLLECTOR_INTERVAL_MS", 5_000, 1_000, 30_000);
const gameEngineFanoutConcurrency = boundedInteger(
  "PR05_GAME_ENGINE_FANOUT_CONCURRENCY", pr05pQualification ? 12 : pr05cQualification ? 16 : 12, 1, 32,
);
const gameEnginePoolMax = boundedInteger(
  "PR05_GAME_ENGINE_POOL_MAX", pr05pQualification ? 12 : 6, 1, 32,
);
const productMixFast = boundedNumber(
  "PR05_FAST_KENO_PERCENT", 80, 70, diagnosticOnly ? 100 : 85,
) / 100;
const harnessPoolMax = boundedInteger("PR05_HARNESS_POOL_MAX", 6, 4, 64);
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "pr05-qualification-harness",
  max: harnessPoolMax,
  idleTimeoutMillis: 30_000,
});
const children = new Map();
const productSnapshot = new Map();
const availabilityIds = [];
const qualificationScopeIds = [];
const checks = [];
const anomalies = [];
const failureEvidence = [];
const acceptanceLatencies = [];
const readLatencies = [];
const drawLiabilityReady = new Map();
const scopeLiabilityReady = new Map();
const playerLiabilityReady = new Map();
const activityCohorts = new WeakMap();
const tierResults = [];
const burstResults = [];
let shuttingDown = false;
let teardownPromise;
let collectorRegistration;

const fullTiers = pr05kQualification
  ? [tier("elevated", 2_000, 60, 6.0, true)]
  : pr05cQualification
  ? pr05dQualification ? [
      tier("pilot", 500, 30, 3.0, true),
      tier("elevated", 2_000, 60, 6.0, true),
    ] : [
      tier("baseline", 100, 30, 1.0, true),
      tier("pilot", 500, 30, 3.0, true),
      tier("elevated", 2_000, 60, 6.0, true),
    ]
  : [tier("pilot", boundedInteger("PR05_PILOT_PLAYERS", 500, 100, 2_000), 30, 3.0, true)];
const selectedTiers = process.env.PR05_TIERS?.split(",").map((value) => value.trim().toLowerCase());
const tiers = fullTiers.filter((item) => !selectedTiers?.length || selectedTiers.includes(item.name));
const burstTargets = pr05cQualification && !pr05lShortGate
  ? (process.env.PR05C_BURSTS ?? "500,1000,2500,5000,10000")
      .split(",")
      .map((value) => boundedIntegerValue("PR05C_BURSTS", value.trim(), 1, 10_000))
  : [];

function tier(name, players, minutes, ticketsPerSecond, claimable) {
  return {
    name,
    players,
    requiredMinutes: minutes,
    minutes: boundedNumber(`PR05_${name.toUpperCase()}_MINUTES`, minutes, 0.1, 240),
    ticketsPerSecond: boundedNumber(
      `PR05_${name.toUpperCase()}_TICKETS_PER_SECOND`, ticketsPerSecond, 0.1, 100,
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

function boundedIntegerValue(name, raw, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} entries must be integers between ${minimum} and ${maximum}.`);
  }
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
    if (shuttingDown) throw new Error("PR-05 qualification was interrupted.");
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

async function rabbitMqSettlementTransportReady() {
  const connection = await amqp.connect(
    process.env.RABBITMQ_URL ??
      "amqp://lottery:lottery_dev_password@127.0.0.1:5672",
    { timeout: 2_000 },
  );
  const channel = await connection.createConfirmChannel();
  try {
    await channel.checkExchange("lottery.events");
    await channel.checkQueue("lottery.settlement.events");
    await channel.checkQueue("lottery.settlement.events.dlq");
    return true;
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
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
    "docs/architecture/pr-05-managed-runtime-qualification.md",
    "docs/architecture/pr-05a-downstream-latency-connection-budget-remediation.md",
    "docs/architecture/pr-05b-ticket-draw-aggregate-settlement-remediation.md",
    "docs/architecture/pr-05c-sustained-burst-capacity-qualification.md",
    "docs/architecture/pr-05d-deadlock-managed-requalification.md",
    "docs/architecture/pr-05e-math-settlement-latency-root-cause-qualification.md",
    "docs/architecture/pr-05f-bounded-math-admission-settlement-queue-throughput.md",
    "docs/architecture/pr-05g-automatic-financial-recovery-capacity-rerun.md",
    "docs/architecture/pr-05h-aggregate-readiness-connection-budget-remediation.md",
    "docs/architecture/pr-05i-settlement-outbox-consumer-throughput-remediation.md",
    "docs/architecture/pr-05o-canonical-financial-instruction-execution-remediation.md",
    "scripts/migrations/local/136_repair_scheduler_public_draw_sequence.sql",
    "scripts/migrations/local/137_enforce_pilot_product_ticket_limits.sql",
    "scripts/migrations/local/138_preserve_non_pilot_ticket_lifecycle_compatibility.sql",
    "scripts/migrations/local/139_add_hot_spot_multi_draw_participations.sql",
    "scripts/migrations/local/140_harden_financial_completion_ordering.sql",
    "scripts/migrations/local/141_add_downstream_processing_timing_evidence.sql",
    "scripts/migrations/local/142_add_ticket_draw_aggregate_settlement.sql",
    "scripts/migrations/local/143_bind_aggregate_completion_source_lineage.sql",
    "scripts/migrations/local/144_align_funding_wallet_lock_order.sql",
    "scripts/migrations/local/145_add_pr05e_latency_stage_evidence.sql",
    "scripts/migrations/local/146_add_bounded_math_admission_evidence.sql",
    "scripts/migrations/local/147_normalize_cross_clock_math_admission.sql",
    "scripts/migrations/local/148_add_settlement_transport_timing_evidence.sql",
    "scripts/migrations/local/149_optimize_settlement_dispatch_completion_tail.sql",
    "scripts/migrations/local/150_add_settlement_consumer_admission_evidence.sql",
    "scripts/migrations/local/151_add_financial_target_latency_evidence.sql",
    "scripts/migrations/migration-manifest.json",
    "scripts/migrations/validate-local-migrations.mjs",
    "scripts/qa/pr04b-sustained-runtime-scale-qualification.mjs",
    "scripts/qa/pr05-managed-runtime-qualification.mjs",
    "scripts/qa/pr05-evidence-collector.mjs",
    "scripts/qa/pr05d-wallet-lock-order.mjs",
    "scripts/qa/pr05g-automatic-financial-recovery.ts",
    "scripts/qa/pr05i-settlement-transport.mjs",
    "scripts/qa/pr05j-rabbitmq-recovery.mjs",
    "scripts/qa/pr05m-tail-remediation.ts",
    "scripts/qa/pr05n-settlement-consumer-admission.mjs",
    "scripts/qa/pr05o-financial-instruction-execution.mjs",
    "scripts/qa/lib/credit-wallet-settlement-fixture.ts",
    "scripts/qa/hot-spot-multi-draw-runtime.mjs",
    "scripts/qa/scheduler-pilot-product-financial-completion.mjs",
    "services/credit-wallet-service/Infrastructure/CanonicalWalletOperationRepository.cs",
    "services/credit-wallet-service/Controllers/CanonicalWalletOperationEndpoints.cs",
    "services/game-engine/src/GameEngine.Application/Services/DurableSchedulerRuntime.cs",
    "services/game-engine/src/GameEngine.Application/Services/InMemoryDurableSchedulerRepositories.cs",
    "services/game-engine/src/GameEngine.Domain/Model/DurableSchedulerModels.cs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresDurableSchedulerPersistence.cs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresSchedulerOutcomeFanoutRepository.cs",
    "services/game-engine/tests/GameEngine.Application.Tests/DurableSchedulerTests.cs",
    "services/game-engine/tests/GameEngine.Application.Tests/Pr04AHotSpotEvidenceHarness.cs",
    "services/settlement-service/Infrastructure/TicketCompletionRepository.cs",
    "services/settlement-service/Infrastructure/PostgresConnectionString.cs",
    "services/settlement-service/Infrastructure/SettlementExecutionRepository.cs",
    "services/credit-wallet-service/Infrastructure/PostgresConnectionString.cs",
    "services/ledger-service/Infrastructure/InfrastructureReadinessChecks.cs",
    "services/ledger-service/Controllers/LedgerEndpoints.cs",
    "services/auth-service/src/AuthService.Infrastructure/PostgresAuthPersistence.cs",
    "services/game-engine/src/GameEngine.Api/Configuration/SchedulerOutcomeFanoutConfiguration.cs",
    "services/game-engine/src/GameEngine.Application/Services/MathEvaluationDurableServices.cs",
    "services/game-engine/src/GameEngine.Application/Services/SchedulerOutcomeCompletionFanout.cs",
    "services/game-engine/src/GameEngine.Application/Services/SettlementInputAdapterServices.cs",
    "services/game-engine/src/GameEngine.Domain/Model/SettlementInputModels.cs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresEvaluationPersistence.cs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresMathEvaluationPersistence.cs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs",
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresSettlementInputPersistence.cs",
    "services/game-engine/tests/GameEngine.Application.Tests/Program.cs",
    "services/settlement-service/Application/SettlementExecutionService.cs",
    "services/settlement-service/Application/SettlementInputIngestionService.cs",
    "services/settlement-service/Application/SettlementRecoveryService.cs",
    "services/settlement-service/Application/FinancialInstructionExecutionService.cs",
    "services/settlement-service/Application/AutomaticFinancialRecoveryHostedService.cs",
    "services/settlement-service/Configuration/ServiceConfiguration.cs",
    "services/settlement-service/Contracts/SettlementInputIngestionContracts.cs",
    "services/settlement-service/Controllers/HealthEndpoints.cs",
    "services/settlement-service/Infrastructure/FinancialInstructionRepository.cs",
    "services/settlement-service/Infrastructure/SettlementCreditWalletServiceClient.cs",
    "services/settlement-service/Infrastructure/SettlementLedgerServiceClient.cs",
    "services/settlement-service/Infrastructure/SettlementInputIngestionRepository.cs",
    "services/settlement-service/Program.cs",
    "services/settlement-service/tests/SettlementService.Tests/Program.cs",
    "src/domains/workers/canonical-settlement-request-handler.ts",
    "src/domains/accounts/account.repository.ts",
    "src/domains/compensation/compensation.repository.ts",
    "src/domains/financial-authority/funding-instrument-authority.ts",
    "src/domains/hierarchy/canonical-hierarchy-authority.ts",
    "src/domains/operational-change/operational-change.repository.ts",
    "src/domains/operational-governance/operational-governance.repository.ts",
    "src/domains/operational-security/operational-security.repository.ts",
    "src/domains/platform-management/platform-management.repository.ts",
    "src/domains/players/player-profile.repository.ts",
    "src/domains/tickets/canonical-ticket.repository.ts",
    "src/domains/workers/worker-runtime-readiness.ts",
    "src/domains/workers/financial-worker-handlers.ts",
    "src/domains/workers/outbox-dispatcher.service.ts",
    "src/domains/operations/worker-observability.repository.ts",
    "src/domains/outbox/outbox.postgres.repository.ts",
    "src/domains/outbox/outbox.service.ts",
    "src/domains/outbox/outbox.types.ts",
    "src/lib/database/resilient-postgres-pool.ts",
    "src/lib/queue/queue.types.ts",
    "src/lib/queue/queue-topology.ts",
    "src/lib/queue/rabbitmq/rabbitmq.consumer.ts",
    "src/lib/queue/rabbitmq/rabbitmq.publisher.ts",
    "scripts/workers/consume-workload.ts",
    "scripts/workers/dispatch-outbox.ts",
    "docker-compose.yml",
    "docker-compose.production.yml",
    "artifacts/",
  ];
  check("explicit PR-05 qualification approval", qualificationApproved);
  check("exact PR-04A baseline", head === expectedCommit, { expectedCommit, head });
  check("disposable local database", /local|test|qa|ci|disposable/.test(databaseName), { databaseName });
  check("production deployment excluded",
    (process.env.DEPLOYMENT_ENVIRONMENT ?? "local").toLowerCase() !== "production");
  check("worktree contains only known or PR-05 changes",
    dirty.every((line) => allowedDirty.some((path) => line.endsWith(path))), { dirty });
  const csprngHash = fileHash(csprngPath);
  check("frozen CSPRNG implementation", csprngHash === expectedCsprngHash, { csprngPath, csprngHash });
  check("Settlement service ready", (await fetch(`${settlementUrl}/health/ready`)).ok, { settlementUrl });
  const dbReady = await pool.query(`
select current_database() database,clock_timestamp() observed_at,
  current_setting('server_version') postgres_version,
  current_setting('max_connections')::int max_connections`);
  const products = await loadProducts();
  check("exact immutable pilot products", products.length === 2 && products.every((item) =>
    item.publication_state === "PUBLISHED" && item.activation_state === "INACTIVE" &&
    item.assignment_state === "UNASSIGNED" && item.active_version_id === null), { products });
  await ensureQualificationScopes();
  const scopes = await loadScopes();
  check("two active tenant/brand qualification scopes available", scopes.length >= 2,
    { scopeCount: scopes.length });
  writeJson("environment.json", {
    schemaVersion: "mosera.pr05.environment.v1",
    campaignId,
    generatedAt: new Date().toISOString(),
    baselineCommit: head,
    csprngHash,
    database: dbReady.rows[0],
    host: {
      hostname: hostname(), platform: platform(), release: release(), cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? null, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
      loadAverage: loadavg(), node: process.version,
      dotnet: command("dotnet", ["--version"]),
    },
    products,
    scopes: scopes.map(({ platform_id, organization_id, tenant_id, brand_id, market_id, currency }) =>
      ({ platform_id, organization_id, tenant_id, brand_id, market_id, currency })),
    runtimeConfiguration: {
      gameEngineInstances: 2,
      gameEnginePoolPerInstance: gameEnginePoolMax,
      gameEngineFanoutConcurrency,
      mathAdmissionBatchSize: Number(process.env.GAME_ENGINE_MATH_ADMISSION_BATCH_SIZE ?? 100),
      mathAdmissionConcurrency: Number(process.env.GAME_ENGINE_MATH_ADMISSION_CONCURRENCY ?? 2),
      mathAdmissionBufferLimit: Number(process.env.GAME_ENGINE_MATH_ADMISSION_BUFFER_LIMIT ?? 5_000),
      settlementPreparationConcurrency: Number(
        process.env.GAME_ENGINE_SETTLEMENT_PREPARATION_CONCURRENCY ?? 4
      ),
      settlementPool: Number(process.env.SETTLEMENT_DATABASE_MAX_POOL_SIZE ?? 6),
      settlementWorkerPool: Number(process.env.SETTLEMENT_WORKER_DATABASE_POOL_MAX ?? 6),
      settlementPrefetch: Number(process.env.SETTLEMENT_WORKER_RABBITMQ_PREFETCH ?? 8),
      settlementExecutionConcurrency: Number(
        process.env.SETTLEMENT_WORKER_EXECUTION_CONCURRENCY ?? 8
      ),
      outboxDispatchConcurrency: Number(process.env.OUTBOX_DISPATCH_CONCURRENCY ?? 8),
      harnessPool: harnessPoolMax,
    },
    docker: command("docker", ["compose", "ps", "--format", "json"]),
    dockerImages: command("docker", ["compose", "images", "--format", "json"]),
    rabbitMq: command("docker", ["compose", "exec", "-T", "rabbitmq", "rabbitmqctl", "version"]),
    redis: command("docker", ["compose", "exec", "-T", "redis", "redis-server", "--version"]),
  });
  return { products, scopes: scopes.slice(0, 2), head, csprngHash };
}

async function ensureQualificationScopes() {
  const existing = await loadScopes();
  if (existing.length >= 2) return;
  const platformId = "00000000-0000-4000-8000-000000000001";
  const organizationId = randomUUID();
  const suffix = campaignId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(-16).toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`
insert into platform.organizations(
  id,platform_id,organization_code,name,status,governance_metadata,global_defaults,
  version,content_hash,audit_metadata)
values($1,$2,$3,'PR-05C Qualification Organization','Active',$4::jsonb,$5::jsonb,
  '1.0.0',$6,$7::jsonb)`, [
      organizationId, platformId, `pr05c-org-${suffix}`,
      JSON.stringify({ qualificationOnly: true }), JSON.stringify({ defaultLocale: "en" }),
      hash(`pr05c-organization:${campaignId}`), JSON.stringify({ campaignId, qualificationOnly: true }),
    ]);
    for (let index = 0; index < 2; index += 1) {
      const tenantId = randomUUID();
      const brandId = randomUUID();
      const marketId = randomUUID();
      qualificationScopeIds.push({ tenantId, brandId, marketId });
      await client.query(`
insert into platform.tenants(
  id,organization_id,tenant_code,name,status,operator_metadata,default_language,
  default_currency,default_timezone,credit_enabled,cashier_enabled,version,content_hash,audit_metadata)
values($1,$2,$3,$4,'Active',$5::jsonb,'en','USD','America/New_York',true,false,
  '1.0.0',$6,$7::jsonb)`, [
        tenantId, organizationId, `pr05c-tenant-${suffix}-${index + 1}`,
        `PR-05C Qualification Tenant ${index + 1}`, JSON.stringify({ qualificationOnly: true }),
        hash(`pr05c-tenant:${campaignId}:${index}`), JSON.stringify({ campaignId, qualificationOnly: true }),
      ]);
      await client.query(`
insert into platform.brands(
  id,tenant_id,brand_code,name,display_name,status,theme_reference_placeholder,
  asset_reference_placeholder,website_reference_placeholder,version,content_hash,audit_metadata)
values($1,$2,$3,$4,$4,'Active','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,
  '1.0.0',$5,$6::jsonb)`, [
        brandId, tenantId, `pr05c-brand-${suffix}-${index + 1}`,
        `PR-05C Qualification Brand ${index + 1}`,
        hash(`pr05c-brand:${campaignId}:${index}`), JSON.stringify({ campaignId, qualificationOnly: true }),
      ]);
      await client.query(`
insert into platform.markets(
  id,brand_id,market_code,name,display_name,country,jurisdiction,language,currency,
  timezone,future_game_availability_placeholder,status,version,content_hash,audit_metadata)
values($1,$2,$3,$4,$4,null,null,'en','USD','America/New_York','{}'::jsonb,
  'Active','1.0.0',$5,$6::jsonb)`, [
        marketId, brandId, `pr05c-market-${suffix}-${index + 1}`,
        `PR-05C Qualification Market ${index + 1}`,
        hash(`pr05c-market:${campaignId}:${index}`), JSON.stringify({ campaignId, qualificationOnly: true }),
      ]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    qualificationScopeIds.length = 0;
    throw error;
  } finally {
    client.release();
  }
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
values($1,'mosera-internal-csprng','2.0.0','2',$2,'qa:pr05',
  'PR05_QUALIFICATION_ONLY','qa:pr05-approved','mosera-software-signing',
  '1.0.0','key-v1',$3,$4,$5,clock_timestamp())`, [
      randomUUID(), stage, hash(`pr05-provider:${campaignId}:${stage}`),
      hash(`pr05-provider-evidence:${campaignId}:${stage}`),
      `pr05-provider:${campaignId}:${stage}`,
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
  'PR05_QUALIFICATION_ONLY','qa:pr05')`, [
        id, scope.tenant_id, scope.brand_id, scope.market_id, product.product_id,
        product.code.toLowerCase(), product.game_manifest_id, campaignId,
        hash(`pr05-availability:${campaignId}:${scope.tenant_id}:${product.code}`),
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
    for (const availabilityId of availabilityIds) {
      await client.query(`
insert into platform.platform_lifecycle_events(
  event_id,resource,record_id,entity_key,from_status,to_status,from_version,to_version,
  effective_from,reason,operator,approval_metadata,event_hash,created_at)
select $2,'game-availability',availability.id,
  jsonb_build_object('tenantId',availability.tenant_id,'brandId',availability.brand_id,
    'marketId',availability.market_id,'gameCode',availability.game_code),
  'Active','Retired',availability.version,availability.version,clock_timestamp(),
  'PR05_QUALIFICATION_TEARDOWN','qa:pr05',$3::jsonb,$4,clock_timestamp()
from platform.game_availability availability
where availability.id=$1
  and not exists (
    select 1 from platform.platform_lifecycle_events lifecycle
    where lifecycle.resource='game-availability'
      and lifecycle.record_id=availability.id
      and lifecycle.to_status='Retired'
  )`, [
        availabilityId,
        randomUUID(),
        JSON.stringify({ campaignId, qualificationOnly: true }),
        hash(`pr05-availability-retired:${campaignId}:${availabilityId}`),
      ]);
      await client.query(`
update platform.game_availability
set effective_to=coalesce(effective_to,clock_timestamp())
where id=$1`, [availabilityId]);
    }
    await client.query(`
delete from game_engine.game_engine_production_activation_events
where reason_code='PR05_QUALIFICATION_ONLY'
  and idempotency_key like $1`, [`pr05-provider:${campaignId}:%`]);
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
        id, type, `pr05-${campaignId.slice(-8)}-${type.toLowerCase()}-${id.slice(0, 5)}`,
        `PR-05 ${type}`, parent, scope.tenant_id, scope.brand_id, scope.market_id,
        `pr05-account:${campaignId}:${id}`, hash(`pr05-account:${campaignId}:${id}`),
      ]);
    }
  }
  for (let offset = 0; offset < count; offset += 250) {
    const batchSize = Math.min(250, count - offset);
    const batch = Array.from({ length: batchSize }, (_, batchIndex) => {
      const index = offset + batchIndex;
      const scope = scopes[index % scopes.length];
      const cohortRoll = stableIndex(`${campaignId}:cohort:${index}`, 100);
      const cohort = cohortRoll < 5 ? "NEAR_FUNDS" : cohortRoll < 72 ? "LIGHT" :
        cohortRoll < 91 ? "ACTIVE" : cohortRoll < 98 ? "HIGH" : "BURST";
      return {
        index, scope, cohort, accountId: randomUUID(), profileId: randomUUID(), walletId: randomUUID(),
        parentId: hierarchyByScope.get(scope.tenant_id).agentId,
      };
    });
    await pool.query(`
insert into public.accounts(
  id,account_type,account_code,display_name,parent_account_id,canonical_tenant_id,
  canonical_brand_id,canonical_market_id,status,governance_managed,idempotency_key,canonical_request_hash)
select id,'PLAYER','pr05-' || $1 || '-' || (ordinal + $7)::text,
  'PR-05 Player ' || (ordinal + $7)::text,
  parent_id,tenant_id,brand_id,market_id,'ACTIVE',true,
  'pr05-player:' || $1 || ':' || id::text,'sha256:' || encode(digest('pr05-player:' || $1 || ':' || id::text,'sha256'),'hex')
from unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[],$6::uuid[]) with ordinality
  as source(id,parent_id,tenant_id,brand_id,market_id,ordinal)`, [campaignId,
      batch.map((item) => item.accountId), batch.map((item) => item.parentId),
      batch.map((item) => item.scope.tenant_id), batch.map((item) => item.scope.brand_id),
      batch.map((item) => item.scope.market_id), offset]);
    await pool.query(`
insert into public.player_profiles(id,account_id,display_name,status)
select profile_id,account_id,'PR-05 Player ' || ordinal::text,'ACTIVE'
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
      batch.map((item) => item.cohort === "NEAR_FUNDS" ? 500 : item.cohort === "LIGHT" ? 10_000 :
        item.cohort === "ACTIVE" ? 500_000_000 : 5_000_000_000),
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
    const liabilityIds = batch.map(() => randomUUID());
    const liabilityHashes = batch.map((item) => hash(`pr05-liability:${campaignId}:player:${item.accountId}`));
    await pool.query(`
insert into ticket_authority.liability_limit_configurations(
  configuration_id,tenant_id,brand_id,scope_type,scope_reference,
  maximum_wager_minor,maximum_theoretical_payout_minor,maximum_exposure_minor,
  status,effective_from,version,supersedes_configuration_id,content_hash,audit_metadata)
select configuration_id,tenant_id,brand_id,'PLAYER',player_id::text,
  10000000000,1000000000000,100000000000000,'Active',
  clock_timestamp()-interval '1 millisecond',1,null,content_hash,
  jsonb_build_object('campaignId',$1::text,'qualificationOnly',true)
from unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[],$6::text[])
  as source(configuration_id,tenant_id,brand_id,player_id,content_hash)`, [
      campaignId, liabilityIds, batch.map((item) => item.scope.tenant_id),
      batch.map((item) => item.scope.brand_id), batch.map((item) => item.accountId), liabilityHashes,
    ]);
    for (const item of batch) playerLiabilityReady.set(item.accountId, Promise.resolve());
    population.push(...batch);
  }
  writeJson("workload.json", {
    schemaVersion: "mosera.pr05.workload.v1", campaignId, productMix: { fastKeno: productMixFast, hotSpot: 1 - productMixFast },
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

function selectPlayer(players, seed) {
  const roll = stableIndex(`${seed}:activity`, 100);
  const preferred = roll < 35 ? "LIGHT" : roll < 70 ? "ACTIVE" : roll < 90 ? "HIGH" : "BURST";
  let cohorts = activityCohorts.get(players);
  if (!cohorts) {
    cohorts = players.reduce((result, item) => {
      (result[item.cohort] ??= []).push(item);
      return result;
    }, {});
    activityCohorts.set(players, cohorts);
  }
  const cohort = cohorts[preferred] ?? [];
  const candidates = cohort.length ? cohort : players;
  return candidates[stableIndex(`${seed}:player`, candidates.length)];
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
    hash(`pr05-liability:${campaignId}:${key}`), JSON.stringify({ campaignId, qualificationOnly: true }),
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
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_CONCURRENCY: String(gameEngineFanoutConcurrency),
      GAME_ENGINE_MATH_ADMISSION_BATCH_SIZE:
        process.env.GAME_ENGINE_MATH_ADMISSION_BATCH_SIZE ?? "100",
      GAME_ENGINE_MATH_ADMISSION_CONCURRENCY:
        process.env.GAME_ENGINE_MATH_ADMISSION_CONCURRENCY ?? "2",
      GAME_ENGINE_MATH_ADMISSION_BUFFER_LIMIT:
        process.env.GAME_ENGINE_MATH_ADMISSION_BUFFER_LIMIT ?? "5000",
      GAME_ENGINE_SETTLEMENT_PREPARATION_CONCURRENCY:
        process.env.GAME_ENGINE_SETTLEMENT_PREPARATION_CONCURRENCY ?? (pr05pQualification ? "6" : "4"),
      DATABASE_MAX_POOL_SIZE: String(gameEnginePoolMax),
      DATABASE_APPLICATION_NAME: `pr05-game-engine-${instance}`,
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

function collectorRecords() {
  const path = `${evidenceRoot}/independent-metrics.jsonl`;
  if (!statSafe(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function setCollectorControl(tierName, phase) {
  writeFileSync(`${evidenceRoot}/collector-control.json`, `${JSON.stringify({
    campaignId,
    tier: tierName,
    phase,
    updatedAt: new Date().toISOString(),
  })}\n`);
}

async function startEvidenceCollector() {
  setCollectorControl("IDLE", "PREPARING");
  const log = createWriteStream(`${evidenceRoot}/independent-collector.log`, { flags: "a" });
  const child = spawn(process.execPath, ["scripts/qa/pr05-evidence-collector.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PR05_CAMPAIGN_ID: campaignId,
      PR05_EVIDENCE_DIR: evidenceRoot,
      PR05_COLLECTOR_CONTROL: `${evidenceRoot}/collector-control.json`,
      PR05_COLLECTOR_INTERVAL_MS: String(collectorIntervalMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  collectorRegistration = { child, log };
  await waitFor("independent evidence collector", async () => {
    if (child.exitCode !== null) throw new Error(`Evidence collector exited ${child.exitCode}.`);
    return collectorRecords().length > 0;
  }, 30_000, 250);
}

async function stopEvidenceCollector() {
  const registration = collectorRegistration;
  if (!registration) return;
  const { child, log } = registration;
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(15_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  log.end();
  collectorRegistration = undefined;
}

async function beginTierEvidence(tierName) {
  setCollectorControl(tierName, "SUSTAINED");
  return waitFor(`${tierName} independent evidence heartbeat`, async () => {
    const records = collectorRecords().filter((record) => record.control?.tier === tierName);
    return records.at(-1) ?? null;
  }, collectorIntervalMs * 4, 250);
}

async function finishTierEvidence(tierName, endedAt) {
  await waitFor(`${tierName} terminal independent evidence heartbeat`, async () => {
    const records = collectorRecords().filter((record) => record.control?.tier === tierName);
    const latest = records.at(-1);
    return latest && new Date(latest.observedAt) >= endedAt ? latest : null;
  }, collectorIntervalMs * 4, 250);
  setCollectorControl("IDLE", `AFTER_${tierName.toUpperCase()}`);
}

function tierEvidenceContinuity(tierName, startedAt, endedAt) {
  const records = collectorRecords().filter((record) =>
    record.control?.tier === tierName &&
    new Date(record.observedAt) >= new Date(startedAt.getTime() - collectorIntervalMs) &&
    new Date(record.observedAt) <= new Date(endedAt.getTime() + collectorIntervalMs * 2));
  const executionIds = [...new Set(records.map((record) => record.collectorExecutionId))];
  const gaps = records.slice(1).map((record, index) => ({
    wallMs: new Date(record.observedAt) - new Date(records[index].observedAt),
    monotonicMs: Number(record.monotonicElapsedMs) - Number(records[index].monotonicElapsedMs),
  }));
  const maximumHeartbeatGapMs = gaps.length
    ? Math.max(...gaps.flatMap((gap) => [gap.wallMs, gap.monotonicMs]))
    : null;
  const expectedSampleCount = Math.floor((endedAt - startedAt) / collectorIntervalMs) + 1;
  const actualSampleCount = records.filter((record) =>
    new Date(record.observedAt) >= startedAt && new Date(record.observedAt) <= endedAt).length;
  const firstHeartbeat = records.at(0)?.observedAt ?? null;
  const lastHeartbeat = records.at(-1)?.observedAt ?? null;
  const missingSampleCount = Math.max(0, expectedSampleCount - actualSampleCount);
  const boundedGap = maximumHeartbeatGapMs !== null &&
    maximumHeartbeatGapMs <= collectorIntervalMs * 2.5;
  return {
    collectorExecutionIds: executionIds,
    intervalMs: collectorIntervalMs,
    firstHeartbeat,
    lastHeartbeat,
    maximumHeartbeatGapMs,
    expectedSampleCount,
    actualSampleCount,
    missingSampleCount,
    continuous: records.length > 1 && executionIds.length === 1 && boundedGap &&
      new Date(firstHeartbeat) <= new Date(startedAt.getTime() + collectorIntervalMs) &&
      new Date(lastHeartbeat) >= endedAt,
  };
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
    if (diagnosticOnly && productMixFast === 1) return fast ? { fast, hot: null } : null;
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
  const idempotencyKey = `pr05-ticket:${campaignId}:${tierName}:${sequence}`;
  const started = performance.now();
  let transientRetries = 0;
  let deadlockCount = 0;
  let serializationFailureCount = 0;
  let retryLatencyMs = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = (await pool.query(`
select ticket_authority.accept_ticket(
  $1,$2,'CREDIT',$3,$4,$5,$6,$7,null,$8,$9,$10::jsonb,$11,$12,$13,'qa:pr05','PR05'
) result`, [
        player.accountId, player.profileId, player.walletId, product.product_id,
        product.game_manifest_id, product.paytable_definition_id, draw.draw_id,
        `pr05-${campaignId}-${tierName}-${sequence}`, player.scope.currency, JSON.stringify(items),
        idempotencyKey, `pr05:${campaignId}:${tierName}:${sequence}`, `draw:${draw.draw_id}`,
      ])).rows[0].result;
      acceptanceLatencies.push(performance.now() - started);
      return {
        ...result, productCode: product.code, drawId: draw.draw_id,
        playerId: player.accountId, idempotencyKey, transientRetries,
        deadlockCount, serializationFailureCount, retryLatencyMs,
        retrySucceeded: transientRetries > 0, retryExhausted: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sqlState = typeof error === "object" && error !== null && "code" in error
        ? String(error.code) : "";
      const transient = sqlState === "40P01" || sqlState === "40001" ||
        /deadlock detected|could not serialize access/i.test(message);
      if (sqlState === "40P01" || /deadlock detected/i.test(message)) deadlockCount += 1;
      if (sqlState === "40001" || /could not serialize access/i.test(message)) serializationFailureCount += 1;
      if (transient && attempt < 3) {
        transientRetries += 1;
        const delayMs = 25 * attempt + stableIndex(`${idempotencyKey}:retry:${attempt}`, 25);
        retryLatencyMs += delayMs;
        await sleep(delayMs);
        continue;
      }
      acceptanceLatencies.push(performance.now() - started);
      return {
        accepted: false, error: message, productCode: product.code,
        drawId: draw.draw_id, playerId: player.accountId, transientRetries,
        deadlockCount, serializationFailureCount, retryLatencyMs,
        retrySucceeded: false, retryExhausted: transient,
      };
    }
  }
}

async function resourceSnapshot(tierName) {
  const observedAt = new Date().toISOString();
  const scheduler = (await pool.query("select * from game_engine.durable_scheduler_operational_status order by product_code")).rows;
  const databaseRows = (await pool.query(`
select coalesce(nullif(application_name,''),'unidentified') application_name,
  count(*)::int total,
  count(*) filter(where state='active')::int active,
  count(*) filter(where state='idle')::int idle,
  count(*) filter(where wait_event_type='Lock')::int lock_waiters
from pg_stat_activity where datname=current_database()
group by coalesce(nullif(application_name,''),'unidentified')
order by application_name`)).rows;
  const database = {
    byApplication: databaseRows,
    total: databaseRows.reduce((sum, row) => sum + Number(row.total), 0),
    active: databaseRows.reduce((sum, row) => sum + Number(row.active), 0),
    idle: databaseRows.reduce((sum, row) => sum + Number(row.idle), 0),
    lockWaiters: databaseRows.reduce((sum, row) => sum + Number(row.lock_waiters), 0),
  };
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
    pool.query("select ticket_id,status,lifecycle_state,accepted_at from ticket_authority.tickets where sales_channel='PR05' order by accepted_at desc limit 20"),
    pool.query("select id wallet_id,balance,credit_limit from public.financial_wallets where account_id in (select player_account_id from ticket_authority.tickets where sales_channel='PR05') limit 20"),
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
  await beginTierEvidence(tierConfig.name);
  const startedAt = new Date();
  const acceptanceLatencyStart = acceptanceLatencies.length;
  const readLatencyStart = readLatencies.length;
  const deadline = Date.now() + tierConfig.minutes * 60_000;
  const players = population.slice(0, tierConfig.players);
  const counters = {
    attempted: 0, accepted: 0, duplicates: 0, transientRetries: 0,
    deadlocks: 0, serializationFailures: 0, retrySuccesses: 0,
    retryExhaustions: 0, addedRetryLatencyMs: 0,
    errors: {}, fastKeno: 0, hotSpot: 0, reads: 0,
  };
  const acceptedTicketIds = [];
  const productByCode = Object.fromEntries(products.map((item) => [item.code, item]));
  let sequence = 0;
  let lastMetricAt = 0;
  let lastReadAt = 0;
  let nextIssueAt = performance.now();
  let recoveryStage = 0;
  const multiDrawCoverage = await createCanonicalMultiDrawCoverage(
    tierConfig, products, players, hierarchyByScope,
  );
  for (const item of multiDrawCoverage) {
    counters.attempted += 1;
    if (item.accepted) {
      counters.accepted += 1;
      counters.hotSpot += 1;
      acceptedTicketIds.push(item.ticketId);
    } else {
      counters.errors.MULTI_DRAW_COVERAGE = (counters.errors.MULTI_DRAW_COVERAGE ?? 0) + 1;
    }
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
        const player = selectPlayer(players, `${campaignId}:${tierConfig.name}:${sequence}`);
        const items = fast ? fastItems(`${campaignId}:${tierConfig.name}:${sequence}`) : hotSpotItems(`${campaignId}:${tierConfig.name}:${sequence}`);
        requests.push(acceptTicket({ tierName: tierConfig.name, sequence, product: productByCode[code], draw, player, items, hierarchyByScope }));
      }
      const results = await Promise.all(requests);
      for (const result of results) {
        counters.attempted += 1;
        counters.transientRetries += result.transientRetries ?? 0;
        counters.deadlocks += result.deadlockCount ?? 0;
        counters.serializationFailures += result.serializationFailureCount ?? 0;
        counters.retrySuccesses += result.retrySucceeded ? 1 : 0;
        counters.retryExhaustions += result.retryExhausted ? 1 : 0;
        counters.addedRetryLatencyMs += result.retryLatencyMs ?? 0;
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
    if (!pr05dQualification && process.env.PR05_FAILURE_INJECTION !== "false" &&
        (!pr05cQualification || tierConfig.name === "elevated")) {
      if (rabbitOnlyFailureInjection && recoveryStage === 0 && elapsedFraction >= 0.25) {
        const started = new Date().toISOString();
        requireCommand("docker", ["compose", "restart", "rabbitmq"]);
        await waitFor(
          "RabbitMQ Settlement AMQP transport recovers",
          rabbitMqSettlementTransportReady,
          120_000,
          500,
        );
        failureEvidence.push({
          type: "RABBITMQ_RESTART",
          started,
          recoveredAt: new Date().toISOString(),
        });
        recoveryStage = 3;
      } else if (!rabbitOnlyFailureInjection && recoveryStage === 0 && elapsedFraction >= 0.25) {
        await restartGameEngine(0);
        recoveryStage = 1;
      } else if (!rabbitOnlyFailureInjection && recoveryStage === 1 && elapsedFraction >= 0.50) {
        const started = new Date().toISOString();
        requireCommand("docker", ["compose", "restart", "worker-settlement"]);
        failureEvidence.push({ type: "SETTLEMENT_WORKER_RESTART", started, recoveredAt: new Date().toISOString() });
        recoveryStage = 2;
      } else if (!rabbitOnlyFailureInjection && recoveryStage === 2 && elapsedFraction >= 0.75) {
        const started = new Date().toISOString();
        requireCommand("docker", ["compose", "restart", "rabbitmq"]);
        await waitFor(
          "RabbitMQ Settlement AMQP transport recovers",
          rabbitMqSettlementTransportReady,
          120_000,
          500,
        );
        failureEvidence.push({ type: "RABBITMQ_RESTART", started, recoveredAt: new Date().toISOString() });
        recoveryStage = 3;
      }
    }
    await sleep(20);
  }
  const endedAt = new Date();
  await finishTierEvidence(tierConfig.name, endedAt);
  const evidenceContinuity = tierEvidenceContinuity(tierConfig.name, startedAt, endedAt);
  const completed = await waitForTierDrain(acceptedTicketIds, 360_000, endedAt);
  const evidence = await collectTierEvidence(
    tierConfig, startedAt, endedAt, counters, completed,
    acceptanceLatencies.slice(acceptanceLatencyStart), readLatencies.slice(readLatencyStart),
    multiDrawCoverage, evidenceContinuity,
  );
  writeJson(`campaign-${tierConfig.name}.json`, evidence);
  tierResults.push(evidence);
  return evidence;
}

function burstFastItems(seed, targetAverage) {
  const count = Math.max(1, Math.min(20, targetAverage + stableIndex(`${seed}:density`, 5) - 2));
  const start = stableIndex(`${seed}:start`, fastMarkets.length);
  return Array.from({ length: count }, (_, index) => {
    const [wagerType, selection, maximum] = fastMarkets[(start + index * 7) % fastMarkets.length];
    return {
      wagerType,
      wagerVersion: "1.0.0",
      selections: { numbers: [1], selection },
      stakeMinor: skewedStake(200, maximum, `${seed}:stake:${index}`),
    };
  });
}

async function acceptingDrawWithWindow(productCode, minimumSeconds) {
  return waitFor(`${productCode} accepting draw with ${minimumSeconds}s submission window`, async () =>
    (await pool.query(`
select draw_id,product_id,product_version_id,product_code,public_draw_number,
  cutoff_at,scheduled_execution_at,draw_identity_hash,scheduler_state
from game_engine.durable_scheduler_draws
where product_code=$1 and scheduler_state='Accepting'
  and cutoff_at > clock_timestamp() + make_interval(secs => $2)
order by scheduled_execution_at limit 1`, [productCode, minimumSeconds])).rows[0] ?? null,
  180_000, 250);
}

async function waitForBurstMilestones(ticketIds, tierName, timeoutMs) {
  if (!ticketIds.length) return { samples: [], timeout: true };
  const started = Date.now();
  const samples = [];
  const thresholds = { 50: null, 95: null, 99: null, 100: null };
  let lastMetricAt = 0;
  while (Date.now() - started < timeoutMs) {
    const completed = Number((await pool.query(`
select count(distinct aggregate.ticket_id)::int completed
from game_engine.ticket_draw_settlement_aggregates aggregate
join settlement_service.authoritative_settlement_records settlement using(settlement_input_id)
join credit_wallet_service.wallet_operation_requests request using(settlement_id)
join credit_wallet_service.wallet_operation_terminal_results wallet using(operation_id)
where aggregate.ticket_id=any($1::uuid[]) and wallet.terminal_status='COMMITTED'`, [ticketIds])).rows[0].completed);
    const elapsedMs = Date.now() - started;
    const percent = completed / ticketIds.length * 100;
    samples.push({ observedAt: new Date().toISOString(), elapsedMs, completed, expected: ticketIds.length, percent });
    for (const threshold of [50, 95, 99, 100]) {
      if (thresholds[threshold] === null && percent >= threshold) thresholds[threshold] = elapsedMs;
    }
    if (Date.now() - lastMetricAt >= 5_000) {
      await resourceSnapshot(tierName);
      lastMetricAt = Date.now();
    }
    if (completed === ticketIds.length) return { samples, thresholdsMs: thresholds, timeout: false };
    await sleep(500);
  }
  return { samples, thresholdsMs: thresholds, timeout: true };
}

async function runBurst(targetTickets, products, population, hierarchyByScope) {
  const name = `burst-${targetTickets}`;
  const targetAverageWagers = targetTickets === 500 ? 4 : targetTickets < 5_000 ? 6 : 8;
  const fast = products.find((item) => item.code === "FAST_KENO_V1");
  const fundedCohortOrder = { BURST: 0, HIGH: 1, ACTIVE: 2, LIGHT: 3 };
  const fundedPopulation = population
    .filter((item) => item.cohort !== "NEAR_FUNDS")
    .sort((left, right) => fundedCohortOrder[left.cohort] - fundedCohortOrder[right.cohort]);
  const players = fundedPopulation.slice(0, Math.min(targetTickets, fundedPopulation.length));
  const multiDrawCoverage = await createCanonicalMultiDrawCoverage(
    { name, players: players.length }, products, population, hierarchyByScope,
  );
  await Promise.all(players.map((player) => ensurePlayerLiability(player)));
  const draw = await acceptingDrawWithWindow("FAST_KENO_V1", 15);
  for (const scopePlayer of players.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.scope.tenant_id === item.scope.tenant_id) === index)) {
    await ensureDrawLiability(draw, fast, scopePlayer, hierarchyByScope);
  }
  const startedAt = new Date();
  const acceptanceLatencyStart = acceptanceLatencies.length;
  const readLatencyStart = readLatencies.length;
  const counters = { attempted: targetTickets, accepted: 0, duplicates: 0, errors: {}, fastKeno: 0, hotSpot: 0, reads: 0 };
  const requests = Array.from({ length: targetTickets }, (_, index) => {
    const player = players[index % players.length];
    return acceptTicket({
      tierName: name,
      sequence: index + 1,
      product: fast,
      draw,
      player,
      items: burstFastItems(`${campaignId}:${name}:${index + 1}`, targetAverageWagers),
      hierarchyByScope,
    });
  });
  const results = await Promise.all(requests);
  const submissionCompletedAt = new Date();
  const acceptedTicketIds = [];
  for (const result of results) {
    if (result.accepted) {
      counters.accepted += 1;
      counters.fastKeno += 1;
      if (result.duplicate) counters.duplicates += 1;
      acceptedTicketIds.push(result.ticketId);
    } else {
      const classification = classifyError(result.error ?? "unknown");
      counters.errors[classification] = (counters.errors[classification] ?? 0) + 1;
    }
  }
  const realizedItems = acceptedTicketIds.length === 0 ? 0 : Number((await pool.query(`
select count(*)::int item_count
from ticket_authority.ticket_items
where ticket_id=any($1::uuid[])`, [acceptedTicketIds])).rows[0].item_count);
  const milestoneEvidence = await waitForBurstMilestones(acceptedTicketIds, name, 900_000);
  const authoritativeThrough = new Date();
  const completed = await waitForTierDrain(acceptedTicketIds, 60_000, authoritativeThrough);
  const endedAt = new Date();
  const tierConfig = {
    name,
    players: players.length,
    requiredMinutes: 0,
    minutes: Number(((endedAt - startedAt) / 60_000).toFixed(4)),
    ticketsPerSecond: targetTickets / Math.max(0.001, (submissionCompletedAt - startedAt) / 1_000),
    claimable: true,
  };
  const evidence = await collectTierEvidence(
    tierConfig, startedAt, authoritativeThrough, counters, completed,
    acceptanceLatencies.slice(acceptanceLatencyStart), readLatencies.slice(readLatencyStart),
    multiDrawCoverage,
  );
  const correctness = evidence.completeChain && evidence.financialReconciles && evidence.duplicatesAbsent &&
    evidence.chain.cross_player_contamination === 0 && !completed.timeout;
  const fullTargetAccepted = counters.accepted === targetTickets;
  const withinKpi = evidence.resultToWalletLatency.p95Ms !== null &&
    evidence.resultToWalletLatency.p95Ms < 5_000;
  const classification = !correctness ? "BURST_CORRECTNESS_FAILED" :
    !fullTargetAccepted || milestoneEvidence.timeout ? "BURST_CORRECT_BUT_CAPACITY_REACHED" :
    !withinKpi ? "BURST_CORRECT_BUT_LATENCY_DEGRADED" : "BURST_CORRECT_AND_WITHIN_KPI";
  const cutoffRejected = Object.entries(counters.errors)
    .filter(([code]) => code.includes("CUTOFF") || code.includes("NO_ACCEPTING_DRAW"))
    .reduce((total, [, count]) => total + Number(count), 0);
  const burst = {
    ...evidence,
    schemaVersion: "mosera.pr05c.burst-result.v1",
    targetTickets,
    targetAverageWagers,
    drawId: draw.draw_id,
    publicDrawNumber: draw.public_draw_number,
    cutoffAt: draw.cutoff_at,
    submissionStartedAt: startedAt,
    submissionCompletedAt,
    submissionWindowMs: submissionCompletedAt - startedAt,
    submission: {
      requested: targetTickets,
      attempted: counters.attempted,
      accepted: counters.accepted,
      cutoffRejected,
      otherRejected: targetTickets - counters.accepted - cutoffRejected,
      durationMs: submissionCompletedAt - startedAt,
      ticketsPerSecond: targetTickets / Math.max(0.001, (submissionCompletedAt - startedAt) / 1_000),
    },
    realizedTickets: counters.accepted,
    realizedItems,
    realizedWagersPerTicket: counters.accepted === 0 ? 0 :
      Number((realizedItems / counters.accepted).toFixed(3)),
    realizedEvaluations: evidence.chain.math_certificates,
    realizedAggregates: evidence.chain.settlement_inputs,
    milestoneEvidence,
    classification,
    correctness,
    fullTargetAccepted,
  };
  writeJson(`campaign-${name}.json`, burst);
  burstResults.push(burst);
  return burst;
}

async function runFailureInjectionExercise() {
  const executionId = `pr05d-recovery-${randomUUID()}`;
  setCollectorControl(executionId, "FAILURE_INJECTION");
  const evidenceStart = new Date().toISOString();

  await restartGameEngine(0);
  failureEvidence.at(-1).executionId = executionId;

  const settlementStarted = new Date().toISOString();
  requireCommand("docker", ["compose", "restart", "worker-settlement"]);
  await waitFor("Settlement worker recovers", async () => {
    const result = command("docker", ["compose", "ps", "--status", "running", "--services"]);
    return result.status === 0 && result.stdout.split("\n").includes("worker-settlement");
  }, 120_000, 1_000);
  failureEvidence.push({
    executionId,
    type: "SETTLEMENT_WORKER_RESTART",
    started: settlementStarted,
    recoveredAt: new Date().toISOString(),
  });

  const rabbitStarted = new Date().toISOString();
  requireCommand("docker", ["compose", "restart", "rabbitmq"]);
  await waitFor(
    "RabbitMQ Settlement AMQP transport recovers",
    rabbitMqSettlementTransportReady,
    120_000,
    500,
  );
  failureEvidence.push({
    executionId,
    type: "RABBITMQ_RESTART",
    started: rabbitStarted,
    recoveredAt: new Date().toISOString(),
  });

  await waitForAcceptingDraws();
  const endedAt = new Date();
  await finishTierEvidence(executionId, endedAt);
  writeJson("failure-injection-execution.json", {
    schemaVersion: "mosera.pr05d.failure-injection-execution.v1",
    executionId,
    startedAt: evidenceStart,
    endedAt: endedAt.toISOString(),
    events: failureEvidence.filter((item) => item.executionId === executionId),
  });
}

function runHotSpotEvidence(args) {
  const output = requireCommand("dotnet", [
    "run", "--no-build", "--project",
    "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
    "--", "pr04a-hot-spot-evidence", ...args,
  ], { environment: { DATABASE_URL: databaseUrl } });
  return JSON.parse(output.split("\n").filter(Boolean).at(-1));
}

async function createCanonicalMultiDrawCoverage(tierConfig, products, players, hierarchyByScope) {
  if (diagnosticOnly && productMixFast === 1) return [];
  const product = products.find((item) => item.code === "HOT_SPOT_V1");
  let draw;
  try {
    draw = await waitFor("accepting Hot Spot draw for canonical multi-draw coverage", async () =>
      await acceptingDraw("HOT_SPOT_V1"), 5 * 60_000, 500);
  } catch {
    return [{ accepted: false, error: "No accepting Hot Spot draw for canonical multi-draw coverage." }];
  }
  const fundedPlayers = players.filter((player) => player.cohort !== "NEAR_FUNDS");
  if (!fundedPlayers.length) {
    return [{ accepted: false, error: "No funded player available for canonical multi-draw coverage." }];
  }
  const results = [];
  for (const [index, drawCount] of [1, 5, 10, 20].entries()) {
    const sequence = `quick-pick-${drawCount}-${randomUUID()}`;
    const key = `pr05-quick-pick:${campaignId}:${tierConfig.name}:${drawCount}`;
    const requiredBalance = drawCount * 100;
    const available = (await pool.query(`
select scope.player_id,
  (case when scope.instrument_code='CREDIT'
     then coalesce(wallet.credit_limit,0)+coalesce(wallet.balance,0)
     else coalesce(wallet.balance,0) end -
   coalesce(sum(reservation.remaining_exposure),0))::bigint available_balance
from credit_wallet_service.wallet_scopes scope
join public.financial_wallets wallet on wallet.id=scope.wallet_id
left join public.credit_reservations reservation
  on reservation.wallet_id=scope.wallet_id and reservation.scope_model='CANONICAL'
where scope.player_id=any($1::uuid[])
group by scope.player_id,scope.instrument_code,wallet.credit_limit,wallet.balance
having (case when scope.instrument_code='CREDIT'
     then coalesce(wallet.credit_limit,0)+coalesce(wallet.balance,0)
     else coalesce(wallet.balance,0) end -
   coalesce(sum(reservation.remaining_exposure),0)) >= $2
order by available_balance desc,scope.player_id`, [
      fundedPlayers.map((candidate) => candidate.accountId), requiredBalance,
    ])).rows;
    const eligibleIds = new Set(available.map((candidate) => candidate.player_id));
    const eligiblePlayers = fundedPlayers.filter((candidate) => eligibleIds.has(candidate.accountId));
    if (!eligiblePlayers.length) {
      results.push({ accepted: false, drawCount, error: "No player has sufficient authoritative Wallet availability." });
      continue;
    }
    const player = eligiblePlayers[stableIndex(`${key}:player`, eligiblePlayers.length)];
    const selection = runHotSpotEvidence([
      "quick-pick", randomUUID(), key, String(1 + stableIndex(key, 10)),
      product.definition_hash, "qa:pr05",
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
          bullseyePurchased: index % 2 === 1,
          quickPickSelectionId: selection.selectionId,
          multiDrawCount: drawCount,
        },
        stakeMinor: 100,
      }],
      hierarchyByScope,
    });
    if (!result.accepted) {
      results.push({ ...result, drawCount, selection });
      continue;
    }
    try {
      const plan = runHotSpotEvidence([
        "multi-draw", randomUUID(), result.ticketId, String(drawCount), "100", key,
      ]);
      results.push({ ...result, drawCount, selection, plan });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      anomaly("HOT_SPOT_MULTI_DRAW_COVERAGE_BLOCKED", "HIGH",
        "Canonical Hot Spot multi-draw coverage could not resolve immutable bindings.",
        { drawCount, message });
      results.push({ ...result, drawCount, selection, error: message });
    }
  }
  return results;
}

async function waitForTierDrain(ticketIds, timeoutMs, authoritativeThrough) {
  if (!ticketIds.length) return { completed: 0, expected: 0, timeout: false };
  try {
    return await waitFor("due campaign participation financial completion", async () => {
      const row = (await pool.query(`
with campaign_items as (
  select ticket.ticket_id,item.ticket_item_id,
    coalesce(participation.draw_id,ticket.draw_id) draw_id,
    event.participation_id is not null cancelled
  from ticket_authority.tickets ticket
  join ticket_authority.ticket_items item using(ticket_id)
  left join game_engine.hot_spot_multi_draw_participations participation
    on participation.ticket_item_id=item.ticket_item_id
  left join game_engine.hot_spot_multi_draw_participation_events event
    on event.participation_id=participation.participation_id and event.event_type='CANCELLED'
  where ticket.ticket_id=any($1::uuid[])
), due_items as (
  select item.ticket_id,item.ticket_item_id,item.draw_id,draw.product_code
  from campaign_items item
  join game_engine.durable_scheduler_draws draw on draw.draw_id=item.draw_id
  where draw.authoritative_result_at is not null
    and draw.authoritative_result_at <= $2
    and not item.cancelled
), financial_units as (
  select distinct case when product_code='FAST_KENO_V1'
    then ticket_id::text || ':' || draw_id::text
    else ticket_item_id::text end unit_id
  from due_items
), settlement_sources as (
  select item.ticket_item_id,item.ticket_id,item.draw_id,item.product_code,record.settlement_id
  from due_items item
  join settlement_service.authoritative_settlement_records record
    on record.ticket_line_id=item.ticket_item_id::text
    or exists (
      select 1 from game_engine.ticket_draw_settlement_aggregate_items aggregate_item
      join game_engine.ticket_draw_settlement_aggregates aggregate using(settlement_input_id)
      where aggregate_item.ticket_item_id=item.ticket_item_id
        and aggregate.ticket_id=item.ticket_id and aggregate.draw_id=item.draw_id
        and aggregate.settlement_input_id=record.settlement_input_id)
), terminal_eligible_tickets as (
  select distinct item.ticket_id
  from campaign_items item
  where not exists (
    select 1
    from campaign_items pending
    join game_engine.durable_scheduler_draws draw on draw.draw_id=pending.draw_id
    where pending.ticket_id=item.ticket_id
      and not pending.cancelled
      and (draw.authoritative_result_at is null or draw.authoritative_result_at > $2)
  )
), expected_completion_items as (
  select item.ticket_item_id
  from due_items item
  join terminal_eligible_tickets ticket using(ticket_id)
)
select (select count(*)::int from financial_units) expected,
  count(distinct source.settlement_id)::int settlements,
  count(distinct wallet.operation_id) filter (where wallet.terminal_status='COMMITTED')::int completed,
  (select count(*)::int from expected_completion_items) expected_completion_sources,
  (select count(*)::int
   from ticket_completion_authority.completion_sources source
   join expected_completion_items item using(ticket_item_id)) completion_sources,
  (select count(*)::int from terminal_eligible_tickets) expected_completions,
  (select count(*)::int
   from ticket_completion_authority.completion_evidence evidence
   join terminal_eligible_tickets ticket using(ticket_id)) completions
from settlement_sources source
left join credit_wallet_service.wallet_operation_requests request
  on request.settlement_id=source.settlement_id
left join credit_wallet_service.wallet_operation_terminal_results wallet
  on wallet.operation_id=request.operation_id`, [ticketIds, authoritativeThrough])).rows[0];
      return row.completed === row.expected &&
        row.settlements === row.expected &&
        row.completion_sources === row.expected_completion_sources &&
        row.completions === row.expected_completions &&
        row.expected > 0
        ? { ...row, timeout: false }
        : null;
    }, timeoutMs, 1_000);
  } catch (error) {
    anomaly("FINANCIAL_COMPLETION_TIMEOUT", "HIGH", "Tier did not clear due financial completion before timeout.", {
      ticketCount: ticketIds.length, error: error instanceof Error ? error.message : String(error),
    });
    return { completed: 0, expected: ticketIds.length, timeout: true };
  }
}

async function collectTierEvidence(
  tierConfig, startedAt, endedAt, counters, completed, tierAcceptanceLatencies,
  tierReadLatencies, multiDrawCoverage, evidenceContinuity,
) {
  const prefix = `pr05-${campaignId}-${tierConfig.name}-%`;
  const chain = (await pool.query(`
with campaign_tickets as (
  select * from ticket_authority.tickets where external_ticket_id like $1
), campaign_items as (
  select item.*,coalesce(participation.draw_id,ticket.draw_id) effective_draw_id,
    participation.participation_id,
    participation.draw_sequence,
    cancellation.participation_id is not null cancelled
  from ticket_authority.ticket_items item
  join campaign_tickets ticket using(ticket_id)
  left join game_engine.hot_spot_multi_draw_participations participation
    on participation.ticket_item_id=item.ticket_item_id
  left join game_engine.hot_spot_multi_draw_participation_events cancellation
    on cancellation.participation_id=participation.participation_id
   and cancellation.event_type='CANCELLED'
), campaign_draws as (
  select distinct draw.*
  from game_engine.durable_scheduler_draws draw
  join campaign_items item on item.effective_draw_id=draw.draw_id
), due_items as (
  select item.*,draw.product_code
  from campaign_items item
  join campaign_draws draw on draw.draw_id=item.effective_draw_id
  where draw.authoritative_result_at is not null
    and draw.authoritative_result_at <= $2
    and not item.cancelled
), financial_units as (
  select distinct case when product_code='FAST_KENO_V1'
    then ticket_id::text || ':' || effective_draw_id::text
    else ticket_item_id::text end unit_id
  from due_items
), settlement_sources as (
  select distinct item.ticket_item_id,item.ticket_id,item.effective_draw_id,item.product_code,
    record.settlement_id,record.settlement_input_id,record.gross_payout_amount_minor
  from due_items item
  join settlement_service.authoritative_settlement_records record
    on record.ticket_line_id=item.ticket_item_id::text
    or exists (
      select 1 from game_engine.ticket_draw_settlement_aggregate_items aggregate_item
      join game_engine.ticket_draw_settlement_aggregates aggregate using(settlement_input_id)
      where aggregate_item.ticket_item_id=item.ticket_item_id
        and aggregate.ticket_id=item.ticket_id and aggregate.draw_id=item.effective_draw_id
        and aggregate.settlement_input_id=record.settlement_input_id)
), terminal_eligible_tickets as (
  select ticket.ticket_id
  from campaign_tickets ticket
  where not exists (
    select 1
    from campaign_items item
    join campaign_draws draw on draw.draw_id=item.effective_draw_id
    where item.ticket_id=ticket.ticket_id
      and not item.cancelled
      and (draw.authoritative_result_at is null or draw.authoritative_result_at > $2)
  )
), expected_completion_items as (
  select item.ticket_item_id
  from due_items item
  join terminal_eligible_tickets ticket using(ticket_id)
)
select
  (select count(*)::int from campaign_tickets) tickets,
  (select count(*)::int from campaign_items) items,
  (select count(*)::int from campaign_draws) draws,
  (select count(*)::int from campaign_draws where product_code='FAST_KENO_V1'
    and scheduled_execution_at <= $2) fast_draws,
  (select count(*)::int from campaign_draws where product_code='HOT_SPOT_V1'
    and scheduled_execution_at <= $2) hot_draws,
  (select count(*)::int from campaign_draws where authoritative_result_at is not null
    and authoritative_result_at <= $2) outcomes,
  (select count(*)::int from due_items) due_items,
  (select count(*)::int from campaign_items where cancelled) cancelled_items,
  (select count(*)::int from campaign_items item join campaign_draws draw
    on draw.draw_id=item.effective_draw_id where not item.cancelled
    and (draw.authoritative_result_at is null or draw.authoritative_result_at > $2)) future_items,
  (select count(*)::int from game_engine.math_evaluation_certificates certificate
    join due_items item on item.ticket_item_id::text=certificate.ticket_reference) math_certificates,
  (select count(distinct settlement_input_id)::int from settlement_sources) settlement_inputs,
  (select count(distinct settlement_id)::int from settlement_sources) settlements,
  (select count(distinct settlement_id)::int from settlement_sources
    where gross_payout_amount_minor>0) expected_ledger_effects,
  (select count(*)::int from financial_units) expected_financial_units,
  (select count(*)::int from ticket_completion_authority.completion_sources source
    join expected_completion_items item using(ticket_item_id)) completion_sources,
  (select count(*)::int from expected_completion_items) expected_completion_sources,
  (select count(*)::int from ledger_service.ledger_transactions ledger
    join credit_wallet_service.wallet_operation_requests wallet
      on wallet.ledger_instruction_id::text=ledger.instruction_id
    join (select distinct settlement_id from settlement_sources) source
      on source.settlement_id=wallet.settlement_id) ledger_effects,
  (select count(*)::int from credit_wallet_service.wallet_operation_terminal_results wallet
    join credit_wallet_service.wallet_operation_requests request using(operation_id)
    join (select distinct settlement_id from settlement_sources) source
      on source.settlement_id=request.settlement_id
    where wallet.terminal_status='COMMITTED') wallet_effects,
  (select count(*)::int from ticket_completion_authority.completion_evidence completion
    join terminal_eligible_tickets ticket using(ticket_id)) completions,
  (select count(*)::int from terminal_eligible_tickets) expected_completions,
  (select count(*)::int from public.credit_reservations reservation
    join campaign_tickets ticket on ticket.reservation_id=reservation.id
    where reservation.remaining_exposure=0 and reservation.status='CAPTURED') closed_reservations,
  (select count(*)::int from (select execution_manifest_id from game_engine.outcome_events
    where execution_manifest_id in (select execution_manifest_id from game_engine.draw_execution_manifests manifest join campaign_draws draw using(draw_id))
    group by execution_manifest_id having count(*)>1) duplicate) duplicate_outcomes,
  (select count(*)::int from (
    select case when source.product_code='FAST_KENO_V1'
      then source.ticket_id::text || ':' || source.effective_draw_id::text
      else source.ticket_item_id::text end unit_id
    from settlement_sources source
    group by 1 having count(distinct source.settlement_id)>1) duplicate) duplicate_settlements,
  (select count(*)::int from (select certificate.ticket_reference
    from game_engine.math_evaluation_certificates certificate
    join due_items item on item.ticket_item_id::text=certificate.ticket_reference
    group by certificate.ticket_reference having count(*)>1) duplicate) duplicate_evaluations,
  (select count(*)::int from (select source.ticket_item_id from ticket_completion_authority.completion_sources source
    join due_items item using(ticket_item_id) group by source.ticket_item_id having count(*)>1) duplicate) duplicate_completion_sources,
  (select count(*)::int from (select ledger.posting_request_id
    from ledger_service.ledger_transactions ledger
    join credit_wallet_service.wallet_operation_requests wallet
      on wallet.ledger_instruction_id::text=ledger.instruction_id
    join (select distinct settlement_id from settlement_sources) source
      on source.settlement_id=wallet.settlement_id
    group by ledger.posting_request_id having count(*)>1) duplicate) duplicate_ledger_effects,
  (select count(*)::int from (select wallet.operation_id
    from credit_wallet_service.wallet_operation_terminal_results wallet
    join credit_wallet_service.wallet_operation_requests request using(operation_id)
    join (select distinct settlement_id from settlement_sources) source
      on source.settlement_id=request.settlement_id
    group by wallet.operation_id having count(*)>1) duplicate) duplicate_wallet_effects,
  (select count(*)::int from campaign_tickets ticket join public.credit_reservations reservation on reservation.id=ticket.reservation_id
    where reservation.player_id<>ticket.player_account_id) cross_player_contamination
`, [prefix, endedAt])).rows[0];

  const drawStageRows = (await pool.query(`
with campaign_draws as (
  select distinct draw.*
  from ticket_authority.tickets ticket
  join ticket_authority.ticket_items item using(ticket_id)
  left join game_engine.hot_spot_multi_draw_participations participation
    on participation.ticket_item_id=item.ticket_item_id
  join game_engine.durable_scheduler_draws draw
    on draw.draw_id=coalesce(participation.draw_id,ticket.draw_id)
  where ticket.external_ticket_id like $1
    and draw.authoritative_result_at is not null
    and draw.authoritative_result_at <= $2
), stages as (
  select draw.draw_id,draw.product_code,draw.scheduled_execution_at,
    due.occurred_at detected_at,
    claim.occurred_at claimed_at,
    execution.claimed_at provider_claimed_at,
    evidence.started_at provider_started_at,
    evidence.completed_at provider_completed_at,
    certificate.issued_at certificate_issued_at,
    outcome.published_at outcome_published_at
  from campaign_draws draw
  join game_engine.draw_execution_manifests manifest using(draw_id)
  join game_engine.outcome_provider_executions execution using(execution_manifest_id)
  join game_engine.outcome_provider_execution_evidence evidence
    on evidence.execution_id=execution.execution_id and evidence.status='AUTHORITATIVE'
  join game_engine.canonical_outcome_versions outcome
    on outcome.execution_manifest_id=manifest.execution_manifest_id
   and outcome.version_kind='Published'
  join game_engine.outcome_certificates certificate
    on certificate.certificate_id=outcome.outcome_certificate_id
  left join lateral (
    select min(occurred_at) occurred_at
    from game_engine.durable_scheduler_events event
    where event.draw_id=draw.draw_id and event.scheduler_state='ExecutionDue'
  ) due on true
  left join lateral (
    select min(occurred_at) occurred_at
    from game_engine.durable_scheduler_execution_attempts attempt
    where attempt.draw_id=draw.draw_id and attempt.attempt_status='CLAIMED'
  ) claim on true
)
select *,
  extract(epoch from (detected_at-scheduled_execution_at))*1000 due_to_detection_ms,
  extract(epoch from (claimed_at-detected_at))*1000 detection_to_claim_ms,
  extract(epoch from (provider_started_at-claimed_at))*1000 claim_to_provider_ms,
  extract(epoch from (provider_completed_at-provider_started_at))*1000 provider_execution_ms,
  extract(epoch from (outcome_published_at-provider_completed_at))*1000 evidence_to_outcome_ms,
  extract(epoch from (certificate_issued_at-provider_started_at))*1000 certificate_issuance_ms,
  extract(epoch from (outcome_published_at-scheduled_execution_at))*1000 due_to_result_ms
from stages order by scheduled_execution_at`, [prefix, endedAt])).rows;

  const mathAdmissionRows = (await pool.query(`
with campaign_items as (
  select item.ticket_item_id,coalesce(participation.draw_id,ticket.draw_id) draw_id
  from ticket_authority.tickets ticket
  join ticket_authority.ticket_items item using(ticket_id)
  left join game_engine.hot_spot_multi_draw_participations participation
    on participation.ticket_item_id=item.ticket_item_id
  where ticket.external_ticket_id like $1
), completed_math as (
  select item.draw_id,request.evaluation_request_id,request.created_at admission_started_at,
    request.admitted_at,
    attempt.started_at execution_started_at,attempt.completed_at evaluation_completed_at
  from campaign_items item
  join game_engine.math_evaluation_requests request
    on request.ticket_reference=item.ticket_item_id::text and request.status='Completed'
  join lateral (
    select started_at,completed_at
    from game_engine.math_evaluation_attempts attempt
    where attempt.evaluation_request_id=request.evaluation_request_id
      and attempt.status='Completed'
    order by attempt.attempt_number desc limit 1
  ) attempt on true
)
select math.*,outcome.published_at result_at,
  extract(epoch from (math.admission_started_at-outcome.published_at))*1000 result_to_admission_start_ms,
  extract(epoch from (math.admitted_at-math.admission_started_at))*1000 admission_duration_ms,
  extract(epoch from (math.admitted_at-outcome.published_at))*1000 result_to_admitted_ms,
  extract(epoch from (math.execution_started_at-math.admitted_at))*1000 admitted_to_execution_ms,
  extract(epoch from (math.evaluation_completed_at-math.execution_started_at))*1000 raw_math_ms,
  extract(epoch from (math.evaluation_completed_at-outcome.published_at))*1000 result_to_math_ms
from completed_math math
join game_engine.canonical_outcome_versions outcome
  on outcome.draw_id=math.draw_id and outcome.version_kind='Published'
order by math.draw_id,math.admitted_at,math.evaluation_request_id`, [prefix])).rows;

  const financialStageRows = (await pool.query(`
with campaign_items as (
  select ticket.ticket_id,item.ticket_item_id,
    coalesce(participation.draw_id,ticket.draw_id) draw_id,draw.product_code
  from ticket_authority.tickets ticket
  join ticket_authority.ticket_items item using(ticket_id)
  left join game_engine.hot_spot_multi_draw_participations participation
    on participation.ticket_item_id=item.ticket_item_id
  join game_engine.durable_scheduler_draws draw
    on draw.draw_id=coalesce(participation.draw_id,ticket.draw_id)
  where ticket.external_ticket_id like $1
    and draw.authoritative_result_at is not null
    and draw.authoritative_result_at <= $2
), campaign_inputs as (
  select distinct input.*,aggregate.ticket_id aggregate_ticket_id,
    aggregate.draw_id aggregate_draw_id,aggregate.created_at aggregate_created_at
  from game_engine.settlement_input_records input
  left join game_engine.ticket_draw_settlement_aggregates aggregate using(settlement_input_id)
  where exists (
    select 1 from campaign_items item
    where (aggregate.ticket_id=item.ticket_id and aggregate.draw_id=item.draw_id)
       or (aggregate.settlement_input_id is null and input.ticket_reference=item.ticket_item_id::text))
), math_stages as (
  select input.settlement_input_id,
    min(math.created_at) evaluation_admission_started_at,
    max(math.admitted_at) evaluation_admitted_at,
    min(math_attempt.started_at) evaluation_started_at,
    max(math_attempt.completed_at) evaluation_at
  from campaign_inputs input
  join campaign_items item
    on (input.aggregate_ticket_id=item.ticket_id and input.aggregate_draw_id=item.draw_id)
    or (input.aggregate_ticket_id is null and input.ticket_reference=item.ticket_item_id::text)
  join game_engine.math_evaluation_requests math
    on math.ticket_reference=item.ticket_item_id::text and math.status='Completed'
  join lateral (
    select attempt.started_at,attempt.completed_at
    from game_engine.math_evaluation_attempts attempt
    where attempt.evaluation_request_id=math.evaluation_request_id
      and attempt.status='Completed'
    order by attempt.attempt_number desc limit 1
  ) math_attempt on true
  group by input.settlement_input_id
)
select input.settlement_input_id,outcome.published_at result_at,
  math.evaluation_admission_started_at,math.evaluation_admitted_at,
  math.evaluation_started_at,
  math.evaluation_at,
  coalesce(input.aggregate_created_at,input.created_at) settlement_input_at,
  processing.outbox_created_at settlement_work_created_at,
  processing.outbox_published_at settlement_work_published_at,
  processing.dispatcher_seen_at settlement_dispatcher_seen_at,
  processing.publish_started_at settlement_publish_started_at,
  processing.publish_confirmed_at settlement_publish_confirmed_at,
  processing.consumer_received_at settlement_consumer_received_at,
  processing.consumer_processing_started_at settlement_consumer_processing_started_at,
  processing.consumer_callback_entered_at settlement_callback_entered_at,
  processing.execution_slot_requested_at settlement_slot_requested_at,
  processing.execution_slot_acquired_at settlement_slot_acquired_at,
  processing.handler_started_at settlement_handler_started_at,
  processing.consumer_instance_id settlement_consumer_instance_id,
  processing.consumer_prefetch settlement_consumer_prefetch,
  processing.consumer_execution_concurrency settlement_consumer_execution_concurrency,
  processing.active_handlers_at_start settlement_active_handlers_at_start,
  processing.waiting_handlers_at_start settlement_waiting_handlers_at_start,
  processing.consumed_at settlement_consumed_at,
  processing.processing_started_at settlement_started_at,
  processing.authority_started_at settlement_authority_started_at,
  processing.authority_completed_at settlement_authority_completed_at,
  processing.processing_completed_at settlement_processing_completed_at,
  settlement.issued_at settlement_at,ledger.created_at ledger_at,
  wallet.completed_at wallet_at,completion.completed_at completion_at,
  extract(epoch from (ledger_execution.target_service_received_at-ledger_execution.target_request_started_at))*1000 ledger_network_admission_ms,
  extract(epoch from (ledger_execution.target_service_completed_at-ledger_execution.target_service_received_at))*1000 ledger_service_ms,
  extract(epoch from (ledger_execution.target_response_received_at-ledger_execution.target_service_completed_at))*1000 ledger_response_ms,
  extract(epoch from (ledger_execution.target_response_received_at-ledger_execution.target_request_started_at))*1000 ledger_client_total_ms,
  extract(epoch from (wallet_execution.target_service_received_at-wallet_execution.target_request_started_at))*1000 wallet_network_admission_ms,
  extract(epoch from (wallet_execution.target_service_completed_at-wallet_execution.target_service_received_at))*1000 wallet_service_ms,
  extract(epoch from (wallet_execution.target_response_received_at-wallet_execution.target_service_completed_at))*1000 wallet_response_ms,
  extract(epoch from (wallet_execution.target_response_received_at-wallet_execution.target_request_started_at))*1000 wallet_client_total_ms,
  extract(epoch from (math.evaluation_admission_started_at-outcome.published_at))*1000 result_to_admission_start_ms,
  extract(epoch from (math.evaluation_admitted_at-math.evaluation_admission_started_at))*1000 admission_duration_ms,
  extract(epoch from (math.evaluation_started_at-math.evaluation_admitted_at))*1000 evaluation_queue_wait_ms,
  extract(epoch from (math.evaluation_at-math.evaluation_started_at))*1000 evaluation_processing_ms,
  extract(epoch from (math.evaluation_at-outcome.published_at))*1000 result_to_evaluation_ms,
  extract(epoch from (coalesce(input.aggregate_created_at,input.created_at)-math.evaluation_at))*1000 evaluation_to_input_ms,
  extract(epoch from (processing.outbox_created_at-coalesce(input.aggregate_created_at,input.created_at)))*1000 settlement_input_to_outbox_ready_ms,
  extract(epoch from (processing.dispatcher_seen_at-processing.outbox_created_at))*1000 settlement_outbox_ready_to_dispatcher_seen_ms,
  extract(epoch from (processing.publish_started_at-processing.dispatcher_seen_at))*1000 settlement_dispatcher_seen_to_publish_start_ms,
  extract(epoch from (processing.publish_confirmed_at-processing.publish_started_at))*1000 settlement_publish_confirm_ms,
  extract(epoch from (processing.consumer_received_at-processing.publish_started_at))*1000 settlement_publish_start_to_consumer_receive_ms,
  extract(epoch from (processing.consumer_received_at-processing.publish_confirmed_at))*1000 settlement_publish_confirm_to_delivery_ms,
  extract(epoch from (processing.consumer_callback_entered_at-processing.consumer_received_at))*1000 settlement_delivery_to_callback_ms,
  extract(epoch from (processing.execution_slot_requested_at-processing.consumer_callback_entered_at))*1000 settlement_callback_to_slot_request_ms,
  extract(epoch from (processing.execution_slot_acquired_at-processing.execution_slot_requested_at))*1000 settlement_slot_admission_ms,
  extract(epoch from (processing.handler_started_at-processing.execution_slot_acquired_at))*1000 settlement_slot_to_handler_ms,
  extract(epoch from (processing.authority_started_at-processing.handler_started_at))*1000 settlement_handler_to_authority_ms,
  extract(epoch from (processing.persistence_started_at-processing.authority_completed_at))*1000 settlement_financial_instruction_ms,
  extract(epoch from (processing.processing_completed_at-processing.handler_started_at))*1000 settlement_handler_lifetime_ms,
  extract(epoch from (processing.consumer_processing_started_at-processing.consumer_received_at))*1000 settlement_consumer_admission_wait_ms,
  extract(epoch from (processing.authority_started_at-processing.consumer_processing_started_at))*1000 settlement_pre_authority_ms,
  extract(epoch from (processing.authority_completed_at-processing.authority_started_at))*1000 settlement_authority_ms,
  extract(epoch from (processing.outbox_published_at-processing.outbox_created_at))*1000 settlement_publish_wait_ms,
  extract(epoch from (processing.consumed_at-processing.outbox_published_at))*1000 settlement_queue_wait_ms,
  extract(epoch from (processing.processing_completed_at-processing.processing_started_at))*1000 settlement_processing_ms,
  extract(epoch from (settlement.issued_at-coalesce(input.aggregate_created_at,input.created_at)))*1000 input_to_settlement_ms,
  extract(epoch from (ledger.created_at-settlement.issued_at))*1000 settlement_to_ledger_ms,
  extract(epoch from (wallet.completed_at-ledger.created_at))*1000 ledger_to_wallet_ms,
  extract(epoch from (wallet.completed_at-outcome.published_at))*1000 result_to_wallet_ms,
  extract(epoch from (completion.completed_at-wallet.completed_at))*1000 wallet_to_completion_ms,
  extract(epoch from (completion.completed_at-outcome.published_at))*1000 result_to_completion_ms
from campaign_inputs input
join math_stages math using(settlement_input_id)
join game_engine.canonical_outcome_versions outcome
  on outcome.draw_id=coalesce(input.aggregate_draw_id,
    (select item.draw_id from campaign_items item
     where item.ticket_item_id::text=input.ticket_reference limit 1))
 and outcome.version_kind='Published'
join game_engine.outcome_settlement_requests settlement_request
  on settlement_request.settlement_input_id=input.settlement_input_id
join lateral (
  select evidence.*
  from game_engine.canonical_settlement_event_processing_evidence evidence
  where evidence.settlement_request_id=settlement_request.settlement_request_id
    and evidence.classification in ('SUCCESS','IDEMPOTENT_DUPLICATE')
  order by evidence.attempt_number desc limit 1
) processing on true
join settlement_service.authoritative_settlement_records settlement
  on settlement.settlement_input_id=input.settlement_input_id
left join lateral (
  select attempt.* from settlement_service.financial_instruction_execution_attempts attempt
  where attempt.settlement_id=settlement.settlement_id
    and attempt.target_service='ledger-service'
    and attempt.status in ('Posted','Skipped')
  order by attempt.attempt_number desc limit 1
) ledger_execution on true
left join lateral (
  select attempt.* from settlement_service.financial_instruction_execution_attempts attempt
  where attempt.settlement_id=settlement.settlement_id
    and attempt.target_service='credit-wallet-service'
    and attempt.status in ('Posted','Skipped')
  order by attempt.attempt_number desc limit 1
) wallet_execution on true
join credit_wallet_service.wallet_operation_requests wallet_request
  on wallet_request.settlement_id=settlement.settlement_id
left join ledger_service.ledger_transactions ledger
  on ledger.instruction_id=wallet_request.ledger_instruction_id::text
join credit_wallet_service.wallet_operation_terminal_results wallet
  on wallet.operation_id=wallet_request.operation_id and wallet.terminal_status='COMMITTED'
left join lateral (
  select item.ticket_id from campaign_items item
  where (input.aggregate_ticket_id=item.ticket_id and input.aggregate_draw_id=item.draw_id)
     or (input.aggregate_ticket_id is null and input.ticket_reference=item.ticket_item_id::text)
  limit 1
) input_ticket on true
left join ticket_completion_authority.completion_evidence completion
  on completion.ticket_id=coalesce(input.aggregate_ticket_id,input_ticket.ticket_id)
order by outcome.published_at,input.settlement_input_id`, [prefix, endedAt])).rows;

  const financial = (await pool.query(`
with campaign_tickets as (
  select * from ticket_authority.tickets where external_ticket_id like $1
), campaign_items as (
  select item.*,coalesce(participation.draw_id,ticket.draw_id) draw_id,
    cancellation.participation_id is not null cancelled
  from campaign_tickets ticket
  join ticket_authority.ticket_items item using(ticket_id)
  left join game_engine.hot_spot_multi_draw_participations participation
    on participation.ticket_item_id=item.ticket_item_id
  left join game_engine.hot_spot_multi_draw_participation_events cancellation
    on cancellation.participation_id=participation.participation_id
   and cancellation.event_type='CANCELLED'
), cutoff_items as (
  select item.*,draw.authoritative_result_at
  from campaign_items item
  join game_engine.durable_scheduler_draws draw using(draw_id)
), due_items as (
  select item.*,draw.product_code
  from cutoff_items item
  join game_engine.durable_scheduler_draws draw using(draw_id)
  where draw.authoritative_result_at is not null
    and draw.authoritative_result_at <= $2
    and not item.cancelled
), campaign_settlements as (
  select distinct record.*
  from settlement_service.authoritative_settlement_records record
  join due_items item
    on record.ticket_line_id=item.ticket_item_id::text
    or exists (
      select 1 from game_engine.ticket_draw_settlement_aggregate_items aggregate_item
      join game_engine.ticket_draw_settlement_aggregates aggregate using(settlement_input_id)
      where aggregate_item.ticket_item_id=item.ticket_item_id
        and aggregate.ticket_id=item.ticket_id and aggregate.draw_id=item.draw_id
        and aggregate.settlement_input_id=record.settlement_input_id)
), campaign_wallet as (
  select distinct request.*
  from credit_wallet_service.wallet_operation_requests request
  join campaign_settlements settlement using(settlement_id)
), campaign_ledger as (
  select distinct ledger.*
  from ledger_service.ledger_transactions ledger
  join campaign_wallet wallet on wallet.ledger_instruction_id::text=ledger.instruction_id
)
select
  (select coalesce(sum(reservation.reserved_amount),0)::bigint
   from public.credit_reservations reservation join campaign_tickets ticket
     on ticket.reservation_id=reservation.id) reserved_minor,
  (select coalesce(sum(reservation.captured_amount),0)::bigint
   from public.credit_reservations reservation join campaign_tickets ticket
     on ticket.reservation_id=reservation.id) captured_minor,
  (select coalesce(sum(reservation.released_amount),0)::bigint
   from public.credit_reservations reservation join campaign_tickets ticket
     on ticket.reservation_id=reservation.id) released_minor,
  (select coalesce(sum(reservation.remaining_exposure),0)::bigint
   from public.credit_reservations reservation join campaign_tickets ticket
     on ticket.reservation_id=reservation.id) remaining_minor,
  (select coalesce(sum(stake_minor),0)::bigint from cutoff_items
   where not cancelled and authoritative_result_at is not null
     and authoritative_result_at <= $2) cutoff_captured_minor,
  (select coalesce(sum(stake_minor),0)::bigint from cutoff_items
   where cancelled) cutoff_released_minor,
  (select coalesce(sum(stake_minor),0)::bigint from cutoff_items
   where not cancelled and
     (authoritative_result_at is null or authoritative_result_at > $2)) cutoff_remaining_minor,
  (select coalesce(sum(stake_minor),0)::bigint from due_items) due_stake_minor,
  (select coalesce(sum(record.stake_amount_minor),0)::bigint
   from campaign_settlements record) settled_stake_minor,
  (select coalesce(sum(record.gross_payout_amount_minor),0)::bigint
   from campaign_settlements record) gross_payout_minor,
  (select coalesce(sum(record.net_result_amount_minor),0)::bigint
   from campaign_settlements record) net_result_minor,
  (select coalesce(sum(request.amount_minor),0)::bigint from campaign_wallet request) wallet_stake_minor,
  (select coalesce(sum(request.balance_impact_minor),0)::bigint from campaign_wallet request) wallet_impact_minor,
  (select coalesce(sum(entry.debit_amount),0)::bigint
   from ledger_service.ledger_entries entry join campaign_ledger ledger
     on ledger.id=entry.transaction_id) ledger_debits_minor,
  (select coalesce(sum(entry.credit_amount),0)::bigint
   from ledger_service.ledger_entries entry join campaign_ledger ledger
     on ledger.id=entry.transaction_id) ledger_credits_minor
`, [prefix, endedAt])).rows[0];

  const stageLatency = {
    dueToDetection: latencySummary(drawStageRows.map((row) => Number(row.due_to_detection_ms))),
    detectionToClaim: latencySummary(drawStageRows.map((row) => Number(row.detection_to_claim_ms))),
    claimToProvider: latencySummary(drawStageRows.map((row) => Number(row.claim_to_provider_ms))),
    providerExecution: latencySummary(drawStageRows.map((row) => Number(row.provider_execution_ms))),
    evidenceToOutcomePersistence: latencySummary(drawStageRows.map((row) => Number(row.evidence_to_outcome_ms))),
    certificateIssuance: latencySummary(drawStageRows.map((row) => Number(row.certificate_issuance_ms))),
    scheduledDueToAuthoritativeResult: latencySummary(drawStageRows.map((row) => Number(row.due_to_result_ms))),
    resultToEvaluation: latencySummary(financialStageRows.map((row) => Number(row.result_to_evaluation_ms))),
    resultToAdmissionStart: latencySummary(mathAdmissionRows.map((row) => Number(row.result_to_admission_start_ms))),
    mathAdmissionDuration: latencySummary(mathAdmissionRows.map((row) => Number(row.admission_duration_ms))),
    admittedToEvaluationStart: latencySummary(mathAdmissionRows.map((row) => Number(row.admitted_to_execution_ms))),
    evaluationQueueWait: latencySummary(financialStageRows.map((row) => Number(row.evaluation_queue_wait_ms))),
    evaluationProcessing: latencySummary(mathAdmissionRows.map((row) => Number(row.raw_math_ms))),
    evaluationToAggregate: latencySummary(financialStageRows.map((row) => Number(row.evaluation_to_input_ms))),
    evaluationToSettlementInput: latencySummary(financialStageRows.map((row) => Number(row.evaluation_to_input_ms))),
    settlementInputToOutboxReady: latencySummary(financialStageRows
      .filter((row) => row.settlement_input_to_outbox_ready_ms !== null)
      .map((row) => Number(row.settlement_input_to_outbox_ready_ms))),
    settlementOutboxReadyToDispatcherSeen: latencySummary(financialStageRows
      .filter((row) => row.settlement_outbox_ready_to_dispatcher_seen_ms !== null)
      .map((row) => Number(row.settlement_outbox_ready_to_dispatcher_seen_ms))),
    settlementDispatcherSeenToPublishStart: latencySummary(financialStageRows
      .filter((row) => row.settlement_dispatcher_seen_to_publish_start_ms !== null)
      .map((row) => Number(row.settlement_dispatcher_seen_to_publish_start_ms))),
    settlementPublishConfirm: latencySummary(financialStageRows
      .filter((row) => row.settlement_publish_confirm_ms !== null)
      .map((row) => Number(row.settlement_publish_confirm_ms))),
    settlementPublishStartToConsumerReceive: latencySummary(financialStageRows
      .filter((row) => row.settlement_publish_start_to_consumer_receive_ms !== null)
      .map((row) => Number(row.settlement_publish_start_to_consumer_receive_ms))),
    settlementPublishConfirmToDelivery: latencySummary(financialStageRows
      .filter((row) => row.settlement_publish_confirm_to_delivery_ms !== null)
      .map((row) => Number(row.settlement_publish_confirm_to_delivery_ms))),
    settlementDeliveryToCallback: latencySummary(financialStageRows
      .filter((row) => row.settlement_delivery_to_callback_ms !== null)
      .map((row) => Number(row.settlement_delivery_to_callback_ms))),
    settlementCallbackToSlotRequest: latencySummary(financialStageRows
      .filter((row) => row.settlement_callback_to_slot_request_ms !== null)
      .map((row) => Number(row.settlement_callback_to_slot_request_ms))),
    settlementExecutionSlotAdmission: latencySummary(financialStageRows
      .filter((row) => row.settlement_slot_admission_ms !== null)
      .map((row) => Number(row.settlement_slot_admission_ms))),
    settlementExecutionSlotToHandler: latencySummary(financialStageRows
      .filter((row) => row.settlement_slot_to_handler_ms !== null)
      .map((row) => Number(row.settlement_slot_to_handler_ms))),
    settlementHandlerToAuthority: latencySummary(financialStageRows
      .filter((row) => row.settlement_handler_to_authority_ms !== null)
      .map((row) => Number(row.settlement_handler_to_authority_ms))),
    settlementConsumerAdmissionWait: latencySummary(financialStageRows
      .filter((row) => row.settlement_consumer_admission_wait_ms !== null)
      .map((row) => Number(row.settlement_consumer_admission_wait_ms))),
    settlementPreAuthority: latencySummary(financialStageRows
      .filter((row) => row.settlement_pre_authority_ms !== null)
      .map((row) => Number(row.settlement_pre_authority_ms))),
    settlementAuthority: latencySummary(financialStageRows
      .filter((row) => row.settlement_authority_ms !== null)
      .map((row) => Number(row.settlement_authority_ms))),
    settlementFinancialInstructions: latencySummary(financialStageRows
      .filter((row) => row.settlement_financial_instruction_ms !== null)
      .map((row) => Number(row.settlement_financial_instruction_ms))),
    ledgerNetworkAdmission: latencySummary(financialStageRows
      .filter((row) => row.ledger_network_admission_ms !== null)
      .map((row) => Number(row.ledger_network_admission_ms))),
    ledgerService: latencySummary(financialStageRows
      .filter((row) => row.ledger_service_ms !== null)
      .map((row) => Number(row.ledger_service_ms))),
    ledgerResponse: latencySummary(financialStageRows
      .filter((row) => row.ledger_response_ms !== null)
      .map((row) => Number(row.ledger_response_ms))),
    ledgerClientTotal: latencySummary(financialStageRows
      .filter((row) => row.ledger_client_total_ms !== null)
      .map((row) => Number(row.ledger_client_total_ms))),
    walletNetworkAdmission: latencySummary(financialStageRows
      .filter((row) => row.wallet_network_admission_ms !== null)
      .map((row) => Number(row.wallet_network_admission_ms))),
    walletService: latencySummary(financialStageRows
      .filter((row) => row.wallet_service_ms !== null)
      .map((row) => Number(row.wallet_service_ms))),
    walletResponse: latencySummary(financialStageRows
      .filter((row) => row.wallet_response_ms !== null)
      .map((row) => Number(row.wallet_response_ms))),
    walletClientTotal: latencySummary(financialStageRows
      .filter((row) => row.wallet_client_total_ms !== null)
      .map((row) => Number(row.wallet_client_total_ms))),
    settlementHandlerLifetime: latencySummary(financialStageRows
      .filter((row) => row.settlement_handler_lifetime_ms !== null)
      .map((row) => Number(row.settlement_handler_lifetime_ms))),
    settlementPublishWait: latencySummary(financialStageRows.map((row) => Number(row.settlement_publish_wait_ms))),
    settlementQueueWait: latencySummary(financialStageRows.map((row) => Number(row.settlement_queue_wait_ms))),
    settlementProcessing: latencySummary(financialStageRows.map((row) => Number(row.settlement_processing_ms))),
    settlementInputToSettlement: latencySummary(financialStageRows.map((row) => Number(row.input_to_settlement_ms))),
    settlementToLedger: latencySummary(financialStageRows
      .filter((row) => row.settlement_to_ledger_ms !== null)
      .map((row) => Number(row.settlement_to_ledger_ms))),
    ledgerToWallet: latencySummary(financialStageRows.map((row) => Number(row.ledger_to_wallet_ms))),
    authoritativeResultToWallet: latencySummary(financialStageRows.map((row) => Number(row.result_to_wallet_ms))),
    walletToCompletion: latencySummary(financialStageRows
      .filter((row) => row.wallet_to_completion_ms !== null)
      .map((row) => Number(row.wallet_to_completion_ms))),
    authoritativeResultToCompletion: latencySummary(financialStageRows
      .filter((row) => row.result_to_completion_ms !== null)
      .map((row) => Number(row.result_to_completion_ms))),
  };
  const walletLatencyValues = financialStageRows
    .map((row) => Number(row.result_to_wallet_ms))
    .filter(Number.isFinite);
  const handlerSweep = financialStageRows.flatMap((row) => {
    const started = new Date(row.settlement_handler_started_at).getTime();
    const completed = new Date(row.settlement_processing_completed_at).getTime();
    return Number.isFinite(started) && Number.isFinite(completed)
      ? [{ at: started, delta: 1 }, { at: completed, delta: -1 }]
      : [];
  }).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let activeHandlers = 0;
  let maximumActiveHandlers = 0;
  for (const point of handlerSweep) {
    activeHandlers += point.delta;
    maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
  }
  const consumerCapacity = {
    instances: [...new Set(financialStageRows
      .map((row) => row.settlement_consumer_instance_id)
      .filter(Boolean))].sort(),
    configuredPrefetch: [...new Set(financialStageRows
      .map((row) => Number(row.settlement_consumer_prefetch))
      .filter(Number.isFinite))].sort((left, right) => left - right),
    configuredExecutionConcurrency: [...new Set(financialStageRows
      .map((row) => Number(row.settlement_consumer_execution_concurrency))
      .filter(Number.isFinite))].sort((left, right) => left - right),
    maximumActiveHandlers,
    maximumProcessLocalHandlersAtStart: Math.max(0, ...financialStageRows
      .map((row) => Number(row.settlement_active_handlers_at_start))
      .filter(Number.isFinite)),
    maximumAdmissionWaitersAtStart: Math.max(0, ...financialStageRows
      .map((row) => Number(row.settlement_waiting_handlers_at_start))
      .filter(Number.isFinite)),
  };
  const committedWithin = (thresholdMs) => walletLatencyValues
    .filter((value) => value <= thresholdMs).length;
  const percentageWithin = (thresholdMs) => walletLatencyValues.length === 0 ? 0 :
    Number((committedWithin(thresholdMs) / walletLatencyValues.length * 100).toFixed(3));
  const unsettledAfter = (thresholdMs) => walletLatencyValues
    .filter((value) => value > thresholdMs).length;
  const nextDrawFundsKpi = {
    dueWalletEffects: walletLatencyValues.length,
    committedWithin1SecondPercent: percentageWithin(1_000),
    committedWithin2SecondsPercent: percentageWithin(2_000),
    committedWithin5SecondsPercent: percentageWithin(5_000),
    committedAfter5SecondsPercent: walletLatencyValues.length === 0 ? 0 :
      Number((unsettledAfter(5_000) / walletLatencyValues.length * 100).toFixed(3)),
    unsettledAtNextFastKenoCutoff: unsettledAfter(20_000),
    unsettledAtNextFastKenoDrawOpen: unsettledAfter(25_000),
    unsettledFiveSecondsAfterNextDrawOpen: unsettledAfter(30_000),
    unsettledTwoDrawsLater: unsettledAfter(50_000),
  };
  const admissionByDraw = new Map();
  for (const row of mathAdmissionRows) {
    const values = admissionByDraw.get(row.draw_id) ?? [];
    values.push(Number(row.result_to_admitted_ms));
    admissionByDraw.set(row.draw_id, values);
  }
  const mathAdmissionProgress = Object.fromEntries(
    [["work50", 0.5], ["work95", 0.95], ["work100", 1]].map(([name, quantile]) => [
      name,
      latencySummary([...admissionByDraw.values()].map((values) => percentile(values, quantile))),
    ])
  );
  const schedulerComponents = [
    ["dueToDetection", stageLatency.dueToDetection],
    ["detectionToClaim", stageLatency.detectionToClaim],
    ["claimToProvider", stageLatency.claimToProvider],
    ["providerExecution", stageLatency.providerExecution],
    ["evidenceToOutcomePersistence", stageLatency.evidenceToOutcomePersistence],
  ].sort((left, right) => (right[1].p95Ms ?? -1) - (left[1].p95Ms ?? -1));
  const latencyInvestigation = {
    thresholdMs: 1_000,
    exceeded: (stageLatency.scheduledDueToAuthoritativeResult.p95Ms ?? Infinity) > 1_000,
    largestP95Component: schedulerComponents[0]?.[0] ?? null,
    largestP95ComponentMs: schedulerComponents[0]?.[1].p95Ms ?? null,
  };

  const cadence = (await pool.query(`
with draws as (
 select product_code,scheduled_execution_at,
   lag(scheduled_execution_at) over(partition by product_code order by scheduled_execution_at) previous_at,
   authoritative_result_at
 from game_engine.durable_scheduler_draws draw
 where scheduled_execution_at between $2 and $3
   and exists(
     select 1
     from ticket_authority.tickets ticket
     join ticket_authority.ticket_items item using(ticket_id)
     left join game_engine.hot_spot_multi_draw_participations participation
       on participation.ticket_item_id=item.ticket_item_id
     where coalesce(participation.draw_id,ticket.draw_id)=draw.draw_id
       and ticket.external_ticket_id like $1)
)
select product_code,count(*)::int draws,
  count(*) filter(where authoritative_result_at is null)::int missed,
  max(abs(extract(epoch from (scheduled_execution_at-previous_at)) -
    case when product_code='FAST_KENO_V1' then 25 else 240 end))::float8 maximum_interval_drift_seconds
from draws group by product_code order by product_code`, [prefix, startedAt, endedAt])).rows;
  const backlog = (await pool.query("select * from game_engine.durable_scheduler_operational_status order by product_code")).rows;
  const multiDrawValid = diagnosticOnly && productMixFast === 1 || [1, 5, 10, 20].every((drawCount) => {
    const item = multiDrawCoverage.find((candidate) => candidate.drawCount === drawCount);
    return item?.accepted && item.plan?.drawCount === drawCount &&
      item.plan?.bindings?.length === drawCount &&
      item.plan?.totalReservationMinor === item.plan?.stakePerDrawMinor * drawCount;
  });
  const financialReconciles =
    Number(financial.reserved_minor) === Number(financial.captured_minor) +
      Number(financial.released_minor) + Number(financial.remaining_minor) &&
    Number(financial.reserved_minor) === Number(financial.cutoff_captured_minor) +
      Number(financial.cutoff_released_minor) + Number(financial.cutoff_remaining_minor) &&
    Number(financial.cutoff_captured_minor) === Number(financial.due_stake_minor) &&
    Number(financial.cutoff_captured_minor) === Number(financial.settled_stake_minor) &&
    Number(financial.settled_stake_minor) === Number(financial.wallet_stake_minor) &&
    Number(financial.wallet_impact_minor) === -Number(financial.settled_stake_minor) &&
    Number(financial.ledger_debits_minor) === Number(financial.ledger_credits_minor) &&
    Number(financial.ledger_debits_minor) === Number(financial.gross_payout_minor);
  const unknownErrors = Number(counters.errors.TRANSIENT_OR_UNKNOWN ?? 0) +
    Number(counters.errors.MULTI_DRAW_COVERAGE ?? 0);
  const sustainedDurationSatisfied = diagnosticOnly || tierConfig.minutes >= tierConfig.requiredMinutes;
  const completeChain = chain.due_items === chain.math_certificates &&
    chain.expected_financial_units === chain.settlement_inputs &&
    chain.expected_financial_units === chain.settlements &&
    chain.expected_completion_sources === chain.completion_sources &&
    chain.expected_ledger_effects === chain.ledger_effects &&
    chain.expected_financial_units === chain.wallet_effects &&
    chain.completions === chain.expected_completions;
  const duplicatesAbsent = [
    chain.duplicate_outcomes, chain.duplicate_evaluations, chain.duplicate_settlements,
    chain.duplicate_completion_sources, chain.duplicate_ledger_effects,
    chain.duplicate_wallet_effects,
  ].every((value) => value === 0);
  const downstreamLatencyPass =
    stageLatency.authoritativeResultToWallet.p95Ms !== null &&
    stageLatency.authoritativeResultToWallet.p95Ms < 5_000 &&
    stageLatency.authoritativeResultToWallet.p99Ms <= 7_500;
  if (latencyInvestigation.exceeded) {
    anomaly("SCHEDULED_RESULT_P95_EXCEEDED", "HIGH",
      "Scheduled due-to-authoritative-result p95 exceeded one second.",
      { stageLatency, latencyInvestigation });
  }
  if (!downstreamLatencyPass) {
    anomaly("DOWNSTREAM_LATENCY_KPI_EXCEEDED", "HIGH",
      "Authoritative result-to-Wallet latency exceeded the sustained-tier objective.",
      { tier: tierConfig.name, resultToWallet: stageLatency.authoritativeResultToWallet });
  }
  return {
    schemaVersion: "mosera.pr05.tier-result.v1", campaignId, tier: tierConfig.name,
    requiredMinutes: tierConfig.requiredMinutes, actualMinutes: tierConfig.minutes,
    diagnosticOnly,
    sustainedDurationSatisfied,
    evidenceContinuity,
    configuredPlayers: tierConfig.players, startedAt, endedAt, counters, completed, chain, cadence, backlog,
    canonicalMultiDrawCoverage: multiDrawCoverage,
    financial,
    financialReconciles,
    completeChain,
    duplicatesAbsent,
    acceptanceLatency: latencySummary(tierAcceptanceLatencies),
    stageLatency,
    consumerCapacity,
    nextDrawFundsKpi,
    mathAdmissionProgress,
    latencyInvestigation,
    resultGenerationLatency: stageLatency.scheduledDueToAuthoritativeResult,
    resultToWalletLatency: stageLatency.authoritativeResultToWallet,
    readLatency: latencySummary(tierReadLatencies),
    downstreamLatencyPass,
    pass: chain.tickets > 0 && sustainedDurationSatisfied &&
      (!evidenceContinuity || evidenceContinuity.continuous) &&
      completeChain && multiDrawValid && financialReconciles &&
      duplicatesAbsent && chain.cross_player_contamination === 0 && unknownErrors === 0 &&
      cadence.every((row) => row.missed === 0 && Number(row.maximum_interval_drift_seconds ?? 0) === 0) &&
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
  writeJson("negative-tests.json", { schemaVersion: "mosera.pr05.negative-tests.v1", campaignId, results });
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
where draw.materialized_at >= (select min(accepted_at) from ticket_authority.tickets where sales_channel='PR05')
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
  const burstRows = (summary.bursts ?? []).map((item) =>
    `| ${item.targetTickets} | ${item.realizedTickets} | ${item.realizedItems} | ${item.realizedAggregates} | ${item.resultToWalletLatency.p95Ms ?? "n/a"} | ${item.classification} |`).join("\n");
  const latency = summary.tiers[0]?.stageLatency ?? {};
  const latencyRows = Object.entries(latency).map(([name, value]) =>
    `| ${name} | ${value.samples} | ${value.p50Ms ?? "n/a"} | ${value.p95Ms ?? "n/a"} | ${value.p99Ms ?? "n/a"} | ${value.maxMs ?? "n/a"} |`).join("\n");
  return `# ${pr05dQualification ? "PR-05D Deadlock Closure + Managed Requalification" :
    pr05cQualification ? "PR-05C Sustained + Burst Runtime Capacity Qualification" :
      "PR-05 Managed Runtime / Sustained Pilot Qualification"}\n\n` +
    `Campaign: \`${campaignId}\`  \nBaseline: \`${expectedCommit}\`  \nStatus: **${summary.status}**\n\n` +
    `| Tier | Players | Minutes | Tickets | Items | Result-to-wallet p95 ms | Result |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | --- |\n${rows}\n\n` +
    `## Evidence Continuity\n\n${summary.tiers.map((item) =>
      `- ${item.tier}: ${item.evidenceContinuity?.continuous ? "continuous" : "invalid"}; ` +
      `first ${item.evidenceContinuity?.firstHeartbeat ?? "n/a"}; last ${item.evidenceContinuity?.lastHeartbeat ?? "n/a"}; ` +
      `max gap ${item.evidenceContinuity?.maximumHeartbeatGapMs ?? "n/a"} ms; ` +
      `expected/actual/missing ${item.evidenceContinuity?.expectedSampleCount ?? 0}/` +
      `${item.evidenceContinuity?.actualSampleCount ?? 0}/${item.evidenceContinuity?.missingSampleCount ?? 0}`).join("\n")}\n\n` +
    (pr05cQualification ? `## Burst Qualification\n\n` +
      `| Target tickets | Accepted | Items | Aggregates | Result-to-wallet p95 ms | Classification |\n` +
      `| ---: | ---: | ---: | ---: | ---: | --- |\n${burstRows || "| n/a | n/a | n/a | n/a | n/a | not executed |"}\n\n` : "") +
    `## Latency Decomposition\n\n| Stage | Samples | p50 ms | p95 ms | p99 ms | max ms |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${latencyRows}\n\n` +
    `## Integrity\n\n- CSPRNG: \`${summary.integrity.csprngHash}\`\n` +
    `- Provider fallback count: ${summary.integrity.providerFallback}\n` +
    `- Duplicate effects: \`${JSON.stringify(summary.integrity.duplicateEffects)}\`\n\n` +
    `- Qualification activation teardown: \`${JSON.stringify(summary.qualificationTeardown)}\`\n\n` +
    `## Anomalies\n\n${summary.anomalies.length ? summary.anomalies.map((item) =>
      `- ${item.severity} ${item.code}: ${item.summary}`).join("\n") : "None."}\n\n` +
    `This is controlled qualification evidence, not production activation.\n`;
}

async function stopAllChildren() {
  for (const instance of [...children.keys()]) await stopGameEngine(instance);
}

async function teardown() {
  teardownPromise ??= (async () => {
    await stopEvidenceCollector().catch(() => {});
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
  const maxPlayers = pr05cQualification
    ? Math.max(...tiers.map((item) => item.players), ...burstTargets, 1)
    : Math.max(...tiers.map((item) => item.players));
  const { population, hierarchyByScope } = await createPopulation(baseline.scopes, maxPlayers);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  await startGameEngine(0, publicKeyPem, privateKeyPem);
  await startGameEngine(1, publicKeyPem, privateKeyPem);
  await startEvidenceCollector();
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
  if (pr05dQualification && process.env.PR05_FAILURE_INJECTION !== "false" &&
      ["pilot", "elevated"].every((tierName) => tierResults.some((item) =>
        item.tier === tierName && item.pass && item.sustainedDurationSatisfied))) {
    await runFailureInjectionExercise();
  }
  if (pr05cQualification && !pr05lShortGate && tierResults.every((item) =>
    item.pass && (!pr05kQualification || item.downstreamLatencyPass))) {
    for (const target of burstTargets) {
      const result = await runBurst(target, baseline.products, population, hierarchyByScope);
      if (result.classification === "BURST_CORRECTNESS_FAILED") {
        anomaly("BURST_CORRECTNESS_FAILED", "CRITICAL", `${target}-ticket burst failed correctness gates.`, result);
        break;
      }
    }
  }
  const integrity = await finalIntegrity(baseline.products);
  check("CSPRNG hash remains frozen", integrity.csprngHash === expectedCsprngHash, integrity);
  check("no provider fallback", integrity.providerFallback === 0, integrity);
  check("no duplicate financial effects", Object.values(integrity.duplicateEffects).every((value) => value === 0), integrity);
  await stopAllChildren();
  await restoreQualification();
  productSnapshot.clear();
  availabilityIds.length = 0;
  const qualificationTeardown = (await pool.query(`
select
  (select count(*)::int from game_engine.game_definitions definition
   join game_engine.game_definition_versions version on version.game_definition_id=definition.id
   where definition.code in ('FAST_KENO_V1','HOT_SPOT_V1')
     and (definition.active_version_id is not null
       or version.activation_state<>'INACTIVE'
       or version.assignment_state<>'UNASSIGNED')) active_products,
  (select count(*)::int from game_engine.game_engine_production_activation_events
   where reason_code='PR05_QUALIFICATION_ONLY') qualification_activation_rows,
  (select count(*)::int
   from platform.game_availability availability
   left join lateral (
     select lifecycle.to_status
     from platform.platform_lifecycle_events lifecycle
     where lifecycle.resource='game-availability'
       and lifecycle.record_id=availability.id
     order by lifecycle.created_at desc,lifecycle.event_id desc
     limit 1
   ) lifecycle on true
   where availability.lifecycle_reason='PR05_QUALIFICATION_ONLY'
     and coalesce(lifecycle.to_status,availability.status)='Active') qualification_availability_rows`)).rows[0];
  check("qualification activation fully removed",
    Object.values(qualificationTeardown).every((value) => value === 0), qualificationTeardown);
  const fullPassing = tierResults.filter((item) => item.pass && item.sustainedDurationSatisfied);
  const highest = diagnosticOnly ? null : fullPassing.at(-1)?.tier ?? null;
  const highestSustainableBurst = burstResults.filter((item) =>
    item.fullTargetAccepted && item.correctness && !item.milestoneEvidence.timeout &&
    item.milestoneEvidence.thresholdsMs?.[100] <= 25_000).at(-1)?.targetTickets ?? null;
  const recoveryRequired = process.env.PR05_FAILURE_INJECTION !== "false";
  const sustainedPass = (pr05kQualification
    ? tierResults.some((item) => item.tier === "elevated" && item.pass &&
      item.sustainedDurationSatisfied && item.downstreamLatencyPass &&
      item.evidenceContinuity?.continuous)
    : pr05dQualification
    ? ["pilot", "elevated"].every((tierName) => tierResults.some((item) =>
      item.tier === tierName && item.pass && item.sustainedDurationSatisfied &&
      item.evidenceContinuity?.continuous))
    : tierResults.some((item) =>
      item.tier === "pilot" && item.pass && item.sustainedDurationSatisfied)) &&
    (!recoveryRequired || failureEvidence.length === 3);
  const requiredBurstTargets = [500, 1_000, 2_500, 5_000];
  const meaningfulBurst = pr05lShortGate || !pr05cQualification || (pr05dQualification
    ? requiredBurstTargets.every((target) => burstResults.some((item) =>
      item.targetTickets === target && item.correctness && item.fullTargetAccepted &&
      !item.milestoneEvidence.timeout))
    : burstResults.some((item) =>
      item.targetTickets >= 500 && item.correctness && item.realizedTickets > 0));
  const requiredPass = sustainedPass && meaningfulBurst;
  const summary = {
    schemaVersion: pr05kQualification
      ? "mosera.pr05k.qualification-summary.v1"
      : pr05dQualification
      ? "mosera.pr05d.qualification-summary.v1"
      : pr05cQualification ? "mosera.pr05c.qualification-summary.v1"
      : "mosera.pr05.qualification-summary.v1",
    campaignId,
    baselineCommit: expectedCommit,
    generatedAt: new Date().toISOString(),
    status: pr05lShortGate
      ? requiredPass ? "PR_05L_SHORT_GATE_PASS" : "PR_05L_SHORT_GATE_BLOCKED"
      : diagnosticOnly
      ? requiredPass ? "PR_05B_SHORT_DIAGNOSTIC_PASS" : "PR_05B_SHORT_DIAGNOSTIC_BLOCKED"
      : pr05kQualification
        ? requiredPass ? "PR_05K_SUSTAINED_BURST_QUALIFICATION_PASS" : "PR_05K_SUSTAINED_BURST_QUALIFICATION_BLOCKED"
      : pr05dQualification
        ? requiredPass ? "PR_05D_MANAGED_SUSTAINED_BURST_QUALIFICATION_PASS" : "PR_05D_MANAGED_SUSTAINED_BURST_QUALIFICATION_BLOCKED"
        : pr05cQualification
          ? requiredPass ? "PR_05C_SUSTAINED_BURST_CAPACITY_PASS" : "PR_05C_SUSTAINED_BURST_CAPACITY_BLOCKED"
        : requiredPass ? "PR_05_MANAGED_RUNTIME_QUALIFICATION_PASS" : "PR_05_MANAGED_RUNTIME_QUALIFICATION_BLOCKED",
    highestVerifiedCapacityTier: highest,
    highestSustainableBurst,
    capacityClassification: highestSustainableBurst !== null
      ? `BURST_${highestSustainableBurst}_VERIFIED`
      : highest === "elevated" ? "ELEVATED_SUSTAINED_VERIFIED"
        : highest === "pilot" ? "PILOT_SUSTAINED_VERIFIED"
          : highest === "baseline" ? "BASELINE_SUSTAINED_VERIFIED" : null,
    tiers: tierResults,
    bursts: burstResults,
    failureInjection: failureEvidence,
    integrity,
    qualificationTeardown,
    acceptanceLatency: latencySummary(acceptanceLatencies),
    readLatency: latencySummary(readLatencies),
    anomalies,
    checks,
  };
  writeJson("failure-injection.json", { schemaVersion: "mosera.pr05.failure-injection.v1", campaignId, events: failureEvidence });
  writeJson("anomaly-register.json", { schemaVersion: "mosera.pr05.anomaly-register.v1", campaignId, appendOnly: true, anomalies });
  writeJson("qualification-summary.json", summary);
  writeFileSync(`${evidenceRoot}/qualification-report.md`, reportMarkdown(summary), { flag: "wx" });
  await stopEvidenceCollector();
  writeJson("evidence-manifest.json", { schemaVersion: "mosera.pr05.evidence-manifest.v1", campaignId, artifacts: buildManifest() });
  console.log(JSON.stringify({
    status: summary.status,
    campaignId,
    evidenceRoot,
    highestVerifiedCapacityTier: highest,
    tiers: tierResults.map((item) => ({ tier: item.tier, pass: item.pass, tickets: item.chain.tickets, items: item.chain.items, resultGeneration: item.resultGenerationLatency, resultToWallet: item.resultToWalletLatency })),
    bursts: burstResults.map((item) => ({ target: item.targetTickets, accepted: item.realizedTickets, items: item.realizedItems, aggregates: item.realizedAggregates, classification: item.classification, resultToWallet: item.resultToWalletLatency })),
  }, null, 2));
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
  anomaly("CAMPAIGN_ABORTED", "CRITICAL", "PR-05 campaign aborted before qualification completion.", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  if (statSafe(evidenceRoot)) {
    if (!statSafe(`${evidenceRoot}/anomaly-register.json`)) {
      writeJson("anomaly-register.json", { schemaVersion: "mosera.pr05.anomaly-register.v1", campaignId, appendOnly: true, anomalies });
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
