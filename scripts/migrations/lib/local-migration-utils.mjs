import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const repoRoot = process.cwd();
export const manifestPath = path.join(repoRoot, "scripts/migrations/migration-manifest.json");

export function loadManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = manifest.entries ?? [];
  return {
    ...manifest,
    entries: entries.map((entry) => ({
      ...entry,
      absolutePath: path.join(repoRoot, entry.path),
      exists: existsSync(path.join(repoRoot, entry.path)),
    })),
  };
}

export function checksumFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function classifyEntries(manifest) {
  const counts = {};
  for (const entry of manifest.entries) {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }

  return {
    counts,
    applyLocal: manifest.entries.filter((entry) => entry.classification === "apply_local"),
    blocked: manifest.entries.filter((entry) => entry.classification === "blocked"),
    draftOnly: manifest.entries.filter((entry) => entry.classification === "draft_only"),
    manualReviewRequired: manifest.entries.filter((entry) => entry.classification === "manual_review_required"),
    superseded: manifest.entries.filter((entry) => entry.classification === "superseded"),
  };
}

export function evaluateGuardrails({ requireConfirmation = true, env = process.env } = {}) {
  const errors = [];
  const warnings = [];
  const databaseUrl = env.DATABASE_URL;
  const environment = env.ENVIRONMENT ?? env.ASPNETCORE_ENVIRONMENT ?? "";
  const nodeEnv = env.NODE_ENV ?? "";
  const manifest = loadManifest();
  let parsedUrl = null;
  let databaseName = null;

  if (!databaseUrl) {
    errors.push("DATABASE_URL is required.");
  } else {
    try {
      parsedUrl = new URL(databaseUrl);
      databaseName = parsedUrl.pathname.replace(/^\/+/, "");
      if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
        errors.push("DATABASE_URL must use postgres/postgresql protocol.");
      }
      if (databaseUrl.toLowerCase().includes("supabase.co")) {
        errors.push("DATABASE_URL points at supabase.co and is forbidden.");
      }
      if (!manifest.disposableDatabaseAllowlist.includes(databaseName)) {
        errors.push(`Database '${databaseName}' is not in the disposable allowlist.`);
      }
    } catch (error) {
      errors.push(`DATABASE_URL is invalid: ${error.message}`);
    }
  }

  for (const [name, value] of [
    ["NODE_ENV", nodeEnv],
    ["ENVIRONMENT", environment],
  ]) {
    const normalized = String(value).toLowerCase();
    if (normalized === "production" || normalized === "prod") {
      errors.push(`${name}=production is forbidden for local migrations.`);
    }
    if (normalized === "staging" || normalized === "stage") {
      errors.push(`${name}=staging is forbidden for local migrations.`);
    }
  }

  if (requireConfirmation && env.ALLOW_DISPOSABLE_DB_MIGRATIONS !== "true") {
    errors.push("ALLOW_DISPOSABLE_DB_MIGRATIONS=true is required.");
  }

  if (parsedUrl && parsedUrl.hostname !== "local-postgres" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
    warnings.push(`Database host '${parsedUrl.hostname}' is not the canonical local-postgres host.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    databaseName,
    host: parsedUrl?.hostname ?? null,
    allowlist: manifest.disposableDatabaseAllowlist,
    confirmationRequired: requireConfirmation,
  };
}

export function requireGuardrails(options) {
  const guardrails = evaluateGuardrails(options);
  if (!guardrails.ok) {
    const error = new Error(`Disposable database guardrails failed: ${guardrails.errors.join(" ")}`);
    error.guardrails = guardrails;
    throw error;
  }

  return guardrails;
}

export function runPsql(args, { input, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", ...args, env.DATABASE_URL], {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (!allowFailure && result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `psql exited with ${result.status}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }

  return result;
}

export function queryScalar(sql, options = {}) {
  const result = runPsql(["-qAt", "-c", sql], options);
  return result.stdout.trim();
}

export function queryJson(sql, fallback, options = {}) {
  const output = queryScalar(sql, options);
  if (!output) return fallback;
  return JSON.parse(output);
}

export function ensureMigrationHistory() {
  runPsql([
    "-q",
    "-c",
    `
create schema if not exists platform_migrations;

create table if not exists platform_migrations.migration_history (
  migration_id text primary key,
  filename text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  status text not null,
  duration_ms integer not null,
  error_message text,
  check (status in ('APPLIED', 'FAILED'))
);
`,
  ]);
}

export function historyRows(options = {}) {
  return queryJson(
    `
select coalesce(json_agg(row_to_json(history) order by migration_id), '[]'::json)
from (
  select migration_id, filename, checksum, applied_at, status, duration_ms, error_message
  from platform_migrations.migration_history
) history;
`,
    [],
    options,
  );
}

export function printJson(report) {
  console.log(JSON.stringify(report, null, 2));
}
