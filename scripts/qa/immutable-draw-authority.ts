import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for immutable Draw Authority QA.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks: Array<{ name: string; status: "PASS" }> = [];

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pass(name: string) {
  checks.push({ name, status: "PASS" });
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(name);
  pass(name);
}

async function expectFailure(name: string, action: () => Promise<unknown>) {
  try {
    await action();
    throw new Error(`${name}: operation unexpectedly succeeded.`);
  } catch (error) {
    if (String(error).includes("unexpectedly succeeded")) throw error;
    pass(name);
  }
}

async function seedDependencies(client: PoolClient) {
  const moduleId = randomUUID();
  const moduleVersionId = randomUUID();
  const definitionId = randomUUID();
  const definitionVersionId = randomUUID();
  const authorityId = randomUUID();
  const authorityVersionId = randomUUID();
  const assignmentId = randomUUID();

  await client.query(
    `
insert into game_engine.game_modules
  (id, code, display_name, lifecycle_status, active_version_id)
values ($1, $2, 'BF-4.2 Engine', 'ACTIVE', $3);
`,
    [moduleId, `bf-4-2-engine-${moduleId}`, moduleVersionId],
  );
  await client.query(
    `insert into game_engine.game_module_versions
  (id, game_module_id, version, sdk_version, manifest_hash, lifecycle_status)
values ($1, $2, '4.2.0', 'bf-4.2', $3, 'ACTIVE');`,
    [moduleVersionId, moduleId, hash(`module:${moduleId}`)],
  );
  await client.query(
    `insert into game_engine.game_definitions
  (id, code, display_name, active_version_id, game_module_id)
values ($1, $2, 'BF-4.2 Product', $3, $4);`,
    [definitionId, `bf-4-2-product-${definitionId}`, definitionVersionId, moduleId],
  );
  await client.query(
    `insert into game_engine.game_definition_versions
  (id, game_definition_id, version_number, definition_hash, paytable_version,
   evaluator_version, draw_generator_version, effective_from)
values ($1, $2, 1, $3, 'paytable-4.2', 'evaluator-4.2', 'provider-4.2', now());`,
    [definitionVersionId, definitionId, hash(`definition:${definitionId}`)],
  );
  await client.query(
    `insert into game_engine.draw_authorities
  (id, code, display_name, provider_type, status, active_version_id)
values ($1, $2, 'BF-4.2 Authority', 'InternalTestPrng', 'Testing', $3);`,
    [authorityId, `bf-4-2-authority-${authorityId}`, authorityVersionId],
  );
  await client.query(
    `insert into game_engine.draw_authority_versions
  (id, draw_authority_id, version, provider_version, configuration_hash, status)
values ($1, $2, '4.2.0', 'provider-4.2', $3, 'Testing');`,
    [authorityVersionId, authorityId, hash(`authority:${authorityId}`)],
  );
  await client.query(
    `insert into game_engine.draw_authority_assignments
  (id, game_definition_id, draw_authority_id, draw_authority_version_id,
   settlement_trigger_policy, effective_from)
values ($1, $2, $3, $4, 'Manual', now());
`,
    [assignmentId, definitionId, authorityId, authorityVersionId],
  );

  return { moduleId, moduleVersionId, definitionId, definitionVersionId, authorityId, authorityVersionId, assignmentId };
}

async function main() {
try {
  const client = await pool.connect();
  try {
    const dependency = await seedDependencies(client);
    const scheduleId = randomUUID();
    const scheduleVersionId = randomUUID();
    const drawId = randomUUID();
    const manifestId = randomUUID();
    const drawAt = new Date(Date.now() + 3_600_000);
    const scheduleHash = hash(`schedule:${scheduleId}:1`);
    const identityHash = hash(`draw:${scheduleVersionId}:${drawAt.toISOString()}`);
    const manifestHash = hash(`manifest:${drawId}:${scheduleVersionId}`);

    await client.query(
      `
insert into game_engine.published_draw_schedule_versions (
  schedule_version_id, schedule_id, version_number, game_definition_id,
  draw_authority_assignment_id, schedule_kind, schedule_configuration,
  time_zone_id, schedule_hash, published_at)
values ($1, $2, 1, $3, $4, 'FIXED_DAILY', '{"times":["12:00"]}'::jsonb,
        'UTC', $5, now());
`,
      [scheduleVersionId, scheduleId, dependency.definitionId, dependency.assignmentId, scheduleHash],
    );
    await client.query(
      `insert into game_engine.draw_schedules (
  id, game_definition_id, draw_authority_assignment_id, sales_open_at,
  sales_close_at, draw_at, status, schedule_version_id,
  scheduled_execution_at, schedule_hash, draw_identity_hash)
values ($1, $2, $3, $4::timestamptz - interval '1 hour',
        $4::timestamptz - interval '5 minutes', $4, 'Scheduled',
        $5, $4, $6, $7);
`,
      [
        drawId,
        dependency.definitionId,
        dependency.assignmentId,
        drawAt,
        scheduleVersionId,
        scheduleHash,
        identityHash,
      ],
    );
    await client.query(
      `insert into game_engine.draw_execution_manifests (
  execution_manifest_id, draw_id, schedule_version_id,
  game_definition_version_id, draw_authority_version_id,
  engine_name, engine_version, outcome_provider_id, outcome_provider_version,
  evaluator_version, paytable_version, scheduled_execution_at,
  schedule_hash, draw_identity_hash, canonical_manifest_hash, created_at)
values ($1, $2, $3, $4, $5, 'bf-4-2-engine', '4.2.0',
        'bf-4-2-provider', 'provider-4.2', 'evaluator-4.2', 'paytable-4.2',
        $6, $7, $8, $9, now());
`,
      [
        manifestId,
        drawId,
        scheduleVersionId,
        dependency.definitionVersionId,
        dependency.authorityVersionId,
        drawAt,
        scheduleHash,
        identityHash,
        manifestHash,
      ],
    );
    pass("published schedule, Draw Instance, and Execution Manifest persist as one lineage");

    const lineage = await client.query(
      `
select
  draw.id,
  draw.schedule_version_id,
  manifest.execution_manifest_id,
  manifest.schedule_hash,
  manifest.draw_identity_hash
from game_engine.draw_schedules draw
join game_engine.published_draw_schedule_versions schedule
  on schedule.schedule_version_id = draw.schedule_version_id
join game_engine.draw_execution_manifests manifest
  on manifest.draw_id = draw.id
where draw.id = $1;
`,
      [drawId],
    );
    assert(
      lineage.rowCount === 1 &&
        lineage.rows[0].schedule_version_id === scheduleVersionId &&
        lineage.rows[0].execution_manifest_id === manifestId &&
        lineage.rows[0].schedule_hash === scheduleHash &&
        lineage.rows[0].draw_identity_hash === identityHash,
      "execution lineage resolves exactly one schedule version and manifest",
    );

    await client.query("update game_engine.draw_schedules set status = 'SalesOpen' where id = $1", [drawId]);
    pass("approved Draw Instance lifecycle transition succeeds");
    await expectFailure("backward Draw Instance lifecycle transition is rejected", () =>
      client.query("update game_engine.draw_schedules set status = 'Scheduled' where id = $1", [drawId]),
    );
    await expectFailure("Draw Instance identity mutation is rejected", () =>
      client.query("update game_engine.draw_schedules set draw_at = draw_at + interval '1 minute' where id = $1", [drawId]),
    );
    await expectFailure("published schedule mutation is rejected", () =>
      client.query(
        "update game_engine.published_draw_schedule_versions set time_zone_id = 'America/Costa_Rica' where schedule_version_id = $1",
        [scheduleVersionId],
      ),
    );
    await expectFailure("execution manifest mutation is rejected", () =>
      client.query(
        "update game_engine.draw_execution_manifests set engine_version = 'tampered' where execution_manifest_id = $1",
        [manifestId],
      ),
    );
    await expectFailure("published schedule deletion is rejected", () =>
      client.query("delete from game_engine.published_draw_schedule_versions where schedule_version_id = $1", [scheduleVersionId]),
    );
    await expectFailure("Draw Instance deletion is rejected", () =>
      client.query("delete from game_engine.draw_schedules where id = $1", [drawId]),
    );
    await expectFailure("invalid schedule-version foreign key fails closed", () =>
      client.query(
        `
insert into game_engine.draw_schedules (
  id, game_definition_id, draw_authority_assignment_id, sales_open_at,
  sales_close_at, draw_at, status, schedule_version_id,
  scheduled_execution_at, schedule_hash, draw_identity_hash)
values ($1, $2, $3, now(), now() + interval '1 minute',
        now() + interval '2 minutes', 'Scheduled', $4, now() + interval '2 minutes', $5, $6);
`,
        [randomUUID(), dependency.definitionId, dependency.assignmentId, randomUUID(), scheduleHash, hash(randomUUID())],
      ),
    );

    const constraints = await client.query(
      `
select conname, confdeltype
from pg_constraint
where conname in (
  'fk_draw_instance_schedule_version',
  'fk_canonical_outcome_execution_manifest');
`,
    );
    assert(
      constraints.rowCount === 2 && constraints.rows.every((row) => row.confdeltype === "r"),
      "permanent lineage foreign keys use ON DELETE RESTRICT",
    );

    const orchestrator = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/CanonicalDrawOrchestrator.cs",
      "utf8",
    );
    assert(
      orchestrator.includes("FindExecutionManifestAsync(command.DrawId") &&
        orchestrator.includes("EngineName = manifest.EngineName") &&
        orchestrator.includes("EngineVersion = manifest.EngineVersion"),
      "Draw Orchestrator consumes the persisted Execution Manifest",
    );
    const repository = readFileSync(
      "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresDrawSchedulePersistence.cs",
      "utf8",
    );
    assert(
      !repository.includes("on conflict (id) do update set") &&
        repository.includes("Conflicting immutable Draw Instance identity"),
      "mutable Draw Instance UPSERT path is retired",
    );
  } finally {
    client.release();
  }

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  await pool.end();
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
