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
const targetId = `outcome-provider:p0-007-11-stat:${runId}`;
const provenance = {
  gitCommitSha: "qa-git-sha",
  semanticVersion: "0.0.0-qa",
  buildNumber: `qa-${runId}`,
  dockerImageDigest: "sha256:qa-image-digest",
  compilerRuntimeVersion: "dotnet-qa",
  implementationHash: `sha256:p0-007-11-stat-implementation:${runId}`,
  configurationHash: `sha256:p0-007-11-stat-configuration:${runId}`,
};

function reportSql({ suiteType, status = "Pass", blockers = [], hash }) {
  return `
insert into game_engine.statistical_validation_framework_reports (
  report_id,
  suite_type,
  target_type,
  target_id,
  target_version,
  target_content_hash,
  manifest_id,
  manifest_version,
  algorithm_version,
  sample_size,
  configuration,
  statistical_summary,
  status,
  blockers,
  provenance,
  started_at,
  completed_at,
  canonical_report_hash,
  signing_metadata,
  external_report_imported
) values (
  '${randomUUID()}',
  ${sqlString(suiteType)},
  'OutcomeProvider',
  ${sqlString(targetId)},
  '1.0.0',
  ${sqlString(`sha256:p0-007-11-stat-target:${runId}`)},
  'manifest:p0-007-11',
  '1.0.0',
  'internal-suite-v1',
  100000,
  ${sqlJson({ expectedDistribution: { a: 0.5, b: 0.5 }, importedTool: suiteType === "ExternalImported" ? "NIST-SP-800-22-placeholder" : null })},
  ${sqlJson({
    frequency: { maxDeviation: 0.001 },
    chiSquare: { pValue: 0.74 },
    runs: { zScore: 0.31 },
    uniformity: { passed: true },
    biasDetection: { detected: false },
    weightedSelection: { expectedWeightRatio: "1:3", observedRatio: "1:3.01" },
    shuffle: { permutationCoverage: 0.997 },
  })},
  ${sqlString(status)},
  ${sqlJson(blockers)},
  ${sqlJson(provenance)},
  now(),
  now(),
  ${sqlString(hash)},
  ${sqlJson({ signingKeyId: "placeholder-validation", signature: "placeholder" })},
  ${suiteType === "ExternalImported" ? "true" : "false"}
);`;
}

addCheck("statistical validation framework table exists", existsRegclass("game_engine.statistical_validation_framework_reports"));
const serviceSource = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeValidationFrameworkService.cs", "utf8");
addCheck("frequency evaluation service exists", serviceSource.includes("EvaluateFrequency"));
addCheck("external statistical import service exists", serviceSource.includes("ImportExternalStatisticalReport"));

const suiteTypes = [
  "Frequency",
  "ChiSquare",
  "Runs",
  "Uniformity",
  "BiasDetection",
  "WeightedSelection",
  "FisherYatesShuffle",
  "RtpSimulation",
  "PrizeDistribution",
  "ExternalImported",
];

for (const suiteType of suiteTypes) {
  runSql(reportSql({
    suiteType,
    hash: `sha256:p0-007-11-stat:${suiteType}:${runId}`,
  }));
}

addCheck(
  "frequency, chi-square, runs, uniformity, bias, weighted, shuffle, RTP, prize, and external reports persist",
  rowCount(`
select count(*)
from game_engine.statistical_validation_framework_reports
where target_id = ${sqlString(targetId)}
  and status = 'Pass';
`) === suiteTypes.length,
  { suiteTypes },
);

const invalidFailed = runSql(reportSql({
  suiteType: "Frequency",
  status: "Fail",
  blockers: [],
  hash: `sha256:p0-007-11-stat-failed-empty:${runId}`,
}), { allowFailure: true });
addCheck("failed statistical report without blockers rejected", invalidFailed.status !== 0, {
  stderr: invalidFailed.stderr.trim(),
});

const invalidPass = runSql(reportSql({
  suiteType: "Frequency",
  status: "Pass",
  blockers: ["bias detected"],
  hash: `sha256:p0-007-11-stat-pass-blocked:${runId}`,
}), { allowFailure: true });
addCheck("passing statistical report with blockers rejected", invalidPass.status !== 0, {
  stderr: invalidPass.stderr.trim(),
});

const update = runSql(
  `update game_engine.statistical_validation_framework_reports set status = 'Fail' where target_id = ${sqlString(targetId)};`,
  { allowFailure: true },
);
addCheck("append-only statistical report update blocked", update.status !== 0, { stderr: update.stderr.trim() });

const lookupCount = rowCount(`
select count(*)
from game_engine.statistical_validation_framework_reports
where suite_type = 'Frequency'
  and target_type = 'OutcomeProvider'
  and target_content_hash = ${sqlString(`sha256:p0-007-11-stat-target:${runId}`)};
`);
addCheck("lookup by artifact/type/hash works", lookupCount === 1, { lookupCount });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exitCode = 1;
}
