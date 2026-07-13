import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
const reportId = randomUUID();
const reportHash = `sha256:p0-007-11-crypto:${runId}`;
const subjectId = `certified-csprng:p0-007-11:${runId}`;
const provenance = {
  gitCommitSha: "qa-git-sha",
  semanticVersion: "0.0.0-qa",
  buildNumber: `qa-${runId}`,
  dockerImageDigest: "sha256:qa-image-digest",
  compilerRuntimeVersion: "dotnet-qa",
  implementationHash: `sha256:p0-007-11-implementation:${runId}`,
  configurationHash: `sha256:p0-007-11-configuration:${runId}`,
};

const allChecks = [
  "HmacDrbgInstantiate",
  "HmacDrbgGenerate",
  "HmacDrbgReseed",
  "HmacDrbgUpdate",
  "HmacDrbgDestroy",
  "SecurityStrength",
  "PredictionResistancePolicy",
  "ReseedIntervalPolicy",
  "PersonalizationHandling",
  "AdditionalInputHandling",
  "KnownAnswerTests",
  "ContinuousTests",
  "HealthTests",
  "ProviderVersionCompatibility",
  "ProviderConfiguration",
];

addCheck("cryptographic conformance table exists", existsRegclass("game_engine.cryptographic_conformance_reports"));
addCheck(
  "cryptographic conformance .NET service exists",
  existsSync("services/game-engine/src/GameEngine.Application/Services/OutcomeValidationFrameworkService.cs"),
);
addCheck(
  "cryptographic conformance .NET model exists",
  readFileSync("services/game-engine/src/GameEngine.Domain/Model/OutcomeValidationFrameworkModels.cs", "utf8")
    .includes("CryptographicConformanceReport"),
);

runSql(`
insert into game_engine.cryptographic_conformance_reports (
  report_id,
  subject_type,
  subject_id,
  subject_version,
  subject_content_hash,
  checks_evaluated,
  status,
  blockers,
  test_vectors,
  provider_evidence,
  provenance,
  started_at,
  completed_at,
  canonical_report_hash,
  signing_metadata
) values (
  '${reportId}',
  'CertifiedCsprng',
  ${sqlString(subjectId)},
  '1.0.0',
  ${sqlString(`sha256:p0-007-11-subject:${runId}`)},
  ${sqlArray(allChecks)},
  'Pass',
  '[]'::jsonb,
  ${sqlJson({ knownAnswerTests: "passed", hmacDrbgLifecycle: allChecks })},
  ${sqlJson({ healthTestsPassed: true, knownAnswerTestsPassed: true, continuousTestsPassed: true })},
  ${sqlJson(provenance)},
  now(),
  now(),
  ${sqlString(reportHash)},
  ${sqlJson({ signingKeyId: "placeholder-validation", signature: "placeholder" })}
);`);

addCheck(
  "Known Answer Tests and conformance evaluation persist",
  rowCount(`
select count(*)
from game_engine.cryptographic_conformance_reports
where report_id = '${reportId}'
  and status = 'Pass'
  and checks_evaluated @> array['KnownAnswerTests', 'HmacDrbgInstantiate', 'HmacDrbgDestroy']
  and provider_evidence->>'knownAnswerTestsPassed' = 'true'
  and canonical_report_hash = ${sqlString(reportHash)};
`) === 1,
  { reportHash },
);

const invalidPass = runSql(`
insert into game_engine.cryptographic_conformance_reports (
  report_id, subject_type, subject_id, subject_version, subject_content_hash,
  checks_evaluated, status, blockers, test_vectors, provider_evidence,
  provenance, started_at, completed_at, canonical_report_hash
) values (
  '${randomUUID()}',
  'CertifiedCsprng',
  ${sqlString(`${subjectId}:invalid`)},
  '1.0.0',
  ${sqlString(`sha256:p0-007-11-invalid:${runId}`)},
  ${sqlArray(["KnownAnswerTests"])},
  'Pass',
  ${sqlJson(["missing lifecycle checks"])},
  '{}'::jsonb,
  '{}'::jsonb,
  ${sqlJson(provenance)},
  now(),
  now(),
  ${sqlString(`sha256:p0-007-11-invalid-pass:${runId}`)}
);`, { allowFailure: true });
addCheck("passing conformance with blockers rejected", invalidPass.status !== 0, { stderr: invalidPass.stderr.trim() });

const duplicate = runSql(`
insert into game_engine.cryptographic_conformance_reports (
  report_id, subject_type, subject_id, subject_version, subject_content_hash,
  checks_evaluated, status, blockers, test_vectors, provider_evidence,
  provenance, started_at, completed_at, canonical_report_hash
) values (
  '${randomUUID()}',
  'CertifiedCsprng',
  ${sqlString(`${subjectId}:duplicate`)},
  '1.0.0',
  ${sqlString(`sha256:p0-007-11-duplicate:${runId}`)},
  ${sqlArray(allChecks)},
  'Pass',
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  ${sqlJson(provenance)},
  now(),
  now(),
  ${sqlString(reportHash)}
);`, { allowFailure: true });
addCheck("duplicate conformance evidence hash rejected", duplicate.status !== 0, { stderr: duplicate.stderr.trim() });

const update = runSql(
  `update game_engine.cryptographic_conformance_reports set status = 'Fail' where report_id = '${reportId}';`,
  { allowFailure: true },
);
addCheck("append-only conformance update blocked", update.status !== 0, { stderr: update.stderr.trim() });

const activation = runSql(`
insert into game_engine.cryptographic_conformance_reports (
  report_id, subject_type, subject_id, subject_version, subject_content_hash,
  checks_evaluated, status, blockers, test_vectors, provider_evidence,
  provenance, started_at, completed_at, canonical_report_hash, production_authority_enabled
) values (
  '${randomUUID()}',
  'CertifiedCsprng',
  ${sqlString(`${subjectId}:activation`)},
  '1.0.0',
  ${sqlString(`sha256:p0-007-11-activation:${runId}`)},
  ${sqlArray(allChecks)},
  'Pass',
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  ${sqlJson(provenance)},
  now(),
  now(),
  ${sqlString(`sha256:p0-007-11-activation:${runId}`)},
  true
);`, { allowFailure: true });
addCheck("no production activation via conformance evidence", activation.status !== 0, { stderr: activation.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exitCode = 1;
}
