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

function strategyInsertSql({
  id = randomUUID(),
  strategyId,
  strategyVersion = "1.0.0",
  primitiveGraph,
  contentHash,
  inputSchema = { drawId: "uuid" },
  outputSchema = { resultType: "number-set" },
  constraints = { maxAttempts: 1 },
}) {
  return `
insert into game_engine.outcome_strategy_definitions (
  id,
  strategy_id,
  strategy_version,
  primitive_graph,
  input_schema,
  output_schema,
  constraints,
  jurisdiction_profile_references,
  lifecycle_state,
  content_hash,
  certification_binding_placeholder,
  signature_metadata
) values (
  '${id}',
  ${sqlString(strategyId)},
  ${sqlString(strategyVersion)},
  ${sqlJson(primitiveGraph)},
  ${sqlJson(inputSchema)},
  ${sqlJson(outputSchema)},
  ${sqlJson(constraints)},
  ${sqlJson(["regulator-profile:test"])},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'outcome-strategy-cert-placeholder',
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

const runId = randomUUID();
const strategyId = `outcome-strategy:p0-005-3:${runId}`;
const validHash = `sha256:p0-005-3-valid:${runId}`;

const validPrimitiveGraph = [
  {
    nodeId: "draw-numbers",
    primitiveType: "UniqueNumberSet",
    dependsOn: [],
    minNumber: 1,
    maxNumber: 80,
    count: 20,
    numbers: [1, 2, 3, 4, 5],
  },
  {
    nodeId: "bonus-symbol",
    primitiveType: "WeightedSelection",
    dependsOn: ["draw-numbers"],
    weightedOptions: [
      { symbol: "RED", weight: 1 },
      { symbol: "BLUE", weight: 2 },
    ],
  },
  {
    nodeId: "composite",
    primitiveType: "CompositeOutcomeGraph",
    dependsOn: ["draw-numbers", "bonus-symbol"],
  },
];

addCheck("outcome strategy definition table exists", existsRegclass("game_engine.outcome_strategy_definitions"));

runSql(strategyInsertSql({
  id: randomUUID(),
  strategyId,
  primitiveGraph: validPrimitiveGraph,
  contentHash: validHash,
}));

addCheck(
  "valid strategy persists",
  rowCount(`
select count(*)
from game_engine.outcome_strategy_definitions
where strategy_id = ${sqlString(strategyId)}
  and strategy_version = '1.0.0'
  and content_hash = ${sqlString(validHash)};
`) === 1,
  { strategyId, contentHash: validHash },
);

const invalidPrimitiveResult = runSql(strategyInsertSql({
  strategyId: `${strategyId}:invalid-range`,
  primitiveGraph: [{
    nodeId: "bad-range",
    primitiveType: "UniqueNumberSet",
    dependsOn: [],
    minNumber: 1,
    maxNumber: 5,
    count: 10,
  }],
  contentHash: `sha256:p0-005-3-invalid-range:${runId}`,
}), { allowFailure: true });
addCheck("invalid primitive range/count rejected", invalidPrimitiveResult.status !== 0, {
  stderr: invalidPrimitiveResult.stderr.trim(),
});

const duplicateSymbolResult = runSql(strategyInsertSql({
  strategyId: `${strategyId}:duplicate-symbol`,
  primitiveGraph: [{
    nodeId: "bad-symbols",
    primitiveType: "UniqueSymbolSet",
    dependsOn: [],
    count: 2,
    symbols: ["A", "A"],
  }],
  contentHash: `sha256:p0-005-3-duplicate-symbol:${runId}`,
}), { allowFailure: true });
addCheck("duplicate symbols rejected where uniqueness required", duplicateSymbolResult.status !== 0, {
  stderr: duplicateSymbolResult.stderr.trim(),
});

const invalidWeightResult = runSql(strategyInsertSql({
  strategyId: `${strategyId}:invalid-weight`,
  primitiveGraph: [{
    nodeId: "bad-weights",
    primitiveType: "WeightedSelection",
    dependsOn: [],
    weightedOptions: [
      { symbol: "A", weight: 1 },
      { symbol: "B", weight: 0 },
    ],
  }],
  contentHash: `sha256:p0-005-3-invalid-weight:${runId}`,
}), { allowFailure: true });
addCheck("weighted selections require positive weights", invalidWeightResult.status !== 0, {
  stderr: invalidWeightResult.stderr.trim(),
});

const cycleResult = runSql(strategyInsertSql({
  strategyId: `${strategyId}:cycle`,
  primitiveGraph: [
    {
      nodeId: "a",
      primitiveType: "CompositeOutcomeGraph",
      dependsOn: ["b"],
    },
    {
      nodeId: "b",
      primitiveType: "CompositeOutcomeGraph",
      dependsOn: ["a"],
    },
  ],
  contentHash: `sha256:p0-005-3-cycle:${runId}`,
}), { allowFailure: true });
addCheck("composite graph cycle rejected", cycleResult.status !== 0, {
  stderr: cycleResult.stderr.trim(),
});

const forbiddenFieldsResult = runSql(strategyInsertSql({
  strategyId: `${strategyId}:forbidden`,
  primitiveGraph: validPrimitiveGraph,
  inputSchema: { rtp: "forbidden" },
  outputSchema: { paytable: "forbidden" },
  constraints: { payout: "forbidden" },
  contentHash: `sha256:p0-005-3-forbidden:${runId}`,
}), { allowFailure: true });
addCheck("math/paytable/RTP fields rejected", forbiddenFieldsResult.status !== 0, {
  stderr: forbiddenFieldsResult.stderr.trim(),
});

const duplicateVersionResult = runSql(strategyInsertSql({
  strategyId,
  strategyVersion: "1.0.0",
  primitiveGraph: validPrimitiveGraph,
  contentHash: `sha256:p0-005-3-duplicate-version:${runId}`,
}), { allowFailure: true });
addCheck("duplicate strategy version blocked", duplicateVersionResult.status !== 0, {
  stderr: duplicateVersionResult.stderr.trim(),
});

const duplicateHashResult = runSql(strategyInsertSql({
  strategyId: `${strategyId}:duplicate-hash`,
  primitiveGraph: validPrimitiveGraph,
  contentHash: validHash,
}), { allowFailure: true });
addCheck("duplicate strategy content hash blocked", duplicateHashResult.status !== 0, {
  stderr: duplicateHashResult.stderr.trim(),
});

addCheck(
  "lookup by strategy version hash works",
  rowCount(`
select count(*)
from game_engine.outcome_strategy_definitions
where strategy_id = ${sqlString(strategyId)}
  and strategy_version = '1.0.0'
  and content_hash = ${sqlString(validHash)};
`) === 1,
  { strategyId, contentHash: validHash },
);

const updateResult = runSql(
  `update game_engine.outcome_strategy_definitions set lifecycle_state = 'Suspended' where strategy_id = ${sqlString(strategyId)};`,
  { allowFailure: true },
);
addCheck("outcome strategy update blocked", updateResult.status !== 0, {
  stderr: updateResult.stderr.trim(),
});

const deleteResult = runSql(
  `delete from game_engine.outcome_strategy_definitions where strategy_id = ${sqlString(strategyId)};`,
  { allowFailure: true },
);
addCheck("outcome strategy delete blocked", deleteResult.status !== 0, {
  stderr: deleteResult.stderr.trim(),
});

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
