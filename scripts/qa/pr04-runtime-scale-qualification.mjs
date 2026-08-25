import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const expectedCommit = "a5b922bac074039b34370ff90bb9db13f9cf112b";
const expectedCsprngHash = "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c";
const expectedMigrationHash = "f5c29b8e0280f83b3a901f8d0ac3a2aa5183438f5f5187ad79997c069efc61c5";
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const gameEngineUrl = process.env.GAME_ENGINE_URL ?? "http://127.0.0.1:5500";
const settlementUrl = process.env.SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:5400";
const rabbitManagementUrl = process.env.RABBITMQ_MANAGEMENT_URL ?? "http://127.0.0.1:15672";
const rabbitUser = process.env.RABBITMQ_MANAGEMENT_USER ?? "lottery";
const rabbitPassword = process.env.RABBITMQ_MANAGEMENT_PASSWORD ?? "lottery_dev_password";
const campaignId = process.env.PR04_CAMPAIGN_ID ??
  `pr04-${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(4).toString("hex")}`;
const evidenceRoot = process.env.PR04_EVIDENCE_DIR ?? `.qa/pr-04/${campaignId}`;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const blockers = [];
const anomalies = [];
const checks = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceHash(path) {
  return sha256(readFileSync(path));
}

function command(name, args) {
  try {
    return execFileSync(name, args, { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch (error) {
    return `UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function record(name, passed, evidence = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", evidence });
  return passed;
}

function block(code, summary, evidence = {}) {
  blockers.push({ code, summary, evidence });
}

function anomaly(code, severity, summary, evidence = {}) {
  anomalies.push({
    anomalyId: `${campaignId}:${String(anomalies.length + 1).padStart(3, "0")}`,
    code,
    severity,
    summary,
    evidence,
    observedAt: new Date().toISOString(),
    disposition: "OPEN",
  });
}

async function getJson(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function writeExclusive(path, value) {
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function inspectDatabase() {
  const products = (await pool.query(`
select definition.code, version.id version_id, version.publication_state,
  version.activation_state, version.assignment_state, definition.active_version_id,
  schedule.time_zone_id, schedule.schedule_configuration,
  version.outcome_provider_id, version.outcome_provider_version,
  version.provider_configuration_version
from game_engine.game_definitions definition
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
join game_engine.published_draw_schedule_versions schedule
  on schedule.schedule_version_id=version.schedule_version_id
where definition.code in ('FAST_KENO_V1','HOT_SPOT_V1')
order by definition.code, version.version_number desc;
`)).rows;
  const authorityStages = (await pool.query(`
select provider_id,provider_version,configuration_version,stage,created_at
from game_engine.game_engine_production_activation_events
order by created_at,activation_event_id;
`)).rows;
  const scheduler = (await pool.query(`
select
  (select count(*)::int from game_engine.durable_scheduler_draws) materialized_draws,
  (select count(*)::int from game_engine.scheduler_settlement_kpi_events) kpi_events,
  (select count(*)::int from game_engine.scheduler_settlement_latency_evidence) latency_rows,
  (select count(*)::int from game_engine.durable_scheduler_execution_attempts) execution_attempts;
`)).rows[0];
  const connections = (await pool.query(`
select count(*)::int total,
  count(*) filter(where state='active')::int active,
  count(*) filter(where wait_event_type='Lock')::int lock_waiters
from pg_stat_activity where datname=current_database();
`)).rows[0];
  const fullChainControlCompatibleTicketCount = Number((await pool.query(`
select count(*)::int count
from ticket_authority.tickets ticket
join game_engine.paytable_definitions paytable on paytable.id=ticket.paytable_definition_id
where exists (
  select 1 from game_engine.game_definition_versions version
  where version.game_definition_id=ticket.product_id
    and version.outcome_generation_definition is not null
    and version.paytable_version=paytable.version);
`)).rows[0].count);
  return {
    products,
    authorityStages,
    scheduler,
    connections,
    fullChainControlCompatibleTicketCount,
  };
}

async function main() {
  mkdirSync(evidenceRoot, { recursive: true });
  const generatedAt = new Date().toISOString();
  const head = command("git", ["rev-parse", "HEAD"]);
  const status = command("git", ["status", "--porcelain"]);
  const csprngPath = "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
  const migrationPath = "scripts/migrations/local/121_add_durable_scheduler_runtime.sql";
  const schedulerPath = "services/game-engine/src/GameEngine.Application/Services/DurableSchedulerRuntime.cs";
  const authorityPath = "services/game-engine/src/GameEngine.Application/Services/CanonicalDrawExecutionAuthority.cs";
  const schedulerSource = readFileSync(schedulerPath, "utf8");
  const authoritySource = readFileSync(authorityPath, "utf8");
  const csprngHash = sourceHash(csprngPath);
  const migrationHash = sourceHash(migrationPath);

  record("canonical PR-03 commit", head === expectedCommit, { expectedCommit, head });
  record("frozen CSPRNG source", csprngHash === expectedCsprngHash, { csprngPath, csprngHash });
  record("migration 121 checksum", migrationHash === expectedMigrationHash, { migrationPath, migrationHash });
  if (csprngHash !== expectedCsprngHash) {
    block("CSPRNG_BASELINE_CHANGED", "The frozen qualified CSPRNG implementation hash changed.", { csprngHash });
  }

  const database = await inspectDatabase();
  const productStateSafe = database.products.length === 2 && database.products.every((product) =>
    product.publication_state === "PUBLISHED" && product.activation_state === "INACTIVE" &&
    product.assignment_state === "UNASSIGNED" && product.active_version_id === null);
  record("committed pilot catalog is inactive and unassigned", productStateSafe, { products: database.products });
  const scheduleConfigurationSafe = database.products.every((product) =>
    product.time_zone_id === "America/New_York" &&
    (product.code === "FAST_KENO_V1"
      ? product.schedule_configuration.intervalSeconds === 25 && product.schedule_configuration.cutoffSeconds === 5
      : product.schedule_configuration.intervalMinutes === 4 && product.schedule_configuration.cutoffSeconds === 15));
  record("approved pilot schedules are exact", scheduleConfigurationSafe, { products: database.products });

  const [gameEngineReadiness, schedulerStatus, settlementReadiness, queues] = await Promise.all([
    getJson(`${gameEngineUrl}/health/ready`),
    getJson(`${gameEngineUrl}/api/game-engine/durable-scheduler/status`),
    getJson(`${settlementUrl}/health/ready`),
    getJson(`${rabbitManagementUrl}/api/queues`, {
      headers: { authorization: `Basic ${Buffer.from(`${rabbitUser}:${rabbitPassword}`).toString("base64")}` },
    }),
  ]);
  record("Game Engine readiness", gameEngineReadiness.ok, gameEngineReadiness);
  record("durable scheduler status endpoint", schedulerStatus.ok, schedulerStatus);
  record("Settlement readiness", settlementReadiness.ok, settlementReadiness);
  record("RabbitMQ diagnostics", queues.ok, { status: queues.status });

  const schedulerNullHandoff = schedulerSource.includes("OutcomeCertificateId: null") &&
    schedulerSource.includes("SettlementInputId: null");
  const authorityStopsForCertificate = authoritySource.includes("if (command.OutcomeCertificateId is null)") &&
    authoritySource.includes("CanonicalDrawExecutionStatus.AwaitingCertification");
  const settlementRequiresCallerInput = authoritySource.includes("if (command.SettlementInputId is not null)");
  record("scheduler handoff semantics inspected", schedulerNullHandoff && authorityStopsForCertificate && settlementRequiresCallerInput, {
    schedulerNullHandoff,
    authorityStopsForCertificate,
    settlementRequiresCallerInput,
  });
  if (schedulerNullHandoff && authorityStopsForCertificate) {
    block(
      "SCHEDULER_STOPS_AT_AWAITING_CERTIFICATION",
      "The durable scheduler generates canonical CSPRNG evidence but supplies no Outcome Certificate, so execution stops at AwaitingCertification.",
      { schedulerPath, authorityPath },
    );
  }
  if (schedulerNullHandoff && settlementRequiresCallerInput) {
    block(
      "NO_PER_TICKET_MATH_SETTLEMENT_FANOUT",
      "The scheduler supplies no per-ticket Math Evaluation Certificate or SettlementInput and cannot prove every accepted wager reaches settlement.",
      { schedulerPath, authorityPath },
    );
  }

  const settlementAuthority = settlementReadiness.body?.settlementAuthority ?? {};
  if (settlementAuthority.authorityActivationEnabled !== true || settlementAuthority.productionPostingEnabled !== true) {
    block(
      "SETTLEMENT_LOAD_EXECUTION_NOT_ACTIVATED",
      "The running Settlement Authority reports activation/posting disabled; an isolated load-qualified execution mode is not configured.",
      {
        authorityActivationEnabled: settlementAuthority.authorityActivationEnabled ?? null,
        productionPostingEnabled: settlementAuthority.productionPostingEnabled ?? null,
      },
    );
  }
  if (database.fullChainControlCompatibleTicketCount === 0) {
    anomaly(
      "FULL_CHAIN_CONTROL_FIXTURE_INCOMPATIBLE",
      "HIGH",
      "The existing canonical CSPRNG full-chain QA has no accepted ticket whose paytable version matches an outcome-capable immutable product version.",
      { compatibleTicketCount: database.fullChainControlCompatibleTicketCount },
    );
    block(
      "FULL_CHAIN_CONTROL_NOT_REPRODUCIBLE",
      "The one-ticket full-chain control failed before CSPRNG invocation because its temporary active product version did not match the ticket's immutable paytable version.",
      { control: "qa:canonical-csprng-production-invocation" },
    );
  }

  const environment = {
    schemaVersion: "mosera.pr04.environment.v1",
    campaignId,
    generatedAt,
    baselineCommit: head,
    expectedCommit,
    worktreeStatus: status.split("\n").filter(Boolean),
    host: {
      hostname: hostname(), platform: platform(), release: release(), cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? null, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
    },
    runtime: { gameEngineReadiness, schedulerStatus, settlementReadiness },
    database,
    rabbitMq: {
      status: queues.status,
      queues: Array.isArray(queues.body) ? queues.body.map((queue) => ({
        name: queue.name, durable: queue.durable, consumers: queue.consumers,
        messages: queue.messages, ready: queue.messages_ready, unacknowledged: queue.messages_unacknowledged,
      })) : [],
    },
    dockerStats: command("docker", ["stats", "--no-stream", "--format", "{{json .}}"])
      .split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      }),
  };
  const statusValue = blockers.length === 0
    ? "PR_04_PREFLIGHT_PASS"
    : "PR_04_RUNTIME_SCALE_QUALIFICATION_BLOCKED";
  const summary = {
    schemaVersion: "mosera.pr04.qualification-summary.v1",
    campaignId,
    status: statusValue,
    generatedAt,
    baselineCommit: head,
    csprngHash,
    migration121Hash: migrationHash,
    qualificationCampaignsExecuted: false,
    reason: blockers.length === 0
      ? "Preflight passed; sustained campaigns may begin."
      : "Sustained campaigns were not started because doing so would test ticket acceptance without the required canonical outcome-to-completion chain.",
    claimedCapacityTier: null,
    checks,
    blockers,
    anomalyCount: anomalies.length,
  };

  writeExclusive(`${evidenceRoot}/environment.json`, environment);
  writeExclusive(`${evidenceRoot}/anomaly-register.json`, {
    schemaVersion: "mosera.pr04.anomaly-register.v1", campaignId, appendOnly: true, anomalies,
  });
  writeExclusive(`${evidenceRoot}/summary.json`, summary);
  writeExclusive(`${evidenceRoot}/summary.md`, [
    "# PR-04 Runtime Scale Qualification",
    "",
    `- Campaign: ${campaignId}`,
    `- Status: ${statusValue}`,
    `- Baseline: ${head}`,
    `- CSPRNG: ${csprngHash}`,
    `- Capacity tier: not claimed`,
    "",
    "## Blockers",
    "",
    ...blockers.map((item) => `- ${item.code}: ${item.summary}`),
    "",
    "Sustained load was not run because the complete canonical financial chain is a mandatory prerequisite.",
    "",
  ].join("\n"));
  const tracked = ["environment.json", "anomaly-register.json", "summary.json", "summary.md"];
  const artifactHashes = Object.fromEntries(tracked.map((name) => [name, sourceHash(`${evidenceRoot}/${name}`)]));
  writeExclusive(`${evidenceRoot}/evidence-manifest.json`, {
    schemaVersion: "mosera.pr04.evidence-manifest.v1",
    campaignId,
    generatedAt: new Date().toISOString(),
    evidenceRoot,
    artifacts: artifactHashes,
    rawEvidencePolicy: "Large transient logs remain excluded from Git and must not replace hashed summary evidence.",
  });

  console.log(JSON.stringify({ ...summary, evidenceRoot }, null, 2));
  if (blockers.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}
