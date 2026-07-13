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

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

const runId = randomUUID();
const scope = `rollback-watermark:${runId}`;
const bootId = randomUUID();
const firstHash = hash(`chain:first:${runId}`);
const secondHash = hash(`chain:second:${runId}`);

addCheck("rollback watermark table exists", existsRegclass("game_engine.outcome_runtime_rollback_watermarks"));

runSql(`
insert into game_engine.outcome_runtime_rollback_watermarks (
  watermark_id, watermark_scope, sequence_number, previous_chain_hash, chain_root_hash,
  boot_id, runtime_request_id, evidence_hashes, observed_at
) values (
  '${randomUUID()}', ${sqlString(scope)}, 1, null, ${sqlString(firstHash)},
  '${bootId}', null, array[${sqlString(hash(`evidence:first:${runId}`))}], now()
);
`);

runSql(`
insert into game_engine.outcome_runtime_rollback_watermarks (
  watermark_id, watermark_scope, sequence_number, previous_chain_hash, chain_root_hash,
  boot_id, runtime_request_id, evidence_hashes, observed_at
) values (
  '${randomUUID()}', ${sqlString(scope)}, 2, ${sqlString(firstHash)}, ${sqlString(secondHash)},
  '${bootId}', null, array[${sqlString(hash(`evidence:second:${runId}`))}], now()
);
`);

addCheck("monotonic watermark chain persists", queryScalar(`
select count(*) = 2
from game_engine.outcome_runtime_rollback_watermarks
where watermark_scope = ${sqlString(scope)};
`) === "t");

const regression = runSql(`
insert into game_engine.outcome_runtime_rollback_watermarks (
  watermark_id, watermark_scope, sequence_number, previous_chain_hash, chain_root_hash,
  boot_id, runtime_request_id, evidence_hashes, observed_at
) values (
  '${randomUUID()}', ${sqlString(scope)}, 1, ${sqlString(secondHash)}, ${sqlString(hash(`regression:${runId}`))},
  '${bootId}', null, array[${sqlString(hash(`evidence:regression:${runId}`))}], now()
);
`, { allowFailure: true });
addCheck("sequence regression rejected", regression.status !== 0, { stderr: regression.stderr.trim() });

const chainMismatch = runSql(`
insert into game_engine.outcome_runtime_rollback_watermarks (
  watermark_id, watermark_scope, sequence_number, previous_chain_hash, chain_root_hash,
  boot_id, runtime_request_id, evidence_hashes, observed_at
) values (
  '${randomUUID()}', ${sqlString(scope)}, 3, ${sqlString(hash(`wrong-previous:${runId}`))}, ${sqlString(hash(`chain:mismatch:${runId}`))},
  '${bootId}', null, array[${sqlString(hash(`evidence:mismatch:${runId}`))}], now()
);
`, { allowFailure: true });
addCheck("chain mismatch rejected", chainMismatch.status !== 0, { stderr: chainMismatch.stderr.trim() });

const update = runSql(
  `update game_engine.outcome_runtime_rollback_watermarks set sequence_number = 99 where watermark_scope = ${sqlString(scope)};`,
  { allowFailure: true },
);
addCheck("watermark append-only update blocked", update.status !== 0, { stderr: update.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });
if (failed.length > 0) {
  process.exitCode = 1;
}
