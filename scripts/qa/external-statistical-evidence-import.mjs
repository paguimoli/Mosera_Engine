import { randomUUID } from "node:crypto";
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

const runId = randomUUID();
const reportId = randomUUID();
const targetId = `certified-csprng:p0-007-13-external:${runId}`;
const reportHash = `sha256:p0-007-13-external:${runId}`;
const provenance = {
  gitCommitSha: "qa-git-sha",
  semanticVersion: "0.0.0-qa",
  buildNumber: `qa-${runId}`,
  dockerImageDigest: "sha256:qa-image-digest",
  compilerRuntimeVersion: "dotnet-qa",
  implementationHash: `sha256:p0-007-13-implementation:${runId}`,
  configurationHash: `sha256:p0-007-13-configuration:${runId}`,
};

runSql(`
insert into game_engine.statistical_validation_framework_reports (
  report_id, suite_type, target_type, target_id, target_version, target_content_hash,
  algorithm_version, sample_size, configuration, statistical_summary, status, blockers,
  provenance, started_at, completed_at, canonical_report_hash, signing_metadata,
  external_report_imported
) values (
  '${reportId}', 'ExternalImported', 'CertifiedCsprng', ${sqlString(targetId)}, '1.0.0',
  ${sqlString(`sha256:p0-007-13-target:${runId}`)}, 'external-suite-import-v1', 1000000,
  ${sqlJson({
    source: "NIST SP 800-22",
    toolVersion: "qa-import",
    providerBuildIdentity: "qa-provider-build",
    reportHash,
    runtimeSuiteBundled: false,
  })},
  ${sqlJson({ passRate: "all-applicable-tests-passed", reportHash })},
  'Pass', '[]'::jsonb, ${sqlJson(provenance)}, now(), now(), ${sqlString(reportHash)},
  ${sqlJson({ signingKeyId: "placeholder", signature: "placeholder" })}, true
);
`);

addCheck("external statistical report persists", queryScalar(`
select count(*) = 1
from game_engine.statistical_validation_framework_reports
where report_id = '${reportId}'
  and suite_type = 'ExternalImported'
  and external_report_imported = true
  and configuration->>'runtimeSuiteBundled' = 'false'
  and configuration ? 'source'
  and configuration ? 'toolVersion'
  and configuration ? 'providerBuildIdentity'
  and configuration ? 'reportHash';
`) === "t");

const update = runSql(
  `update game_engine.statistical_validation_framework_reports set status = 'Fail' where report_id = '${reportId}';`,
  { allowFailure: true },
);
addCheck("external statistical report append-only update blocked", update.status !== 0, { stderr: update.stderr.trim() });

const duplicate = runSql(`
insert into game_engine.statistical_validation_framework_reports (
  report_id, suite_type, target_type, target_id, target_version, target_content_hash,
  algorithm_version, sample_size, configuration, statistical_summary, status, blockers,
  provenance, started_at, completed_at, canonical_report_hash, external_report_imported
) values (
  '${randomUUID()}', 'ExternalImported', 'CertifiedCsprng', ${sqlString(`${targetId}:duplicate`)}, '1.0.0',
  ${sqlString(`sha256:p0-007-13-target-duplicate:${runId}`)}, 'external-suite-import-v1', 1000000,
  '{}'::jsonb, '{}'::jsonb, 'Pass', '[]'::jsonb, ${sqlJson(provenance)}, now(), now(),
  ${sqlString(reportHash)}, true
);
`, { allowFailure: true });
addCheck("duplicate external report hash rejected", duplicate.status !== 0, { stderr: duplicate.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });
if (failed.length > 0) {
  process.exitCode = 1;
}
