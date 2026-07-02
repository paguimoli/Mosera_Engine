import { performance } from "node:perf_hooks";
import { checksumFile, classifyEntries, ensureMigrationHistory, historyRows, loadManifest, printJson, requireGuardrails, runPsql } from "./lib/local-migration-utils.mjs";

const resetRequested = process.argv.includes("--reset");
const manifest = loadManifest();
const classifications = classifyEntries(manifest);
const guardrails = requireGuardrails({ requireConfirmation: true });

if (resetRequested) {
  runPsql([
    "-q",
    "-c",
    "drop schema if exists game_engine cascade; drop schema if exists auth_service cascade; drop schema if exists platform_migrations cascade;",
  ]);
}

ensureMigrationHistory();

const beforeHistory = historyRows();
const appliedById = new Map(beforeHistory.map((row) => [row.migration_id, row]));
const results = [];

for (const entry of classifications.applyLocal) {
  if (!entry.exists) {
    throw new Error(`Migration file is missing: ${entry.path}`);
  }

  const checksum = checksumFile(entry.absolutePath);
  const existing = appliedById.get(entry.id);

  if (existing?.status === "APPLIED") {
    if (existing.checksum !== checksum) {
      throw new Error(`Checksum mismatch for already applied migration ${entry.id}.`);
    }
    results.push({
      id: entry.id,
      filename: entry.path,
      status: "SKIPPED_ALREADY_APPLIED",
      checksum,
      durationMs: 0,
    });
    continue;
  }

  const start = performance.now();
  try {
    runPsql(["-q", "-f", entry.absolutePath]);
    const durationMs = Math.round(performance.now() - start);
    runPsql([
      "-q",
      "-c",
      `
insert into platform_migrations.migration_history (migration_id, filename, checksum, status, duration_ms)
values ('${entry.id}', '${entry.path}', '${checksum}', 'APPLIED', ${durationMs})
on conflict (migration_id) do update
set filename = excluded.filename,
    checksum = excluded.checksum,
    applied_at = now(),
    status = excluded.status,
    duration_ms = excluded.duration_ms,
    error_message = null;
`,
    ]);
    results.push({
      id: entry.id,
      filename: entry.path,
      status: "APPLIED",
      checksum,
      durationMs,
    });
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const errorMessage = String(error.message ?? error).replaceAll("'", "''").slice(0, 4000);
    runPsql([
      "-q",
      "-c",
      `
insert into platform_migrations.migration_history (migration_id, filename, checksum, status, duration_ms, error_message)
values ('${entry.id}', '${entry.path}', '${checksum}', 'FAILED', ${durationMs}, '${errorMessage}')
on conflict (migration_id) do update
set filename = excluded.filename,
    checksum = excluded.checksum,
    applied_at = now(),
    status = excluded.status,
    duration_ms = excluded.duration_ms,
    error_message = excluded.error_message;
`,
    ]);
    throw error;
  }
}

const afterHistory = historyRows();

printJson({
  status: "OK",
  reset: resetRequested,
  guardrails,
  appliedCount: results.filter((result) => result.status === "APPLIED").length,
  skippedCount: results.filter((result) => result.status === "SKIPPED_ALREADY_APPLIED").length,
  excludedCount: manifest.entries.length - classifications.applyLocal.length,
  results,
  history: afterHistory,
});
