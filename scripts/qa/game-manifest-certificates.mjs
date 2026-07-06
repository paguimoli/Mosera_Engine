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

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(queryScalar(sql));
}

const runId = randomUUID();
const gameId = randomUUID();
const manifestId = randomUUID();
const duplicateManifestId = randomUUID();
const firstCertificateId = randomUUID();
const secondCertificateId = randomUUID();
const manifestHash = `sha256:p0-005-2-manifest:${runId}`;
const duplicateManifestHash = `sha256:p0-005-2-manifest-duplicate:${runId}`;
const firstCertificateHash = `sha256:p0-005-2-certificate-1:${runId}`;
const secondCertificateHash = `sha256:p0-005-2-certificate-2:${runId}`;

addCheck("game manifest table exists", existsRegclass("game_engine.game_manifests"));
addCheck("authority certificate table exists", existsRegclass("game_engine.authority_certificates"));

const insertManifestSql = `
insert into game_engine.game_manifests (
  id,
  game_id,
  game_code,
  game_name,
  game_family,
  jurisdiction_bindings,
  wager_schemas,
  outcome_strategy_references,
  math_model_references,
  paytable_references,
  settlement_policy_references,
  sales_rules,
  cancellation_correction_rules,
  replay_resettlement_policy,
  certification_pack_reference,
  regulator_profile,
  operator_approval_state,
  lifecycle_state,
  effective_from,
  effective_to,
  semantic_version,
  content_hash,
  signature_metadata
) values (
  '${manifestId}',
  '${gameId}',
  'P00052',
  'P0-005.2 Manifest QA',
  'Lottery',
  ${sqlJson(["US-NJ", "US-PA"])},
  ${sqlJson([{ wagerType: "straight", schemaVersion: "wager-schema-v1" }])},
  ${sqlJson(["outcome-strategy:number-set:v1"])},
  ${sqlJson(["math-model:pick:v1"])},
  ${sqlJson(["paytable:pick:v1"])},
  ${sqlJson(["settlement-policy:standard:v1"])},
  ${sqlJson({ salesOpenOffsetMinutes: -60, salesCloseOffsetMinutes: -5 })},
  ${sqlJson({ cancellationPolicy: "dual-approval", correctionPolicy: "supersession-only" })},
  ${sqlJson({ replay: "approval-required", resettlement: "impact-preview-required" })},
  'cert-pack:p0-005-2:v1',
  'regulator-profile:test',
  'Approved',
  'GovernanceApproved',
  now(),
  null,
  '1.0.0',
  ${sqlString(manifestHash)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;

runSql(insertManifestSql);
addCheck(
  "create manifest version",
  rowCount(`
select count(*)
from game_engine.game_manifests
where id = '${manifestId}'
  and game_id = '${gameId}'
  and semantic_version = '1.0.0'
  and content_hash = ${sqlString(manifestHash)};
`) === 1,
  { manifestId, gameId, manifestHash }
);

const duplicateManifestResult = runSql(insertManifestSql, { allowFailure: true });
addCheck("duplicate manifest version blocked", duplicateManifestResult.status !== 0, {
  stderr: duplicateManifestResult.stderr.trim(),
});

const duplicateManifestVersionSql = insertManifestSql
  .replace(`'${manifestId}'`, `'${duplicateManifestId}'`)
  .replace(sqlString(manifestHash), sqlString(duplicateManifestHash));
const duplicateManifestVersionResult = runSql(duplicateManifestVersionSql, { allowFailure: true });
addCheck("duplicate game semantic version blocked", duplicateManifestVersionResult.status !== 0, {
  stderr: duplicateManifestVersionResult.stderr.trim(),
});

runSql(`
insert into game_engine.authority_certificates (
  certificate_id,
  authority_id,
  certificate_type,
  subject_id,
  subject_version,
  canonical_payload_hash,
  previous_certificate_id,
  previous_certificate_hash,
  signing_key_id,
  hash_algorithm_version,
  signing_algorithm_version,
  issued_at,
  jurisdiction_profile,
  approval_state,
  certificate_payload
) values (
  '${firstCertificateId}',
  'governance-authority',
  'GameManifest',
  '${manifestId}',
  '1.0.0',
  ${sqlString(firstCertificateHash)},
  null,
  null,
  'qa-signing-key',
  'sha256-v1',
  'ed25519-v1',
  now(),
  'regulator-profile:test',
  'Approved',
  ${sqlJson({ manifestId, contentHash: manifestHash })}
);
`);

runSql(`
insert into game_engine.authority_certificates (
  certificate_id,
  authority_id,
  certificate_type,
  subject_id,
  subject_version,
  canonical_payload_hash,
  previous_certificate_id,
  previous_certificate_hash,
  signing_key_id,
  hash_algorithm_version,
  signing_algorithm_version,
  issued_at,
  jurisdiction_profile,
  approval_state,
  certificate_payload
) values (
  '${secondCertificateId}',
  'outcome-authority',
  'OutcomeStrategy',
  'outcome-strategy:number-set',
  '1.0.0',
  ${sqlString(secondCertificateHash)},
  '${firstCertificateId}',
  ${sqlString(firstCertificateHash)},
  'qa-signing-key',
  'sha256-v1',
  'ed25519-v1',
  now(),
  'regulator-profile:test',
  'Approved',
  ${sqlJson({ previousCertificateId: firstCertificateId })}
);
`);

addCheck(
  "certificate persists",
  rowCount(`
select count(*)
from game_engine.authority_certificates
where certificate_id = '${firstCertificateId}'
  and certificate_type = 'GameManifest'
  and subject_id = '${manifestId}'
  and subject_version = '1.0.0'
  and canonical_payload_hash = ${sqlString(firstCertificateHash)};
`) === 1,
  { firstCertificateId, firstCertificateHash }
);

addCheck(
  "certificate hash chain persists",
  rowCount(`
select count(*)
from game_engine.authority_certificates child
join game_engine.authority_certificates parent
  on parent.certificate_id = child.previous_certificate_id
where child.certificate_id = '${secondCertificateId}'
  and child.previous_certificate_hash = parent.canonical_payload_hash;
`) === 1,
  { secondCertificateId, previousCertificateId: firstCertificateId }
);

addCheck(
  "lookup by subject version hash works",
  rowCount(`
select count(*)
from game_engine.authority_certificates
where subject_id = 'outcome-strategy:number-set'
  and subject_version = '1.0.0'
  and canonical_payload_hash = ${sqlString(secondCertificateHash)};
`) === 1,
  { subjectId: "outcome-strategy:number-set", secondCertificateHash }
);

const updateManifest = runSql(
  `update game_engine.game_manifests set game_name = 'mutated' where id = '${manifestId}';`,
  { allowFailure: true },
);
addCheck("manifest update blocked", updateManifest.status !== 0, { stderr: updateManifest.stderr.trim() });

const deleteCertificate = runSql(
  `delete from game_engine.authority_certificates where certificate_id = '${secondCertificateId}';`,
  { allowFailure: true },
);
addCheck("certificate delete blocked", deleteCertificate.status !== 0, { stderr: deleteCertificate.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
