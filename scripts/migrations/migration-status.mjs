import { classifyEntries, evaluateGuardrails, historyRows, loadManifest, printJson } from "./lib/local-migration-utils.mjs";

const manifest = loadManifest();
const classifications = classifyEntries(manifest);
const guardrails = evaluateGuardrails({ requireConfirmation: false });
let appliedMigrations = [];
let databaseReachable = false;
let databaseError = null;

if (guardrails.ok) {
  try {
    appliedMigrations = historyRows({ allowFailure: true });
    databaseReachable = true;
  } catch (error) {
    databaseError = error.message;
  }
}

printJson({
  status: guardrails.ok && databaseReachable ? "READY" : "NOT_READY",
  runner: manifest.runner,
  manifestVersion: manifest.version,
  guardrails,
  databaseReachable,
  databaseError,
  classifications: classifications.counts,
  manifestRules: manifest.rules ?? [],
  applyLocal: classifications.applyLocal.map((entry) => entry.path),
  excludedFromAutomaticApply: [
    ...classifications.draftOnly,
    ...classifications.superseded,
    ...classifications.manualReviewRequired,
    ...classifications.blocked,
  ].map((entry) => ({
    path: entry.path,
    classification: entry.classification,
    reason: entry.reason,
  })),
  knownConflicts: manifest.knownConflicts ?? [],
  appliedMigrations,
});
