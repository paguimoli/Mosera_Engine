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

function sqlJsonNullable(value) {
  return value === null || value === undefined ? "null::jsonb" : sqlJson(value);
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

function mathModelInsertSql({
  id = randomUUID(),
  mathModelId,
  version = "1.0.0",
  expectedRtp = 0.92,
  contentHash,
  prizeLiabilityProfile = { maxExposureMultiple: 100 },
  jackpotContributionModel = { contributionBasisPoints: 50 },
  jurisdictionProfileReferences = null,
  rtpPolicyConstraints = null,
  certificationBindingState = "None",
}) {
  return `
insert into game_engine.math_model_definitions (
  id,
  math_model_id,
  version,
  game_family_compatibility,
  supported_wager_schemas,
  expected_rtp,
  expected_value,
  volatility_profile,
  hit_frequency,
  prize_liability_profile,
  jackpot_contribution_model,
  rounding_policy,
  currency_minor_unit_policy,
  jurisdiction_profile_references,
  rtp_policy_constraints,
  lifecycle_state,
  content_hash,
  certification_binding_state,
  signature_metadata
) values (
  '${id}',
  ${sqlString(mathModelId)},
  ${sqlString(version)},
  ${sqlJson(["Lottery"])},
  ${sqlJson(["straight-v1", "box-v1"])},
  ${expectedRtp},
  -0.08,
  'Medium',
  0.18,
  ${sqlJson(prizeLiabilityProfile)},
  ${sqlJson(jackpotContributionModel)},
  ${sqlJson({ mode: "bankers", precisionMinorUnits: 2 })},
  ${sqlJson({ currency: "USD", minorUnit: 2 })},
  ${sqlJsonNullable(jurisdictionProfileReferences)},
  ${sqlJsonNullable(rtpPolicyConstraints)},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  ${sqlString(certificationBindingState)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

function paytableInsertSql({
  id = randomUUID(),
  paytableId,
  version = "1.0.0",
  mathModelId,
  mathModelVersion = "1.0.0",
  contentHash,
  prizeMatrixRows = [
    {
      rowId: "straight-win",
      wagerSchema: "straight-v1",
      prizeCode: "STRAIGHT_WIN",
      multiplier: 500,
      payoutValue: 0,
      maxPayout: 5000,
      conditions: { matchCount: 3 },
    },
  ],
  bonusSideBetRows = [
    {
      rowId: "bonus-side-bet",
      wagerSchema: "bonus-v1",
      prizeCode: "BONUS",
      multiplier: 0,
      payoutValue: 25,
      maxPayout: 250,
      conditions: { bonusCode: "B1" },
    },
  ],
  caps = { maxPayout: 5000 },
  jurisdictionProfileReferences = null,
  certificationBindingState = "None",
}) {
  return `
insert into game_engine.paytable_definitions (
  id,
  paytable_id,
  version,
  math_model_id,
  math_model_version,
  prize_matrix_rows,
  bonus_side_bet_rows,
  caps,
  jurisdiction_profile_references,
  lifecycle_state,
  content_hash,
  certification_binding_state,
  signature_metadata
) values (
  '${id}',
  ${sqlString(paytableId)},
  ${sqlString(version)},
  ${sqlString(mathModelId)},
  ${sqlString(mathModelVersion)},
  ${sqlJson(prizeMatrixRows)},
  ${sqlJson(bonusSideBetRows)},
  ${sqlJson(caps)},
  ${sqlJsonNullable(jurisdictionProfileReferences)},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  ${sqlString(certificationBindingState)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

const runId = randomUUID();
const mathModelId = `math-model:p0-005-4:${runId}`;
const paytableId = `paytable:p0-005-4:${runId}`;
const mathHash = `sha256:p0-005-4-math:${runId}`;
const paytableHash = `sha256:p0-005-4-paytable:${runId}`;

addCheck("math model definition table exists", existsRegclass("game_engine.math_model_definitions"));
addCheck("paytable definition table exists", existsRegclass("game_engine.paytable_definitions"));

runSql(mathModelInsertSql({ mathModelId, contentHash: mathHash }));
addCheck(
  "math model without jurisdiction persists",
  rowCount(`
select count(*)
from game_engine.math_model_definitions
where math_model_id = ${sqlString(mathModelId)}
  and version = '1.0.0'
  and content_hash = ${sqlString(mathHash)}
  and jurisdiction_profile_references is null
  and certification_binding_state = 'None';
`) === 1,
  { mathModelId, mathHash },
);

runSql(paytableInsertSql({ paytableId, mathModelId, contentHash: paytableHash }));
addCheck(
  "paytable without jurisdiction persists",
  rowCount(`
select count(*)
from game_engine.paytable_definitions
where paytable_id = ${sqlString(paytableId)}
  and version = '1.0.0'
  and math_model_id = ${sqlString(mathModelId)}
  and math_model_version = '1.0.0'
  and content_hash = ${sqlString(paytableHash)}
  and jurisdiction_profile_references is null
  and certification_binding_state = 'None';
`) === 1,
  { paytableId, paytableHash },
);

const overlayMathModelId = `${mathModelId}:jurisdiction-overlay`;
const overlayPaytableId = `${paytableId}:jurisdiction-overlay`;
const overlayMathHash = `sha256:p0-005-4-math-overlay:${runId}`;
const overlayPaytableHash = `sha256:p0-005-4-paytable-overlay:${runId}`;

runSql(mathModelInsertSql({
  mathModelId: overlayMathModelId,
  contentHash: overlayMathHash,
  jurisdictionProfileReferences: ["regulator-profile:test"],
  rtpPolicyConstraints: { "regulator-profile:test": { minimumRtp: 0.8, maximumRtp: 0.98 } },
  certificationBindingState: "InternalVerified",
}));
addCheck(
  "optional jurisdiction profile can be included on math model",
  rowCount(`
select count(*)
from game_engine.math_model_definitions
where math_model_id = ${sqlString(overlayMathModelId)}
  and content_hash = ${sqlString(overlayMathHash)}
  and jurisdiction_profile_references = ${sqlJson(["regulator-profile:test"])}
  and rtp_policy_constraints = ${sqlJson({ "regulator-profile:test": { minimumRtp: 0.8, maximumRtp: 0.98 } })}
  and certification_binding_state = 'InternalVerified';
`) === 1,
  { overlayMathModelId, overlayMathHash },
);

runSql(paytableInsertSql({
  paytableId: overlayPaytableId,
  mathModelId: overlayMathModelId,
  contentHash: overlayPaytableHash,
  jurisdictionProfileReferences: ["regulator-profile:test"],
  certificationBindingState: "LabSubmitted",
}));
addCheck(
  "optional jurisdiction profile can be included on paytable",
  rowCount(`
select count(*)
from game_engine.paytable_definitions
where paytable_id = ${sqlString(overlayPaytableId)}
  and content_hash = ${sqlString(overlayPaytableHash)}
  and jurisdiction_profile_references = ${sqlJson(["regulator-profile:test"])}
  and certification_binding_state = 'LabSubmitted';
`) === 1,
  { overlayPaytableId, overlayPaytableHash },
);

const duplicateMathVersion = runSql(mathModelInsertSql({
  mathModelId,
  contentHash: `sha256:p0-005-4-math-duplicate-version:${runId}`,
}), { allowFailure: true });
addCheck("duplicate math model version blocked", duplicateMathVersion.status !== 0, {
  stderr: duplicateMathVersion.stderr.trim(),
});

const duplicatePaytableVersion = runSql(paytableInsertSql({
  paytableId,
  mathModelId,
  contentHash: `sha256:p0-005-4-paytable-duplicate-version:${runId}`,
}), { allowFailure: true });
addCheck("duplicate paytable version blocked", duplicatePaytableVersion.status !== 0, {
  stderr: duplicatePaytableVersion.stderr.trim(),
});

const duplicateMathHash = runSql(mathModelInsertSql({
  mathModelId: `${mathModelId}:duplicate-hash`,
  contentHash: mathHash,
}), { allowFailure: true });
addCheck("duplicate math model hash blocked", duplicateMathHash.status !== 0, {
  stderr: duplicateMathHash.stderr.trim(),
});

const duplicatePaytableHash = runSql(paytableInsertSql({
  paytableId: `${paytableId}:duplicate-hash`,
  mathModelId,
  contentHash: paytableHash,
}), { allowFailure: true });
addCheck("duplicate paytable hash blocked", duplicatePaytableHash.status !== 0, {
  stderr: duplicatePaytableHash.stderr.trim(),
});

const invalidRtp = runSql(mathModelInsertSql({
  mathModelId: `${mathModelId}:invalid-rtp`,
  expectedRtp: 1.5,
  contentHash: `sha256:p0-005-4-invalid-rtp:${runId}`,
}), { allowFailure: true });
addCheck("invalid RTP rejected", invalidRtp.status !== 0, {
  stderr: invalidRtp.stderr.trim(),
});

const invalidRtpWithoutJurisdiction = runSql(mathModelInsertSql({
  mathModelId: `${mathModelId}:invalid-rtp-no-jurisdiction`,
  expectedRtp: 0,
  contentHash: `sha256:p0-005-4-invalid-rtp-no-jurisdiction:${runId}`,
  jurisdictionProfileReferences: null,
}), { allowFailure: true });
addCheck("invalid RTP rejected independently of jurisdiction", invalidRtpWithoutJurisdiction.status !== 0, {
  stderr: invalidRtpWithoutJurisdiction.stderr.trim(),
});

const forbiddenMathFields = runSql(mathModelInsertSql({
  mathModelId: `${mathModelId}:forbidden`,
  contentHash: `sha256:p0-005-4-forbidden-math:${runId}`,
  prizeLiabilityProfile: { entropy: "forbidden" },
}), { allowFailure: true });
addCheck("RNG fields rejected from math model", forbiddenMathFields.status !== 0, {
  stderr: forbiddenMathFields.stderr.trim(),
});

const forbiddenPaytableFields = runSql(paytableInsertSql({
  paytableId: `${paytableId}:forbidden`,
  mathModelId,
  contentHash: `sha256:p0-005-4-forbidden-paytable:${runId}`,
  prizeMatrixRows: [{
    rowId: "bad-row",
    wagerSchema: "straight-v1",
    prizeCode: "BAD",
    multiplier: 1,
    payoutValue: 0,
    conditions: { outcome: "forbidden" },
  }],
}), { allowFailure: true });
addCheck("outcome fields rejected from paytable", forbiddenPaytableFields.status !== 0, {
  stderr: forbiddenPaytableFields.stderr.trim(),
});

const invalidPrizeRow = runSql(paytableInsertSql({
  paytableId: `${paytableId}:invalid-prize`,
  mathModelId,
  contentHash: `sha256:p0-005-4-invalid-prize:${runId}`,
  prizeMatrixRows: [{
    rowId: "zero-row",
    wagerSchema: "straight-v1",
    prizeCode: "ZERO",
    multiplier: 0,
    payoutValue: 0,
    conditions: { matchCount: 0 },
  }],
}), { allowFailure: true });
addCheck("invalid payout row rejected", invalidPrizeRow.status !== 0, {
  stderr: invalidPrizeRow.stderr.trim(),
});

addCheck(
  "math model lookup by id version hash works",
  rowCount(`
select count(*)
from game_engine.math_model_definitions
where math_model_id = ${sqlString(mathModelId)}
  and version = '1.0.0'
  and content_hash = ${sqlString(mathHash)};
`) === 1,
  { mathModelId, mathHash },
);

addCheck(
  "paytable lookup by id version hash works",
  rowCount(`
select count(*)
from game_engine.paytable_definitions
where paytable_id = ${sqlString(paytableId)}
  and version = '1.0.0'
  and content_hash = ${sqlString(paytableHash)};
`) === 1,
  { paytableId, paytableHash },
);

const updateMath = runSql(
  `update game_engine.math_model_definitions set expected_rtp = 0.9 where math_model_id = ${sqlString(mathModelId)};`,
  { allowFailure: true },
);
addCheck("math model update blocked", updateMath.status !== 0, { stderr: updateMath.stderr.trim() });

const deletePaytable = runSql(
  `delete from game_engine.paytable_definitions where paytable_id = ${sqlString(paytableId)};`,
  { allowFailure: true },
);
addCheck("paytable delete blocked", deletePaytable.status !== 0, { stderr: deletePaytable.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
