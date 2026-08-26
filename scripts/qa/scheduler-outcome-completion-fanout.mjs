import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const port = Number(process.env.QA_SCHEDULER_FANOUT_PORT ?? 5594);
const baseUrl = `http://127.0.0.1:${port}`;
const runId = randomUUID();
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];
let service;

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function check(name, passed, evidence = {}) {
  if (!passed) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  checks.push({ name, status: "PASS", evidence });
}

async function waitFor(name, probe, timeoutMs = 120_000) {
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

async function activateQualificationProvider() {
  const latest = (await pool.query(`
select stage from game_engine.game_engine_production_activation_events
where provider_id='mosera-internal-csprng' and provider_version='2.0.0'
  and configuration_version='2'
order by created_at desc, activation_event_id desc limit 1;
`)).rows[0]?.stage;
  const stages = ["REGISTERED", "READY", "APPROVED", "PRODUCTION_ACTIVE"];
  const start = latest ? stages.indexOf(latest) + 1 : 0;
  if (latest === "PRODUCTION_ACTIVE") return;
  if (latest && start === 0) throw new Error(`Unsupported activation stage ${latest}`);
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
`, [
      randomUUID(),
      stage,
      hash(`pr04a-activation-request:${runId}:${stage}`),
      hash(`pr04a-activation-evidence:${runId}:${stage}`),
      `pr04a-activation:${runId}:${stage}`,
    ]);
  }
}

async function createDueFastKenoDraw() {
  const product = (await pool.query(`
select definition.id product_id,version.id product_version_id,definition.code,
  version.definition_hash,version.evaluator_version,version.paytable_version,
  version.outcome_provider_id,version.outcome_provider_version,
  version.provider_configuration_version,schedule.schedule_version_id,
  schedule.draw_authority_assignment_id,schedule.schedule_hash,
  assignment.draw_authority_version_id,module.code engine_name,
  module_version.version engine_version
from game_engine.game_definitions definition
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
join game_engine.published_draw_schedule_versions schedule
  on schedule.schedule_version_id=version.schedule_version_id
join game_engine.draw_authority_assignments assignment
  on assignment.id=schedule.draw_authority_assignment_id
join game_engine.game_modules module on module.id=definition.game_module_id
join game_engine.game_module_versions module_version
  on module_version.game_module_id=module.id
 and module_version.version=version.product_configuration->>'engineVersion'
where definition.code='FAST_KENO_V1'
  and version.publication_state='PUBLISHED'
order by version.version_number desc limit 1;
`)).rows[0];
  if (!product) throw new Error("Fast Keno pilot product lineage is unavailable.");

  const drawId = randomUUID();
  const manifestId = randomUUID();
  const now = Date.now();
  const salesOpenAt = new Date(now - 120_000);
  const cutoffAt = new Date(now - 60_000);
  const executionAt = new Date(now - 30_000);
  const recoveryAt = new Date(now + 300_000);
  const identityHash = hash(`pr04a-draw:${drawId}`);
  const manifestHash = hash([
    "pr04a-manifest", drawId, product.product_version_id,
    product.outcome_provider_id, product.provider_configuration_version,
  ].join("|"));
  const publicNumber = Number((await pool.query(`
select coalesce(max(public_draw_number),0)::integer + 1 value
from game_engine.durable_scheduler_draws where product_code='FAST_KENO_V1';
`)).rows[0].value);

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`
insert into game_engine.draw_schedules (
  id,game_definition_id,draw_authority_assignment_id,sales_open_at,
  sales_close_at,draw_at,status,schedule_version_id,scheduled_execution_at,
  schedule_hash,draw_identity_hash)
values ($1,$2,$3,$4,$5,$6,'AwaitingResult',$7,$6,$8,$9);
`, [
      drawId, product.product_id, product.draw_authority_assignment_id,
      salesOpenAt, cutoffAt, executionAt, product.schedule_version_id,
      product.schedule_hash, identityHash,
    ]);
    await client.query(`
insert into game_engine.draw_execution_manifests (
  execution_manifest_id,draw_id,schedule_version_id,game_definition_version_id,
  draw_authority_version_id,engine_name,engine_version,outcome_provider_id,
  outcome_provider_version,provider_configuration_version,evaluator_version,
  paytable_version,scheduled_execution_at,schedule_hash,draw_identity_hash,
  canonical_manifest_hash,created_at)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,clock_timestamp());
`, [
      manifestId, drawId, product.schedule_version_id, product.product_version_id,
      product.draw_authority_version_id, product.engine_name, product.engine_version,
      product.outcome_provider_id, product.outcome_provider_version,
      product.provider_configuration_version, product.evaluator_version,
      product.paytable_version, executionAt, product.schedule_hash, identityHash,
      manifestHash,
    ]);
    await client.query(`
insert into game_engine.durable_scheduler_draws (
  draw_id,product_id,product_version_id,product_code,schedule_version_id,
  public_draw_number,sales_open_at,cutoff_at,scheduled_execution_at,
  draw_identity_hash,scheduler_state,recovery_deadline_at,materialized_at)
values ($1,$2,$3,'FAST_KENO_V1',$4,$5,$6,$7,$8,$9,'ExecutionDue',$10,clock_timestamp());
`, [
      drawId, product.product_id, product.product_version_id,
      product.schedule_version_id, publicNumber, salesOpenAt, cutoffAt,
      executionAt, identityHash, recoveryAt,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { drawId, manifestId, manifestHash, product };
}

async function startService(publicKeyPem, privateKeyPem) {
  mkdirSync(".qa/pr-04a", { recursive: true });
  const log = createWriteStream(`.qa/pr-04a/game-engine-${runId}.log`, { flags: "a" });
  service = spawn("dotnet", [
    "run", "--no-build", "--no-launch-profile", "--project",
    "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ASPNETCORE_URLS: baseUrl,
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
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_ENABLED: "true",
      GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_QUALIFICATION_MODE: "true",
      GAME_ENGINE_QUALIFICATION_SIGNING_PRIVATE_KEY_PEM: privateKeyPem,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.pipe(log);
  service.stderr.pipe(log);
  await waitFor("qualification Game Engine starts", async () => {
    if (service.exitCode !== null) throw new Error(`Game Engine exited with ${service.exitCode}`);
    const response = await fetch(`${baseUrl}/health/live`);
    return response.ok ? { status: response.status } : null;
  }, 60_000);
}

async function stopService() {
  if (!service || service.exitCode !== null) return;
  service.kill("SIGTERM");
  await Promise.race([once(service, "exit"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (service.exitCode === null) service.kill("SIGKILL");
}

try {
  const csprngPath =
    "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
  const csprngHash = createHash("sha256").update(readFileSync(csprngPath)).digest("hex");
  check("qualified CSPRNG source is unchanged",
    csprngHash === "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c",
    { csprngHash });

  await activateQualificationProvider();
  const fixture = await createDueFastKenoDraw();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  await startService(
    publicKey.export({ type: "spki", format: "pem" }),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );

  const completed = await waitFor("scheduler closes zero-ticket draw through certification", async () => {
    const result = await pool.query(`
select runtime.scheduler_state,
  (select count(*)::int from game_engine.outcome_provider_execution_evidence
    where execution_manifest_id=$2 and status='GENERATED') generated,
  (select count(*)::int from game_engine.outcome_events
    where execution_manifest_id=$2 and outcome_mode='CertifiedProvider') outcome_events,
  (select count(*)::int from game_engine.canonical_outcome_versions where draw_id=$1) publications,
  (select count(*)::int from game_engine.outcome_settlement_requests request
    join game_engine.canonical_outcome_versions version
      on version.outcome_version_id=request.outcome_version_id
    where version.draw_id=$1) settlements
from game_engine.durable_scheduler_draws runtime where runtime.draw_id=$1;
`, [fixture.drawId, fixture.manifestId]);
    const row = result.rows[0];
    return row?.scheduler_state === "AuthoritativeResult" &&
      row.generated === 1 && row.outcome_events === 1 && row.publications === 1 &&
      row.settlements === 0 ? row : null;
  });
  check("zero-ticket draw creates no SettlementInput fanout", completed.settlements === 0, completed);

  const evidence = (await pool.query(`
select event.canonical_outcome_hash,event.execution_manifest_id,event.provider_evidence_id,
  certificate.certificate_id,signature.signature_id,signature.signing_context,
  signature.verification_status,version.execution_manifest_hash,
  version.game_definition_version_id,version.game_definition_hash
from game_engine.outcome_events event
join game_engine.outcome_certificates certificate on certificate.outcome_id=event.outcome_id
join game_engine.certificate_signatures signature
  on signature.certificate_reference_type='OutcomeCertificate'
 and signature.certificate_id=certificate.certificate_id
join game_engine.canonical_outcome_versions version on version.outcome_id=event.outcome_id
where event.execution_manifest_id=$1;
`, [fixture.manifestId])).rows[0];
  check("certificate binds exact immutable scheduler/provider lineage",
    evidence?.execution_manifest_id === fixture.manifestId &&
      evidence?.execution_manifest_hash === fixture.manifestHash &&
      evidence?.provider_evidence_id &&
      evidence?.signing_context === "Production" &&
      evidence?.verification_status === "Verified",
    evidence);

  await stopService();
  const singular = (await pool.query(`
select
  (select count(*)::int from game_engine.outcome_events where execution_manifest_id=$1) events,
  (select count(*)::int from game_engine.canonical_outcome_versions where draw_id=$2) versions,
  (select count(*)::int from game_engine.certificate_signatures signature
    join game_engine.outcome_certificates certificate on certificate.certificate_id=signature.certificate_id
    join game_engine.outcome_events event on event.outcome_id=certificate.outcome_id
    where event.execution_manifest_id=$1) signatures;
`, [fixture.manifestId, fixture.drawId])).rows[0];
  check("scheduler certificate/publication evidence is singular", Object.values(singular).every((value) => value === 1), singular);

  console.log(JSON.stringify({
    status: "PASS",
    runId,
    scope: "PR-04A scheduler certificate closure and zero-ticket policy",
    checks,
  }, null, 2));
} finally {
  await stopService();
  await pool.end();
}
