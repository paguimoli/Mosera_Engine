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

function rowCount(sql) {
  return Number(queryScalar(sql));
}

const runId = randomUUID();
const targetId = `certified-csprng:p0-007-11-eligibility:${runId}`;
const provenance = {
  gitCommitSha: "qa-git-sha",
  semanticVersion: "0.0.0-qa",
  buildNumber: `qa-${runId}`,
  dockerImageDigest: "sha256:qa-image-digest",
  compilerRuntimeVersion: "dotnet-qa",
  implementationHash: `sha256:p0-007-11-eligibility-implementation:${runId}`,
  configurationHash: `sha256:p0-007-11-eligibility-configuration:${runId}`,
};
const evidenceHashes = [
  `sha256:p0-007-11-eligibility-crypto:${runId}`,
  `sha256:p0-007-11-eligibility-stat:${runId}`,
  `sha256:p0-007-11-eligibility-health:${runId}`,
];

function eligibilitySql({
  target = targetId,
  status = "ProductionEligible",
  stat = true,
  crypto = true,
  evidence = true,
  health = true,
  runtime = true,
  guardrails = true,
  approved = true,
  disabled = true,
  blockers = [],
  productionAuthorityEnabled = false,
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
  canonical_evaluation_hash,
  production_authority_enabled
) values (
  '${randomUUID()}',
  'CertifiedCsprng',
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
  ${sqlString(hash)},
  ${productionAuthorityEnabled ? "true" : "false"}
);`;
}

const source = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeValidationFrameworkService.cs", "utf8");
addCheck("production eligibility evaluator requires Outcome Authority disabled", source.includes("Outcome Authority must remain disabled"));

runSql(eligibilitySql({
  hash: `sha256:p0-007-11-production-eligible:${runId}`,
}));
addCheck(
  "synthetic production eligibility evidence persists without activation",
  rowCount(`
select count(*)
from game_engine.certification_readiness_evaluations
where target_id = ${sqlString(targetId)}
  and readiness_status = 'ProductionEligible'
  and statistical_validation_passed
  and cryptographic_conformance_passed
  and required_evidence_complete
  and provider_health_passed
  and runtime_readiness_passed
  and guardrails_passed
  and provider_approved
  and outcome_authority_disabled
  and production_authority_enabled = false;
`) === 1,
);

const missingCrypto = runSql(eligibilitySql({
  target: `${targetId}:missing-crypto`,
  crypto: false,
  blockers: ["Cryptographic conformance must pass."],
  hash: `sha256:p0-007-11-production-missing-crypto:${runId}`,
}), { allowFailure: true });
addCheck("production eligibility without cryptographic conformance rejected", missingCrypto.status !== 0, {
  stderr: missingCrypto.stderr.trim(),
});

const missingStat = runSql(eligibilitySql({
  target: `${targetId}:missing-stat`,
  stat: false,
  blockers: ["Statistical validation must pass."],
  hash: `sha256:p0-007-11-production-missing-stat:${runId}`,
}), { allowFailure: true });
addCheck("production eligibility without statistical validation rejected", missingStat.status !== 0, {
  stderr: missingStat.stderr.trim(),
});

const activationAttempt = runSql(eligibilitySql({
  target: `${targetId}:activation`,
  productionAuthorityEnabled: true,
  hash: `sha256:p0-007-11-production-activation:${runId}`,
}), { allowFailure: true });
addCheck("production eligibility cannot enable Outcome Authority", activationAttempt.status !== 0, {
  stderr: activationAttempt.stderr.trim(),
});

const authorityNotDisabled = runSql(eligibilitySql({
  target: `${targetId}:authority-enabled`,
  disabled: false,
  blockers: ["Outcome Authority must remain disabled during readiness evaluation."],
  hash: `sha256:p0-007-11-authority-enabled:${runId}`,
}), { allowFailure: true });
addCheck("production eligibility requires Outcome Authority disabled", authorityNotDisabled.status !== 0, {
  stderr: authorityNotDisabled.stderr.trim(),
});

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exitCode = 1;
}
