import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const checks = [];

function check(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function read(path) {
  return readFileSync(path, "utf8");
}

const calculator = read("services/game-engine/src/GameEngine.Application/Services/AuthoritativeScheduleCalculator.cs");
const runtime = read("services/game-engine/src/GameEngine.Application/Services/DurableSchedulerRuntime.cs");
const canonicalExecution = read("services/game-engine/src/GameEngine.Application/Services/CanonicalDrawExecutionAuthority.cs");
const postgres = read("services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresDurableSchedulerPersistence.cs");
const configuration = read("services/game-engine/src/GameEngine.Api/Configuration/DurableSchedulerConfiguration.cs");
const hostedService = read("services/game-engine/src/GameEngine.Api/Infrastructure/DurableDrawSchedulerHostedService.cs");
const tests = read("services/game-engine/tests/GameEngine.Application.Tests/DurableSchedulerTests.cs");
const legacyQuickPickRoute = read("app/api/hotspot/quick-pick/route.ts");

check("one .NET durable scheduler owner", hostedService.includes("DurableDrawSchedulerHostedService") &&
  runtime.includes("public sealed class DurableSchedulerRuntime") &&
  !runtime.includes("System.Threading.Timer"));
check("authoritative schedule math is configuration anchored", calculator.includes("AnchorLocalTime") &&
  calculator.includes("ResolveIanaTimeZone") && calculator.includes("scheduledAt.ToUniversalTime()"));
check("Fast Keno schedule is frozen", calculator.includes("definition.IntervalSeconds != 25") &&
  calculator.includes("definition.CutoffSeconds != 5"));
check("Hot Spot schedule is frozen", calculator.includes("definition.IntervalSeconds != 240") &&
  calculator.includes("definition.CutoffSeconds != 15") &&
  calculator.includes("new TimeOnly(6, 0)") && calculator.includes("new TimeOnly(2, 0)"));
check("draw identity binds UTC schedule and product", calculator.includes("canonicalInstant:O") &&
  calculator.includes("definition.ProductVersionId") && calculator.includes("definition.ScheduleVersionId"));
check("materialization revalidates product activation", postgres.includes("definition.active_version_id = version.id") &&
  postgres.includes("version.activation_state = 'ACTIVE'") && postgres.includes("version.assignment_state = 'ASSIGNED'"));
check("PostgreSQL advisory coordination is canonical", postgres.includes("pg_advisory_xact_lock") &&
  postgres.includes("claim_durable_scheduler_execution"));
check("provider invocation remains canonical", runtime.includes("CanonicalDrawExecutionAuthority") &&
  !runtime.includes("new InternalCsprngOutcomeProvider"));
check("scheduler has no provider fallback", runtime.includes("manifest-bound") ||
  runtime.includes("CanonicalScheduledDrawExecutionInvoker"));
check("missed draw policy distinguishes funded wagers", runtime.includes("MISSED_DRAW_FUNDED_WAGERS") &&
  runtime.includes("MISSED_DRAW_NO_WAGERS"));
check("Quick Pick and Bullseye use purpose separation", runtime.includes("HOT_SPOT_QUICK_PICK_V1") &&
  runtime.includes("HOT_SPOT_BULLSEYE_V1") && runtime.includes("CryptographicOperations.ZeroMemory"));
check("legacy Quick Pick authority is retired", legacyQuickPickRoute.includes("LEGACY_QUICK_PICK_AUTHORITY_RETIRED") &&
  !legacyQuickPickRoute.includes("generate_hotspot_quick_pick") && !legacyQuickPickRoute.includes("supabase.rpc"));
check("Bullseye is bound to canonical Hot Spot execution", canonicalExecution.includes("HOT_SPOT_V1") &&
  canonicalExecution.includes("hotSpotBullseyeAuthority.DesignateAsync") &&
  canonicalExecution.includes("result.Evidence.GeneratedNumbers") &&
  canonicalExecution.includes("registration.ConfigurationHash"));
check("multi-draw requires approved exact counts and upfront total", runtime.includes("[1, 5, 10, 20]") &&
  runtime.includes("checked(stakePerDrawMinor * drawCount)"));
check("runtime remains disabled by default", configuration.includes("IsTrue(\"GAME_ENGINE_DURABLE_SCHEDULER_ENABLED\")") &&
  configuration.includes("IsTrue(\"GAME_ENGINE_DURABLE_SCHEDULER_PRODUCTION_EXECUTION_ENABLED\")"));
check("clock-controlled DST and concurrency tests exist", tests.includes("TestDaylightSavingTransitions") &&
  tests.includes("TestActivationAndConcurrencyAsync") && tests.includes("TestExactlyOnceInvocationAsync") &&
  tests.includes("TestExpiredClaimRecoveryAsync"));

const implementationPath = "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
const csprngHash = createHash("sha256").update(readFileSync(implementationPath)).digest("hex");
check("frozen CSPRNG source hash unchanged",
  csprngHash === "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c",
  { implementationPath, csprngHash });

const applicationTests = spawnSync("dotnet", [
  "run", "--no-build", "--project",
  "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
], { cwd: process.cwd(), encoding: "utf8" });
check("Game Engine scheduler application tests", applicationTests.status === 0 &&
  applicationTests.stdout.includes("GameEngine.Application.Tests PASS"), {
  status: applicationTests.status,
  stdout: applicationTests.stdout.trim(),
  stderr: applicationTests.stderr.trim(),
});

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  async function trueScalar(sql, values = []) {
    const result = await client.query(sql, values);
    return result.rows[0]?.value === true;
  }

  check("migration 121 applied", await trueScalar(`
    select exists (
      select 1 from platform_migrations.migration_history
      where migration_id = '121_add_durable_scheduler_runtime' and status = 'APPLIED'
    ) value`));
  check("durable scheduler schema complete", await trueScalar(`
    select bool_and(to_regclass(name) is not null) value
    from unnest(array[
      'game_engine.durable_scheduler_draws',
      'game_engine.durable_scheduler_events',
      'game_engine.durable_scheduler_execution_leases',
      'game_engine.durable_scheduler_execution_attempts',
      'game_engine.hot_spot_quick_pick_selections',
      'game_engine.hot_spot_bullseye_evidence',
      'game_engine.hot_spot_multi_draw_purchases',
      'game_engine.hot_spot_multi_draw_bindings'
    ]) name`));
  check("immutable evidence triggers installed", await trueScalar(`
    select count(*) >= 7 value
    from pg_trigger trigger_record
    join pg_class table_record on table_record.oid = trigger_record.tgrelid
    join pg_namespace schema_record on schema_record.oid = table_record.relnamespace
    where schema_record.nspname = 'game_engine'
      and trigger_record.tgname like 'trg_prevent_%'
      and table_record.relname in (
        'durable_scheduler_events', 'durable_scheduler_execution_attempts',
        'hot_spot_quick_pick_selections', 'hot_spot_bullseye_evidence',
        'hot_spot_multi_draw_purchases', 'hot_spot_multi_draw_bindings',
        'scheduler_settlement_kpi_events')`));
  check("scheduler persistence contains no CSPRNG secrets", await trueScalar(`
    select not exists (
      select 1 from information_schema.columns
      where table_schema = 'game_engine'
        and table_name in (
          'durable_scheduler_draws', 'durable_scheduler_events',
          'durable_scheduler_execution_leases', 'durable_scheduler_execution_attempts',
          'hot_spot_quick_pick_selections', 'hot_spot_bullseye_evidence',
          'hot_spot_multi_draw_purchases', 'hot_spot_multi_draw_bindings')
        and column_name ~ '(raw_entropy|raw_seed|drbg_state|secret|reseed_material)'
    ) value`));
  check("public draw number is unique per product", await trueScalar(`
    select exists (
      select 1 from pg_constraint
      where conname = 'ux_durable_scheduler_product_draw_number'
    ) value`));
  check("operational and KPI read models exist", await trueScalar(`
    select to_regclass('game_engine.durable_scheduler_operational_status') is not null
      and to_regclass('game_engine.scheduler_settlement_latency_evidence') is not null value`));
  check("pilot products remain published inactive and unassigned", await trueScalar(`
    select count(*) = 2 value
    from game_engine.game_definition_versions version
    join game_engine.game_definitions product on product.id = version.game_definition_id
    where product.code in ('FAST_KENO_V1', 'HOT_SPOT_V1')
      and version.publication_state = 'PUBLISHED'
      and version.activation_state = 'INACTIVE'
      and version.assignment_state = 'UNASSIGNED'
      and product.active_version_id is null`));
  check("inactive pilot products have no materialized draws", await trueScalar(`
    select count(*) = 0 value
    from game_engine.durable_scheduler_draws
    where product_code in ('FAST_KENO_V1', 'HOT_SPOT_V1')`));
  check("approved schedules remain unchanged", await trueScalar(`
    select count(*) = 2 value
    from game_engine.game_definition_versions version
    join game_engine.game_definitions product on product.id = version.game_definition_id
    join game_engine.published_draw_schedule_versions schedule
      on schedule.schedule_version_id = version.schedule_version_id
    where (product.code = 'FAST_KENO_V1'
      and schedule.time_zone_id = 'America/New_York'
      and (schedule.schedule_configuration->>'intervalSeconds')::integer = 25
      and (schedule.schedule_configuration->>'cutoffSeconds')::integer = 5)
       or (product.code = 'HOT_SPOT_V1'
      and schedule.time_zone_id = 'America/New_York'
      and (schedule.schedule_configuration->>'intervalMinutes')::integer = 4
      and (schedule.schedule_configuration->>'cutoffSeconds')::integer = 15)`));
} finally {
  await client.end();
}

const failures = checks.filter((item) => item.status === "FAIL");
console.log(JSON.stringify({
  status: failures.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failures.length,
  checks,
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
