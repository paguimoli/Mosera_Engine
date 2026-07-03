import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const runningInContainer = existsSync("/.dockerenv");
const gameEngineUrl =
  process.env.QA_GAME_ENGINE_URL ||
  process.env.GAME_ENGINE_URL ||
  (runningInContainer ? "http://game-engine:8080" : "http://localhost:5500");
const databaseUrl =
  process.env.DATABASE_URL ||
  (runningInContainer
    ? "postgresql://lottery:lottery_dev_password@local-postgres:5432/lottery_local"
    : "postgresql://lottery:lottery_dev_password@localhost:55432/lottery_local");

const checks = [];

function record(name, status, metadata = {}) {
  checks.push({ name, status, ...metadata });
}

function fail(message, metadata = {}) {
  record(message, "FAIL", metadata);
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        message,
        gameEngineUrl,
        checks,
      },
      null,
      2
    )
  );
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

async function requestJson(path) {
  const url = `${gameEngineUrl.replace(/\/$/, "")}${path}`;
  const response = await fetch(url);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  assert(response.ok, `${path} returned a non-success status.`, {
    httpStatus: response.status,
    body,
  });

  return body;
}

function psql(sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-v", "ON_ERROR_STOP=1", "-qAt", databaseUrl, "-c", sql],
    {
      encoding: "utf8",
      env: process.env,
    }
  );

  assert(result.status === 0, "Postgres verification query failed.", {
    sql,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  });

  return result.stdout.trim();
}

function tableCount(tableName) {
  const output = psql(`select count(*) from ${tableName};`);
  return Number.parseInt(output, 10);
}

function tableExists(tableName) {
  return psql(`select to_regclass('${tableName}') is not null;`) === "t";
}

function assertCountAtLeast(tableName, minimum) {
  const count = tableCount(tableName);
  assert(count >= minimum, `${tableName} must contain durable runtime rows.`, {
    tableName,
    count,
    minimum,
  });
  record(`${tableName} row count`, "PASS", { count, minimum });
  return count;
}

function assertTableExists(tableName) {
  const exists = tableExists(tableName);
  assert(exists, `${tableName} must exist.`, { tableName });
  record(`${tableName} exists`, "PASS");
}

const storageStatus = await requestJson("/api/game-engine/evaluation-storage-status");
assert(storageStatus.success === true, "Evaluation storage status must succeed.", { storageStatus });
assert(
  storageStatus.evaluationStorageStatus?.durableRepositoryWiringEnabled === true,
  "Evaluation storage must report durable repository wiring.",
  { storageStatus: storageStatus.evaluationStorageStatus }
);
record("evaluation storage status", "PASS", {
  durableRepositoryWiringEnabled: storageStatus.evaluationStorageStatus.durableRepositoryWiringEnabled,
});

const modulesResult = await requestJson("/api/game-engine/modules");
const modules = modulesResult.modules ?? [];
assert(Array.isArray(modules) && modules.length > 0, "Game module registry must expose modules.", {
  modules,
});
record("registry modules HTTP", "PASS", { count: modules.length });

const gameBindingsResult = await requestJson("/api/game-engine/game-bindings");
const gameBindings = gameBindingsResult.gameBindings ?? [];
assert(Array.isArray(gameBindings) && gameBindings.length > 0, "Game bindings must be visible.", {
  gameBindings,
});
record("registry game bindings HTTP", "PASS", { count: gameBindings.length });

const authoritiesResult = await requestJson("/api/game-engine/draw-authorities");
const authorities = authoritiesResult.drawAuthorities ?? [];
assert(Array.isArray(authorities) && authorities.length > 0, "Draw authorities must be visible.", {
  authorities,
});
record("draw authorities HTTP", "PASS", { count: authorities.length });

const schedulesResult = await requestJson("/api/game-engine/draw-schedules");
const schedules = schedulesResult.drawSchedules ?? [];
assert(Array.isArray(schedules) && schedules.length > 0, "Draw schedules must be visible.", {
  schedules,
});
record("draw schedules HTTP", "PASS", { count: schedules.length });

const lifecycleResult = await requestJson("/api/game-engine/draw-lifecycle");
const lifecycleRows = lifecycleResult.drawLifecycle ?? [];
assert(Array.isArray(lifecycleRows) && lifecycleRows.length > 0, "Draw lifecycle diagnostics must be visible.", {
  lifecycleRows,
});
record("draw lifecycle HTTP", "PASS", { count: lifecycleRows.length });

const runsResult = await requestJson("/api/game-engine/evaluation-runs");
const evaluationRuns = runsResult.evaluationRuns ?? [];
assert(Array.isArray(evaluationRuns) && evaluationRuns.length > 0, "Evaluation runs must be visible.", {
  evaluationRuns,
});
record("evaluation runs HTTP", "PASS", { count: evaluationRuns.length });

const seedRunId = evaluationRuns[0].id;
const batchesResult = await requestJson(`/api/game-engine/evaluation-runs/${seedRunId}/batches`);
const evaluationBatches = batchesResult.evaluationBatches ?? [];
assert(Array.isArray(evaluationBatches) && evaluationBatches.length > 0, "Evaluation batches must be visible.", {
  evaluationBatches,
});
record("evaluation batches HTTP", "PASS", { count: evaluationBatches.length });

const progressResult = await requestJson(`/api/game-engine/evaluation-progress/${seedRunId}`);
assert(progressResult.success === true, "Evaluation progress must be visible.", { progressResult });
record("evaluation progress HTTP", "PASS", {
  checkpointCount: Array.isArray(progressResult.checkpoints) ? progressResult.checkpoints.length : 0,
});

const recordsResult = await requestJson("/api/game-engine/evaluation-records");
const evaluationRecords = recordsResult.evaluationRecords ?? [];
assert(Array.isArray(evaluationRecords), "Evaluation records endpoint must return an array.", {
  recordsResult,
});
record("evaluation records HTTP", "PASS", { count: evaluationRecords.length });

const checkpointsResult = await requestJson("/api/game-engine/evaluation-checkpoints");
const evaluationCheckpoints = checkpointsResult.evaluationCheckpoints ?? [];
assert(Array.isArray(evaluationCheckpoints), "Evaluation checkpoints endpoint must return an array.", {
  checkpointsResult,
});
record("evaluation checkpoints HTTP", "PASS", { count: evaluationCheckpoints.length });

const durableCounts = {
  gameModules: assertCountAtLeast("game_engine.game_modules", 1),
  gameModuleVersions: assertCountAtLeast("game_engine.game_module_versions", 1),
  gameDefinitions: assertCountAtLeast("game_engine.game_definitions", 1),
  gameDefinitionVersions: assertCountAtLeast("game_engine.game_definition_versions", 1),
  drawAuthorities: assertCountAtLeast("game_engine.draw_authorities", 1),
  drawAuthorityVersions: assertCountAtLeast("game_engine.draw_authority_versions", 1),
  drawAuthorityAssignments: assertCountAtLeast("game_engine.draw_authority_assignments", 1),
  drawSchedules: assertCountAtLeast("game_engine.draw_schedules", 1),
  evaluationRuns: assertCountAtLeast("game_engine.evaluation_runs", 1),
  evaluationBatches: assertCountAtLeast("game_engine.evaluation_batches", 1),
};

assertTableExists("game_engine.evaluation_records");
assertTableExists("game_engine.evaluation_checkpoints");

const evaluationRecordCount = tableCount("game_engine.evaluation_records");
const evaluationCheckpointCount = tableCount("game_engine.evaluation_checkpoints");
record("evaluation records durable table", "PASS", { count: evaluationRecordCount });
record("evaluation checkpoints durable table", "PASS", { count: evaluationCheckpointCount });

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Game Engine durable runtime smoke checks passed.",
      gameEngineUrl,
      coverage: {
        evaluationRecordsAndCheckpoints: {
          httpRecords: evaluationRecords.length,
          httpCheckpoints: evaluationCheckpoints.length,
          durableRecordRows: evaluationRecordCount,
          durableCheckpointRows: evaluationCheckpointCount,
        },
        evaluationRunsAndBatches: {
          httpRuns: evaluationRuns.length,
          httpBatchesForSeedRun: evaluationBatches.length,
          durableRunRows: durableCounts.evaluationRuns,
          durableBatchRows: durableCounts.evaluationBatches,
        },
        registryCatalog: {
          httpModules: modules.length,
          httpGameBindings: gameBindings.length,
          durableModuleRows: durableCounts.gameModules,
          durableModuleVersionRows: durableCounts.gameModuleVersions,
          durableGameDefinitionRows: durableCounts.gameDefinitions,
          durableGameDefinitionVersionRows: durableCounts.gameDefinitionVersions,
        },
        drawAuthorities: {
          httpAuthorities: authorities.length,
          durableAuthorityRows: durableCounts.drawAuthorities,
          durableAuthorityVersionRows: durableCounts.drawAuthorityVersions,
          durableAuthorityAssignmentRows: durableCounts.drawAuthorityAssignments,
        },
        drawSchedulesAndLifecycle: {
          httpSchedules: schedules.length,
          httpLifecycleRows: lifecycleRows.length,
          durableScheduleRows: durableCounts.drawSchedules,
          lifecyclePersistenceNote:
            "Current schema exposes lifecycle through draw schedule rows and lifecycle HTTP diagnostics; no separate draw_lifecycle table exists.",
        },
      },
      checks,
    },
    null,
    2
  )
);
