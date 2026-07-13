import { createHash, randomUUID } from "node:crypto";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function scalar(sql) {
  return queryScalar(sql);
}

function columnExists(schema, table, column) {
  return scalar(`
select exists (
  select 1
  from information_schema.columns
  where table_schema = ${sqlString(schema)}
    and table_name = ${sqlString(table)}
    and column_name = ${sqlString(column)}
);
`) === "t";
}

const runId = randomUUID();
const firstBoot = randomUUID();
const secondBoot = randomUUID();
const runtimeInstanceId = `boot-recovery:${runId}`;

runSql(`
insert into game_engine.outcome_runtime_boot_identities (
  boot_id, runtime_instance_id, process_id, host_id, hostname, service_version,
  semantic_version, build_number, git_commit_sha, boot_timestamp, environment,
  provider_configuration_version, entropy_provider_id, entropy_provider_version,
  build_hash, runtime_framework
) values
(
  '${firstBoot}', ${sqlString(runtimeInstanceId)}, 4001, 'host-qa', 'host-qa', '1.0.0',
  '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)}, now(), 'QA',
  'provider-config-v1', 'entropy-qa', '1.0.0',
  ${sqlString(hash(`boot:first:${runId}`))}, '.NET QA'
),
(
  '${secondBoot}', ${sqlString(runtimeInstanceId)}, 4002, 'host-qa', 'host-qa', '1.0.0',
  '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)}, now() + interval '1 second', 'QA',
  'provider-config-v1', 'entropy-qa', '1.0.0',
  ${sqlString(hash(`boot:second:${runId}`))}, '.NET QA'
);

insert into game_engine.outcome_runtime_recovery_evidence (
  evidence_id, event_type, boot_id, runtime_instance_id, reason_code, details,
  recovery_hash, content_hash, created_at
) values
(
  '${randomUUID()}', 'Shutdown', '${firstBoot}', ${sqlString(runtimeInstanceId)},
  'OLD_SESSION_TERMINATED', 'Previous runtime session terminated; volatile generator material is not restored.',
  ${sqlString(hash(`shutdown:${runId}`))}, ${sqlString(hash(`shutdown-content:${runId}`))}, now()
),
(
  '${randomUUID()}', 'Boot', '${secondBoot}', ${sqlString(runtimeInstanceId)},
  'NEW_SESSION_CREATED', 'New boot creates a fresh runtime session and requires fresh provider initialization.',
  ${sqlString(hash(`boot-evidence:${runId}`))}, ${sqlString(hash(`boot-evidence-content:${runId}`))}, now()
);
`);

addCheck("every restart creates a new boot id", scalar(`
select count(distinct boot_id) = 2
from game_engine.outcome_runtime_boot_identities
where runtime_instance_id = ${sqlString(runtimeInstanceId)};
`) === "t");

addCheck("old session termination evidence persists", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_recovery_evidence
where boot_id = '${firstBoot}'
  and reason_code = 'OLD_SESSION_TERMINATED';
`) === "t");

addCheck("new session creation evidence persists", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_recovery_evidence
where boot_id = '${secondBoot}'
  and reason_code = 'NEW_SESSION_CREATED';
`) === "t");

addCheck("boot table has no raw entropy column", !columnExists("game_engine", "outcome_runtime_boot_identities", "raw_entropy"));
addCheck("boot table has no raw seed column", !columnExists("game_engine", "outcome_runtime_boot_identities", "raw_seed"));
addCheck("boot table has no drbg state column", !columnExists("game_engine", "outcome_runtime_boot_identities", "drbg_state"));

const duplicateBoot = runSql(`
insert into game_engine.outcome_runtime_boot_identities (
  boot_id, runtime_instance_id, process_id, host_id, hostname, service_version,
  semantic_version, build_number, git_commit_sha, boot_timestamp, environment,
  provider_configuration_version, build_hash, runtime_framework
) values (
  '${firstBoot}', ${sqlString(runtimeInstanceId)}, 4999, 'host-qa', 'host-qa', '1.0.0',
  '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)}, now(), 'QA',
  'provider-config-v1', ${sqlString(hash(`duplicate:${runId}`))}, '.NET QA'
);
`, { allowFailure: true });
addCheck("boot id reuse rejected", duplicateBoot.status !== 0, { stderr: duplicateBoot.stderr.trim() });

const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
printJson({ status, checks });
if (status !== "PASS") {
  process.exit(1);
}
