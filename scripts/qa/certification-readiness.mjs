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

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
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
const targetId = `outcome-provider:p0-007-11-ready:${runId}`;
const evidenceHashes = [
  `sha256:p0-007-11-ready-crypto:${runId}`,
  `sha256:p0-007-11-ready-stat:${runId}`,
  `sha256:p0-007-11-ready-registry:${runId}`,
];
const provenance = {
  gitCommitSha: "qa-git-sha",
  semanticVersion: "0.0.0-qa",
  buildNumber: `qa-${runId}`,
  dockerImageDigest: "sha256:qa-image-digest",
  compilerRuntimeVersion: "dotnet-qa",
  implementationHash: `sha256:p0-007-11-ready-implementation:${runId}`,
  configurationHash: `sha256:p0-007-11-ready-configuration:${runId}`,
};

function readinessSql({
  target = targetId,
  status,
  stat = true,
  crypto = true,
  evidence = true,
  health = true,
  runtime = true,
  guardrails = true,
  approved = true,
  disabled = true,
  blockers = [],
  hash,
}) {
  return `
insert into game_engine.certification_readiness_evaluations (
  evaluation_id,
  target_type,
  target_id,
  target_version,
  readiness_status,
  statistical_validation_passed,
  cryptographic_conformance_passed,
  required_evidence_complete,
  provider_health_passed,
  runtime_readiness_passed,
  guardrails_passed,
  provider_approved,
  outcome_authority_disabled,
  blockers,
  evidence_hashes,
  provenance,
  evaluated_at,
  canonical_evaluation_hash
) values (
  '${randomUUID()}',
  'OutcomeProvider',
  ${sqlString(target)},
  '1.0.0',
  ${sqlString(status)},
  ${stat ? "true" : "false"},
  ${crypto ? "true" : "false"},
  ${evidence ? "true" : "false"},
  ${health ? "true" : "false"},
  ${runtime ? "true" : "false"},
  ${guardrails ? "true" : "false"},
  ${approved ? "true" : "false"},
  ${disabled ? "true" : "false"},
  ${sqlJson(blockers)},
  ${sqlArray(evidenceHashes)},
  ${sqlJson(provenance)},
  now(),
  ${sqlString(hash)}
);`;
}

addCheck("certification readiness table exists", existsRegclass("game_engine.certification_readiness_evaluations"));
const serviceSource = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeValidationFrameworkService.cs", "utf8");
addCheck("readiness evaluation service exists", serviceSource.includes("EvaluateReadiness"));
addCheck("higher status resolution is explicit", serviceSource.includes("ResolveReadinessStatus"));

runSql(readinessSql({
  status: "CertificationReady",
  hash: `sha256:p0-007-11-cert-ready:${runId}`,
}));
addCheck(
  "certification readiness persists with independent pass flags",
  rowCount(`
select count(*)
from game_engine.certification_readiness_evaluations
where target_id = ${sqlString(targetId)}
  and readiness_status = 'CertificationReady'
  and statistical_validation_passed
  and cryptographic_conformance_passed
  and required_evidence_complete
  and provider_health_passed
  and runtime_readiness_passed
  and guardrails_passed
  and provider_approved
  and outcome_authority_disabled;
`) === 1,
);

runSql(readinessSql({
  target: `${targetId}:stat-only`,
  status: "StatisticallyValidated",
  crypto: false,
  evidence: false,
  health: false,
  runtime: false,
  guardrails: false,
  approved: false,
  blockers: [
    "Cryptographic conformance must pass.",
    "Required validation evidence must be complete.",
  ],
  hash: `sha256:p0-007-11-stat-only:${runId}`,
}));
addCheck(
  "statistical validation does not imply cryptographic conformance",
  rowCount(`
select count(*)
from game_engine.certification_readiness_evaluations
where target_id = ${sqlString(`${targetId}:stat-only`)}
  and readiness_status = 'StatisticallyValidated'
  and statistical_validation_passed
  and not cryptographic_conformance_passed;
`) === 1,
);

runSql(readinessSql({
  target: `${targetId}:crypto-only`,
  status: "CryptographicallyConformant",
  stat: false,
  evidence: false,
  health: false,
  runtime: false,
  guardrails: false,
  approved: false,
  blockers: [
    "Statistical validation must pass.",
    "Required validation evidence must be complete.",
  ],
  hash: `sha256:p0-007-11-crypto-only:${runId}`,
}));
addCheck(
  "cryptographic conformance does not imply certification readiness",
  rowCount(`
select count(*)
from game_engine.certification_readiness_evaluations
where target_id = ${sqlString(`${targetId}:crypto-only`)}
  and readiness_status = 'CryptographicallyConformant'
  and cryptographic_conformance_passed
  and not statistical_validation_passed;
`) === 1,
);

const missingProvenance = runSql(readinessSql({
  target: `${targetId}:bad-provenance`,
  status: "CertificationReady",
  hash: `sha256:p0-007-11-bad-provenance:${runId}`,
}).replace('"gitCommitSha":"qa-git-sha",', ""), { allowFailure: true });
addCheck("missing supply-chain provenance rejected", missingProvenance.status !== 0, {
  stderr: missingProvenance.stderr.trim(),
});

const deleteReadiness = runSql(
  `delete from game_engine.certification_readiness_evaluations where target_id = ${sqlString(targetId)};`,
  { allowFailure: true },
);
addCheck("readiness evidence delete blocked", deleteReadiness.status !== 0, { stderr: deleteReadiness.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exitCode = 1;
}
