import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  printJson,
  queryScalar,
  runPsql,
} from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function check(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function scalar(sql) {
  return queryScalar(sql);
}

function isTrue(sql) {
  return scalar(sql) === "t";
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

const sourcePath = "docs/evidence/pilot-products/mosera-hot-spot-paytable-v1-source.json";
const source = readFileSync(sourcePath);
const sourceJson = JSON.parse(source);
const sourceHash = createHash("sha256").update(source).digest("hex");

check("normalized Hot Spot source hash", sourceHash === "8dc01631d3dc22ef7941fa7cb95253d06f9aee038853a62458341b46acdeeeaa", {
  sourcePath,
  sourceHash,
});
check("official source is standard non-promotional", sourceJson.promotional === false && sourceJson.currency === "USD" && sourceJson.unitStakeMinor === 100);
check("official source contains all 1-10 spot rows", sourceJson.rows.length === 10 && sourceJson.rows.every((row, index) =>
  row.spotCount === index + 1 &&
  row.hotSpotOnlyByHits.length === row.spotCount + 1 &&
  row.combinedBullseyeByHits.length === row.spotCount + 1));

check("two pilot products are published inactive and unassigned", isTrue(`
select count(*) = 2
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
where product.code in ('FAST_KENO_V1', 'HOT_SPOT_V1')
  and version.publication_state = 'PUBLISHED'
  and version.activation_state = 'INACTIVE'
  and version.assignment_state = 'UNASSIGNED'
  and product.active_version_id is null;
`));

check("pilot products reuse exact Keno engine version", isTrue(`
select count(*) = 2
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
join game_engine.game_modules module on module.id = product.game_module_id
where product.code in ('FAST_KENO_V1', 'HOT_SPOT_V1')
  and module.code = 'KENO_GENERIC'
  and version.product_configuration->>'engineVersion' = '1.0.0-pilot';
`));

check("product configuration hashes are deterministic", isTrue(`
select bool_and(version.definition_hash =
  'sha256:' || encode(digest(version.product_configuration::text, 'sha256'), 'hex'))
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
where product.code in ('FAST_KENO_V1', 'HOT_SPOT_V1');
`));

check("exact immutable lineage is complete", isTrue(`
select bool_and(
  version.game_manifest_id is not null
  and version.game_manifest_hash = manifest.content_hash
  and version.math_model_hash = math.content_hash
  and version.paytable_hash = paytable.content_hash
  and version.schedule_hash = schedule.schedule_hash
  and version.provider_configuration_hash = provider.configuration_hash
  and version.settlement_policy_version = 'CANONICAL_SETTLEMENT_V1')
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
join game_engine.game_manifests manifest on manifest.id = version.game_manifest_id
join game_engine.math_model_definitions math on math.id = version.math_model_definition_id
join game_engine.paytable_definitions paytable on paytable.id = version.paytable_definition_id
join game_engine.published_draw_schedule_versions schedule on schedule.schedule_version_id = version.schedule_version_id
join game_engine.outcome_provider_configuration_versions provider
  on provider.provider_id = version.outcome_provider_id
 and provider.provider_version = version.outcome_provider_version
 and provider.configuration_version = version.provider_configuration_version
where product.code in ('FAST_KENO_V1', 'HOT_SPOT_V1');
`));

check("Internal CSPRNG binding remains disabled", isTrue(`
select activation_state = 'DISABLED'
from game_engine.outcome_provider_activation_events
where provider_id = 'mosera-internal-csprng'
  and provider_version = '2.0.0'
  and configuration_version = '2'
order by effective_at desc, created_at desc
limit 1;
`));

check("products have no availability assignment", isTrue(`
select count(*) = 0
from platform.game_availability
where game_code in ('FAST_KENO_V1', 'HOT_SPOT_V1');
`));

check("retained qualification draws preserve exact pilot product lineage", isTrue(`
select not exists (
  select 1
  from game_engine.durable_scheduler_draws draw
  left join game_engine.game_definition_versions version
    on version.id = draw.product_version_id
   and version.game_definition_id = draw.product_id
  left join game_engine.game_definitions product
    on product.id = draw.product_id
   and product.code = draw.product_code
  where draw.product_code in ('FAST_KENO_V1', 'HOT_SPOT_V1')
    and (version.id is null or product.id is null)
);
`));

check("Fast Keno is exact derived-only configuration", isTrue(`
select
  jsonb_array_length(version.product_configuration#>'{wagering,markets}') = 19
  and (version.product_configuration#>>'{wagering,spotWageringEnabled}')::boolean = false
  and (version.product_configuration#>>'{wagering,quickPickEnabled}')::boolean = false
  and (version.product_configuration#>>'{wagering,maximumWagersPerTicket}')::integer = 20
  and (version.product_configuration#>>'{wagering,minimumStakeMinor}')::integer = 200
  and (version.product_configuration#>>'{wagering,combinedTicketPayoutCapMinor}')::integer = 1000000
  and version.product_configuration#>>'{schedule,timeZone}' = 'America/New_York'
  and (version.product_configuration#>>'{schedule,intervalSeconds}')::integer = 25
  and (version.product_configuration#>>'{schedule,cutoffSeconds}')::integer = 5
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
where product.code = 'FAST_KENO_V1';
`));

const expectedFastMarkets = new Map([
  ["BIG", [1.95, 72000]], ["SMALL", [1.95, 72000]],
  ["ODD", [1.95, 72000]], ["EVEN", [1.95, 72000]],
  ["DRAGON", [1.95, 72000]], ["TIGER", [1.95, 72000]],
  ["DT_TIE", [9, 9000]], ["UP", [2.3, 55400]], ["DOWN", [2.3, 55400]],
  ["UD_TIE", [4.3, 21800]], ["BIG_ODD", [3.7, 26700]],
  ["BIG_EVEN", [3.7, 26700]], ["SMALL_ODD", [3.7, 26700]],
  ["SMALL_EVEN", [3.7, 26700]], ["GOLD", [9.2, 8800]],
  ["WOOD", [4.6, 20000]], ["WATER", [2.4, 51400]],
  ["FIRE", [4.6, 20000]], ["EARTH", [9.2, 8800]],
]);
const fastMarkets = JSON.parse(scalar(`
select (version.product_configuration#>'{wagering,markets}')::text
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
where product.code = 'FAST_KENO_V1';
`));
check("Fast Keno market odds and limits are exact", fastMarkets.length === expectedFastMarkets.size && fastMarkets.every((market) => {
  const expected = expectedFastMarkets.get(market.code);
  return expected && market.odds === expected[0] && market.maximumStakeMinor === expected[1];
}));
check("Fast Keno tie rules are exact",
  fastMarkets.find((market) => market.code === "DRAGON")?.tieRule === "PUSH" &&
  fastMarkets.find((market) => market.code === "TIGER")?.tieRule === "PUSH" &&
  fastMarkets.find((market) => market.code === "UP")?.tieRule === "LOSE" &&
  fastMarkets.find((market) => market.code === "DOWN")?.tieRule === "LOSE");

check("Hot Spot approved product configuration is exact", isTrue(`
select
  version.paytable_hash = 'sha256:8dc01631d3dc22ef7941fa7cb95253d06f9aee038853a62458341b46acdeeeaa'
  and version.product_configuration#>>'{wagering,mode}' = 'TRADITIONAL_SPOT'
  and version.product_configuration#>'{wagering,spotCounts}' = '[1,2,3,4,5,6,7,8,9,10]'::jsonb
  and (version.product_configuration#>>'{wagering,quickPick,enabled}')::boolean
  and (version.product_configuration#>>'{wagering,bullseye,optionalAttachedAddOn}')::boolean
  and not (version.product_configuration#>>'{wagering,bullseye,standalone}')::boolean
  and (version.product_configuration#>>'{wagering,bullseye,equalBaseStake}')::boolean
  and (version.product_configuration#>>'{wagering,perPlayPayoutCapMinor}')::integer = 5000000
  and version.product_configuration#>'{wagering,multiDrawCounts}' = '[1,5,10,20]'::jsonb
  and (version.product_configuration#>>'{wagering,maximumPlaysPerTicket}')::integer = 10
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
where product.code = 'HOT_SPOT_V1';
`));

check("Hot Spot schedule and closed-window policy are exact", isTrue(`
select
  schedule.time_zone_id = 'America/New_York'
  and schedule.schedule_kind = 'DAILY_WINDOW_INTERVAL'
  and (schedule.schedule_configuration->>'intervalMinutes')::integer = 4
  and schedule.schedule_configuration->>'firstDrawLocalTime' = '06:00:00'
  and schedule.schedule_configuration->>'finalDrawLocalTime' = '02:00:00'
  and (schedule.schedule_configuration->>'cutoffSeconds')::integer = 15
  and schedule.schedule_configuration->>'closedWindowPolicy' = 'SKIP_AND_RESUME'
  and not (schedule.schedule_configuration->>'schedulerRuntimeEnabled')::boolean
from game_engine.game_definition_versions version
join game_engine.game_definitions product on product.id = version.game_definition_id
join game_engine.published_draw_schedule_versions schedule on schedule.schedule_version_id = version.schedule_version_id
where product.code = 'HOT_SPOT_V1';
`));

check("Hot Spot paytable contains every nonzero source payout", isTrue(`
with rows as (
  select jsonb_array_elements(paytable.prize_matrix_rows) row
  from game_engine.paytable_definitions paytable
  where paytable.paytable_id = 'MOSERA_HOT_SPOT_PAYTABLE_V1' and paytable.version = '1.0.0'
)
select
  count(*) = 132
  and bool_and((row->>'maxPayout')::numeric = 50000)
  and count(*) filter (where row#>>'{conditions,bullseyePurchased}' = 'true') > 0
  and count(*) filter (where row#>>'{conditions,bullseyeMatch}' = 'true') > 0
from rows;
`));

check("legacy Hot Spot skeleton is isolated", isTrue(`
select
  product.code = 'HOT_SPOT_V1'
  and module.code = 'KENO_GENERIC'
  and not exists (
    select 1
    from game_engine.game_definitions legacy
    join game_engine.game_modules legacy_module on legacy_module.id = legacy.game_module_id
    where legacy.code = 'HOT_SPOT_V1' and legacy_module.code = 'HOT_SPOT')
from game_engine.game_definitions product
join game_engine.game_modules module on module.id = product.game_module_id
where product.code = 'HOT_SPOT_V1';
`));

const updateAttempt = runSql(`
update game_engine.game_definition_versions version
set activation_state = 'ACTIVE'
from game_engine.game_definitions product
where product.id = version.game_definition_id and product.code = 'FAST_KENO_V1';
`, { allowFailure: true });
check("published product mutation is blocked", updateAttempt.status !== 0, {
  stderr: updateAttempt.stderr.trim(),
});

const deletionAttempt = runSql(`
delete from game_engine.game_definition_versions version
using game_engine.game_definitions product
where product.id = version.game_definition_id and product.code = 'HOT_SPOT_V1';
`, { allowFailure: true });
check("published product deletion is blocked", deletionAttempt.status !== 0, {
  stderr: deletionAttempt.stderr.trim(),
});

check("canonical ticket acceptance retains exact lineage", isTrue(`
select bool_and(
  case proc.proname
    when 'accept_ticket' then
      pg_get_functiondef(proc.oid) like '%paytable_hash%'
      and pg_get_functiondef(proc.oid) like '%persist_authorized_ticket%'
    when 'persist_authorized_ticket' then
      pg_get_functiondef(proc.oid) like '%game_configuration_hash%'
      and pg_get_functiondef(proc.oid) like '%paytable_hash%'
    when 'bind_and_validate_ticket_lineage' then
      pg_get_functiondef(proc.oid) like '%execution_manifest_hash%'
    else false
  end)
  and count(*) = 3
  and exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conname = 'fk_draw_execution_manifest_provider_configuration'
  )
from pg_proc proc
join pg_namespace namespace on namespace.oid = proc.pronamespace
where namespace.nspname = 'ticket_authority'
  and proc.proname in ('accept_ticket', 'persist_authorized_ticket', 'bind_and_validate_ticket_lineage');
`));

const failures = checks.filter((item) => item.status === "FAIL");
const report = {
  status: failures.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failures.length,
  checks,
};

printJson(report);
if (failures.length > 0) process.exitCode = 1;
