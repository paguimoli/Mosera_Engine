import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const expectedCommit = "29d09920d077fd7b45d66891a74f0d72f2c2c644";
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
join game_engine.game_definition_versions version
  on version.game_definition_id=ticket.product_id
 and version.game_manifest_id=ticket.manifest_id
 and version.paytable_definition_id=ticket.paytable_definition_id
 and version.outcome_generation_definition is not null;
`)).rows[0].count);
  const schedulerCertificateClosures = Number((await pool.query(`
select count(distinct outcome.execution_manifest_id)::int count
from game_engine.outcome_events outcome
join game_engine.draw_execution_manifests manifest
  on manifest.execution_manifest_id=outcome.execution_manifest_id
join game_engine.durable_scheduler_draws runtime on runtime.draw_id=manifest.draw_id
where outcome.outcome_mode='CertifiedProvider';
`)).rows[0].count);
  const pilotFullChain = (await pool.query(`
select runtime.draw_id,runtime.product_code,runtime.materialized_at,
  (select count(*)::int from ticket_authority.tickets ticket
    where ticket.draw_id=runtime.draw_id) accepted_tickets,
  (select count(*)::int from ticket_authority.ticket_items item
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id) ticket_items,
  (select count(*)::int from game_engine.math_evaluation_certificates certificate
    join ticket_authority.ticket_items item on item.ticket_item_id::text=certificate.ticket_reference
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id) math_certificates,
  (select count(*)::int from game_engine.settlement_input_records input
    join ticket_authority.ticket_items item on item.ticket_item_id::text=input.ticket_reference
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id) settlement_inputs,
  (select count(*)::int from game_engine.outcome_settlement_requests request
    where request.draw_id=runtime.draw_id) settlement_requests,
  (select count(*)::int from settlement_service.authoritative_settlement_records settlement
    join game_engine.outcome_settlement_requests request using(settlement_request_id)
    where request.draw_id=runtime.draw_id) settlements,
  (select count(*)::int from ticket_completion_authority.completion_sources source
    join ticket_authority.ticket_items item using(ticket_item_id)
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id) completion_sources,
  (select count(*)::int from ticket_completion_authority.completion_evidence completion
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id) completed_tickets,
  (select count(*)::int from ticket_authority.tickets ticket
    join public.credit_reservations reservation on reservation.id=ticket.reservation_id
    where ticket.draw_id=runtime.draw_id and ticket.status='SETTLED'
      and ticket.lifecycle_state='REBATE_ELIGIBLE'
      and reservation.remaining_exposure=0 and reservation.status='CAPTURED') closed_reservations,
  (select count(*)::int from game_engine.outcome_events event
    join game_engine.draw_execution_manifests manifest using(execution_manifest_id)
    where manifest.draw_id=runtime.draw_id) outcome_events,
  (select count(*)::int from game_engine.canonical_outcome_versions version
    where version.draw_id=runtime.draw_id) outcome_versions,
  (select count(*)::int from game_engine.durable_scheduler_execution_attempts attempt
    where attempt.draw_id=runtime.draw_id and attempt.attempt_status='RECOVERY_REQUIRED') recovery_attempts,
  (select count(*)::int from (
    select request.settlement_request_id
    from game_engine.outcome_settlement_requests request
    join settlement_service.authoritative_settlement_records settlement using(settlement_request_id)
    where request.draw_id=runtime.draw_id
    group by request.settlement_request_id having count(*)>1) duplicate) duplicate_settlements,
  (select count(*)::int from (
    select source.ticket_item_id
    from ticket_completion_authority.completion_sources source
    join ticket_authority.ticket_items item using(ticket_item_id)
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id
    group by source.ticket_item_id having count(*)>1) duplicate) duplicate_sources,
  (select count(*)::int from game_engine.math_evaluation_events evaluation
    join ticket_authority.ticket_items item on item.ticket_item_id::text=evaluation.ticket_reference
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id and (evaluation.prize_facts->>'Outcome')::int=0) wins,
  (select count(*)::int from game_engine.math_evaluation_events evaluation
    join ticket_authority.ticket_items item on item.ticket_item_id::text=evaluation.ticket_reference
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id and (evaluation.prize_facts->>'Outcome')::int=1) losses,
  (select count(*)::int from game_engine.math_evaluation_events evaluation
    join ticket_authority.ticket_items item on item.ticket_item_id::text=evaluation.ticket_reference
    join ticket_authority.tickets ticket using(ticket_id)
    where ticket.draw_id=runtime.draw_id
      and (evaluation.prize_facts->'OutcomeDerivedFacts'->>'capApplied')::boolean) capped_items,
  exists(select 1 from game_engine.hot_spot_bullseye_evidence bullseye
    where bullseye.draw_id=runtime.draw_id) bullseye_evidence,
  exists(select 1 from game_engine.hot_spot_multi_draw_purchases purchase
    join ticket_authority.tickets ticket on ticket.ticket_id=purchase.ticket_id
    where ticket.draw_id=runtime.draw_id) quick_pick_multi_draw_evidence
from game_engine.durable_scheduler_draws runtime
where runtime.product_code in ('FAST_KENO_V1','HOT_SPOT_V1')
  and exists(select 1 from ticket_authority.tickets ticket where ticket.draw_id=runtime.draw_id)
order by runtime.materialized_at desc;
`)).rows;
  return {
    products,
    authorityStages,
    scheduler,
    connections,
    fullChainControlCompatibleTicketCount,
    schedulerCertificateClosures,
    pilotFullChain,
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
  const gameEngineDependencies = gameEngineReadiness.body?.dependencies ?? {};
  const gameEngineQualificationReady = gameEngineReadiness.ok || (
    gameEngineReadiness.status === 503 &&
    gameEngineDependencies.database === "ready" &&
    gameEngineDependencies["durable-scheduler"] === "ready" &&
    gameEngineDependencies["canonical-outcome-pipeline"] === "ready" &&
    gameEngineDependencies["canonical-outcome-provider-authority"] === "not_ready" &&
    gameEngineDependencies["internal-csprng-provider"] === "not_ready"
  );
  record("Game Engine qualification prerequisites and fail-closed production readiness",
    gameEngineQualificationReady, gameEngineReadiness);
  record("durable scheduler status endpoint", schedulerStatus.ok, schedulerStatus);
  record("Settlement readiness", settlementReadiness.ok, settlementReadiness);
  record("RabbitMQ diagnostics", queues.ok, { status: queues.status });

  const schedulerCertificateClosure = schedulerSource.includes("certificateAuthority.IssueAsync") &&
    schedulerSource.includes("OutcomeCertificateId = issued.Certificate.CertificateId");
  const schedulerFanout = schedulerSource.includes("fanout.ExecuteAsync");
  const authorityStopsForCertificate = authoritySource.includes("if (command.OutcomeCertificateId is null)") &&
    authoritySource.includes("CanonicalDrawExecutionStatus.AwaitingCertification");
  const settlementRequiresCallerInput = authoritySource.includes("if (command.SettlementInputId is not null)");
  record("scheduler certificate and fanout orchestration is wired", schedulerCertificateClosure && schedulerFanout && authorityStopsForCertificate && settlementRequiresCallerInput, {
    schedulerCertificateClosure,
    schedulerFanout,
    authorityStopsForCertificate,
    settlementRequiresCallerInput,
  });
  record("scheduler certificate closure has runtime evidence", database.schedulerCertificateClosures > 0, {
    schedulerCertificateClosures: database.schedulerCertificateClosures,
  });
  const completePilotDraws = database.pilotFullChain.filter((row) =>
    row.accepted_tickets >= 2 && row.ticket_items > row.accepted_tickets &&
    row.math_certificates === row.ticket_items && row.settlement_inputs === row.ticket_items &&
    row.settlement_requests === row.ticket_items && row.settlements === row.ticket_items &&
    row.completion_sources === row.ticket_items && row.completed_tickets === row.accepted_tickets &&
    row.closed_reservations === row.accepted_tickets && row.outcome_events === 1 &&
    row.outcome_versions === 1 && row.duplicate_settlements === 0 && row.duplicate_sources === 0 &&
    row.wins > 0 && row.losses > 0 &&
    (row.product_code === "FAST_KENO_V1"
      ? row.capped_items > 0
      : row.recovery_attempts >= 4 && row.bullseye_evidence && row.quick_pick_multi_draw_evidence));
  const pilotFullChainReady = ["FAST_KENO_V1", "HOT_SPOT_V1"].every((code) =>
    completePilotDraws.some((row) => row.product_code === code));
  record("Fast Keno and Hot Spot scheduler full-chain evidence", pilotFullChainReady, {
    qualifiedDraws: completePilotDraws,
  });
  if (!pilotFullChainReady) {
    block(
      "PILOT_PRODUCT_FULL_CHAIN_NOT_QUALIFIED",
      "Certificate closure is repaired, but Fast Keno and Hot Spot multi-ticket Math-to-Completion evidence is not yet present.",
      { products: database.pilotFullChain },
    );
  }

  const settlementAuthority = settlementReadiness.body?.settlementAuthority ?? {};
  const productionSettlementDisabled = settlementAuthority.authorityActivationEnabled !== true &&
    settlementAuthority.productionPostingEnabled !== true;
  const fanoutConfiguration = readFileSync(
    "services/game-engine/src/GameEngine.Api/Configuration/SchedulerOutcomeFanoutConfiguration.cs",
    "utf8",
  );
  const qualificationGuarded = fanoutConfiguration.includes("explicit qualification-mode marker") &&
    fanoutConfiguration.includes("cannot run in production") &&
    fanoutConfiguration.includes("ephemeral RSA signing private key");
  record("qualification fanout is guarded and production Settlement remains disabled",
    productionSettlementDisabled && qualificationGuarded,
    { productionSettlementDisabled, qualificationGuarded, settlementAuthority });
  if (!productionSettlementDisabled || !qualificationGuarded) {
    block(
      "QUALIFICATION_GUARDRAIL_INVALID",
      "PR-04 qualification requires explicit non-production fanout and disabled production Settlement activation.",
      { productionSettlementDisabled, qualificationGuarded },
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
    ? "READY_FOR_SUSTAINED_PR_04"
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
      ? "Canonical pilot-product preflight passed; sustained campaigns may begin in a separate package."
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
