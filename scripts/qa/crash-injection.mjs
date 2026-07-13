import { readFileSync } from "node:fs";
import { printJson, queryScalar } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function scalar(sql) {
  return queryScalar(sql);
}

function existsCheck(schema, table, triggerName) {
  return scalar(`
select exists (
  select 1
  from pg_trigger tg
  join pg_class t on t.oid = tg.tgrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = '${schema}'
    and t.relname = '${table}'
    and tg.tgname = '${triggerName}'
    and not tg.tgisinternal
);
`) === "t";
}

const modelSource = readFileSync("services/game-engine/src/GameEngine.Domain/Model/OutcomeProviderRuntimeModels.cs", "utf8");
const serviceSource = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeRuntimeRecoveryServices.cs", "utf8");
const orchestrationSource = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeProviderRuntimeServices.cs", "utf8");

const requiredStages = [
  "Startup",
  "ProviderValidation",
  "EntropyAcquisition",
  "DrbgInstantiation",
  "ProviderExecution",
  "OutcomeDsl",
  "Canonicalization",
  "CertificateCreation",
  "CertificatePersistence",
  "ReceiptGeneration",
  "ReceiptPersistence",
  "ProviderEvidencePersistence",
  "LockAcquisition",
  "LockRelease",
  "Completion",
  "Recovery",
];

for (const stage of requiredStages) {
  addCheck(`crash injection stage declared: ${stage}`, modelSource.includes(stage));
}

addCheck("environment crash injector implemented", serviceSource.includes("OUTCOME_RUNTIME_CRASH_INJECTION_STAGE"));
addCheck("startup crash injection wired", serviceSource.includes("OutcomeRuntimeCrashInjectionStage.Startup"));
addCheck("provider validation crash injection wired", orchestrationSource.includes("OutcomeRuntimeCrashInjectionStage.ProviderValidation"));
addCheck("provider execution crash injection wired", orchestrationSource.includes("OutcomeRuntimeCrashInjectionStage.ProviderExecution"));
addCheck("lock acquisition crash injection wired", orchestrationSource.includes("OutcomeRuntimeCrashInjectionStage.LockAcquisition"));
addCheck("lock release crash injection wired", orchestrationSource.includes("OutcomeRuntimeCrashInjectionStage.LockRelease"));
addCheck("completion crash injection wired", orchestrationSource.includes("OutcomeRuntimeCrashInjectionStage.Completion"));
addCheck("recovery evidence append-only trigger configured", existsCheck("game_engine", "outcome_runtime_recovery_evidence", "trg_prevent_outcome_runtime_recovery_update"));

const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
printJson({ status, checks });
if (status !== "PASS") {
  process.exit(1);
}
