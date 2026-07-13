import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `array[${values.map(sqlString).join(", ")}]`;
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(queryScalar(sql));
}

const runId = randomUUID();
const providerId = `provider:p0-007-11-registry:${runId}`;
const registryHash = `sha256:p0-007-11-registry:${runId}`;
const implementationHash = `sha256:p0-007-11-registry-implementation:${runId}`;
const configurationHash = `sha256:p0-007-11-registry-configuration:${runId}`;
const evidenceHashes = [
  `sha256:p0-007-11-registry-crypto:${runId}`,
  `sha256:p0-007-11-registry-stat:${runId}`,
];

addCheck("provider validation registry table exists", existsRegclass("game_engine.provider_validation_registry"));
addCheck(
  "provider validation registry .NET model exists",
  readFileSync("services/game-engine/src/GameEngine.Domain/Model/OutcomeValidationFrameworkModels.cs", "utf8")
    .includes("ProviderValidationRegistryEntry"),
);

runSql(`
insert into game_engine.provider_validation_registry (
  registry_entry_id,
  provider_type,
  provider_id,
  provider_version,
  validation_version,
  implementation_hash,
  configuration_hash,
  validation_status,
  validation_date,
  operator,
  evidence_hashes,
  canonical_registry_hash
) values (
  '${randomUUID()}',
  'OutcomeProvider',
  ${sqlString(providerId)},
  '1.0.0',
  'validation-v1',
  ${sqlString(implementationHash)},
  ${sqlString(configurationHash)},
  'Pass',
  now(),
  'qa-operator',
  ${sqlArray(evidenceHashes)},
  ${sqlString(registryHash)}
);`);

addCheck(
  "provider registry records permanent validation history",
  rowCount(`
select count(*)
from game_engine.provider_validation_registry
where provider_id = ${sqlString(providerId)}
  and provider_version = '1.0.0'
  and validation_version = 'validation-v1'
  and validation_status = 'Pass'
  and canonical_registry_hash = ${sqlString(registryHash)};
`) === 1,
  { registryHash },
);

const invalidEvidenceHash = runSql(`
insert into game_engine.provider_validation_registry (
  registry_entry_id, provider_type, provider_id, provider_version, validation_version,
  implementation_hash, configuration_hash, validation_status, validation_date, operator,
  evidence_hashes, canonical_registry_hash
) values (
  '${randomUUID()}',
  'OutcomeProvider',
  ${sqlString(`${providerId}:invalid`)},
  '1.0.0',
  'validation-v1',
  ${sqlString(`sha256:p0-007-11-invalid-implementation:${runId}`)},
  ${sqlString(`sha256:p0-007-11-invalid-configuration:${runId}`)},
  'Pass',
  now(),
  'qa-operator',
  array['not-a-hash'],
  ${sqlString(`sha256:p0-007-11-invalid-registry:${runId}`)}
);`, { allowFailure: true });
addCheck("registry rejects invalid evidence hashes", invalidEvidenceHash.status !== 0, {
  stderr: invalidEvidenceHash.stderr.trim(),
});

const duplicate = runSql(`
insert into game_engine.provider_validation_registry (
  registry_entry_id, provider_type, provider_id, provider_version, validation_version,
  implementation_hash, configuration_hash, validation_status, validation_date, operator,
  evidence_hashes, canonical_registry_hash
) values (
  '${randomUUID()}',
  'OutcomeProvider',
  ${sqlString(`${providerId}:duplicate`)},
  '1.0.0',
  'validation-v1',
  ${sqlString(`sha256:p0-007-11-duplicate-implementation:${runId}`)},
  ${sqlString(`sha256:p0-007-11-duplicate-configuration:${runId}`)},
  'Pass',
  now(),
  'qa-operator',
  ${sqlArray(evidenceHashes)},
  ${sqlString(registryHash)}
);`, { allowFailure: true });
addCheck("duplicate registry evidence rejected", duplicate.status !== 0, { stderr: duplicate.stderr.trim() });

const update = runSql(
  `update game_engine.provider_validation_registry set validation_status = 'Fail' where provider_id = ${sqlString(providerId)};`,
  { allowFailure: true },
);
addCheck("registry update blocked", update.status !== 0, { stderr: update.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exitCode = 1;
}
