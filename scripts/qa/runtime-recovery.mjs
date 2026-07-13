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

function existsRegclass(name) {
  return scalar(`select to_regclass('${name}') is not null;`) === "t";
}

const runId = randomUUID();
const bootId = randomUUID();
const runtimeInstanceId = `runtime-recovery:${runId}`;

addCheck("boot identity table exists", existsRegclass("game_engine.outcome_runtime_boot_identities"));
addCheck("recovery evidence table exists", existsRegclass("game_engine.outcome_runtime_recovery_evidence"));

runSql(`
insert into game_engine.outcome_runtime_boot_identities (
  boot_id, runtime_instance_id, process_id, container_id, host_id, hostname,
  service_version, semantic_version, build_number, git_commit_sha, git_branch,
  docker_image_digest, build_timestamp, boot_timestamp, environment,
  provider_configuration_version, outcome_provider_id, outcome_provider_version,
  entropy_provider_id, entropy_provider_version, build_hash, runtime_framework
) values (
  '${bootId}', ${sqlString(runtimeInstanceId)}, 1001, 'container-qa', 'host-qa', 'host-qa',
  '1.0.0', '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)}, 'qa',
  'sha256:image-digest', now(), now(), 'QA',
  'provider-config-v1', 'provider-qa', '1.0.0',
  'entropy-qa', '1.0.0', ${sqlString(hash(`boot:${runId}`))}, '.NET QA'
);
`);

addCheck("boot identity persists", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_boot_identities
where boot_id = '${bootId}'
  and runtime_instance_id = ${sqlString(runtimeInstanceId)};
`) === "t");

const restartBootId = randomUUID();
runSql(`
insert into game_engine.outcome_runtime_boot_identities (
  boot_id, runtime_instance_id, process_id, container_id, host_id, hostname,
  service_version, semantic_version, build_number, git_commit_sha,
  docker_image_digest, build_timestamp, boot_timestamp, environment,
  provider_configuration_version, outcome_provider_id, outcome_provider_version,
  entropy_provider_id, entropy_provider_version, build_hash, runtime_framework
) values (
  '${restartBootId}', ${sqlString(runtimeInstanceId)}, 1002, 'container-qa-restart', 'host-qa', 'host-qa',
  '1.0.0', '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)},
  'sha256:image-digest', now(), now() + interval '1 second', 'QA',
  'provider-config-v1', 'provider-qa', '1.0.0',
  'entropy-qa', '1.0.0', ${sqlString(hash(`boot-restart:${runId}`))}, '.NET QA'
);
`);

addCheck("fresh boot id after restart", scalar(`
select count(distinct boot_id) = 2
from game_engine.outcome_runtime_boot_identities
where runtime_instance_id = ${sqlString(runtimeInstanceId)};
`) === "t");

runSql(`
insert into game_engine.outcome_runtime_recovery_evidence (
  evidence_id, event_type, boot_id, runtime_instance_id, reason_code, details,
  recovery_hash, content_hash, created_at
) values (
  '${randomUUID()}', 'Restart', '${restartBootId}', ${sqlString(runtimeInstanceId)},
  'RESTART_DETECTED', 'Restart created a new boot id and runtime evidence.',
  ${sqlString(hash(`recovery:${runId}:restart`))},
  ${sqlString(hash(`recovery-content:${runId}:restart`))},
  now()
);
`);

runSql(`
insert into game_engine.outcome_runtime_recovery_evidence (
  evidence_id, event_type, boot_id, runtime_instance_id, reason_code, details,
  recovery_hash, content_hash, created_at
) values (
  '${randomUUID()}', 'ProviderRecovery', '${restartBootId}', ${sqlString(runtimeInstanceId)},
  'FRESH_PROVIDER_SESSION', 'Fresh provider session required after restart; previous volatile generator material is not restored.',
  ${sqlString(hash(`recovery:${runId}:provider`))},
  ${sqlString(hash(`recovery-content:${runId}:provider`))},
  now()
);
`);

addCheck("restart recovery evidence persists", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_recovery_evidence
where boot_id = '${restartBootId}'
  and event_type = 'Restart'
  and reason_code = 'RESTART_DETECTED';
`) === "t");

addCheck("provider recovery evidence persists", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_recovery_evidence
where boot_id = '${restartBootId}'
  and event_type = 'ProviderRecovery'
  and reason_code = 'FRESH_PROVIDER_SESSION';
`) === "t");

const secretRejected = runSql(`
insert into game_engine.outcome_runtime_recovery_evidence (
  evidence_id, event_type, boot_id, runtime_instance_id, reason_code, details,
  recovery_hash, content_hash, created_at
) values (
  '${randomUUID()}', 'RecoveryAttempt', '${restartBootId}', ${sqlString(runtimeInstanceId)},
  'rawSeed-leak', 'must reject secret material',
  ${sqlString(hash(`recovery:${runId}:secret`))},
  ${sqlString(hash(`recovery-content:${runId}:secret`))},
  now()
);
`, { allowFailure: true });
addCheck("secret material rejected from recovery evidence", secretRejected.status !== 0, {
  stderr: secretRejected.stderr.trim(),
});

const updateBlocked = runSql(`
update game_engine.outcome_runtime_boot_identities
set hostname = 'mutated'
where boot_id = '${bootId}';
`, { allowFailure: true });
addCheck("boot identity update blocked", updateBlocked.status !== 0, { stderr: updateBlocked.stderr.trim() });

const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
printJson({ status, checks });
if (status !== "PASS") {
  process.exit(1);
}
