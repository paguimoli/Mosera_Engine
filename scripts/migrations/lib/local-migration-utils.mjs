import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const repoRoot = process.cwd();
export const manifestPath = path.join(repoRoot, "scripts/migrations/migration-manifest.json");
const runtimeCache = new Map();

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

function runCommand(command, args, { env, input } = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function requireSuccessfulCommand(result, unavailableMessage, failureMessage) {
  if (result.error?.code === "ENOENT") {
    throw new Error(unavailableMessage);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || failureMessage);
  }
  return result;
}

function resolveComposePostgresService(env, dockerCommand) {
  requireSuccessfulCommand(
    runCommand(dockerCommand, ["compose", "version"], { env }),
    "Docker Compose is unavailable. Install Docker Desktop or Docker Engine with the Compose plugin.",
    "Docker Compose is unavailable.",
  );

  const servicesResult = requireSuccessfulCommand(
    runCommand(dockerCommand, ["compose", "config", "--services"], { env }),
    "Docker Compose is unavailable.",
    "Unable to read Docker Compose services. Run this command from the repository root.",
  );
  const services = servicesResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const configuredService = env.MIGRATIONS_POSTGRES_SERVICE?.trim();
  let service;

  if (configuredService) {
    if (!services.includes(configuredService)) {
      throw new Error(
        `Configured PostgreSQL Compose service '${configuredService}' was not found. Available services: ${services.join(", ") || "none"}.`,
      );
    }
    service = configuredService;
  } else if (services.includes("local-postgres")) {
    service = "local-postgres";
  } else {
    const candidates = services.filter((name) => /(^|[-_])postgres(?:ql)?($|[-_])/.test(name));
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? "No PostgreSQL service was found in Docker Compose. Set MIGRATIONS_POSTGRES_SERVICE to the correct service name."
          : `Multiple PostgreSQL Compose services were found (${candidates.join(", ")}). Set MIGRATIONS_POSTGRES_SERVICE explicitly.`,
      );
    }
    [service] = candidates;
  }

  const runningResult = requireSuccessfulCommand(
    runCommand(dockerCommand, ["compose", "ps", "--status", "running", "--services"], { env }),
    "Docker Compose is unavailable.",
    "Unable to inspect Docker Compose service state.",
  );
  const runningServices = new Set(
    runningResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
  );
  if (!runningServices.has(service)) {
    throw new Error(
      `PostgreSQL Compose service '${service}' is not running. Start it with: docker compose up -d ${service}`,
    );
  }

  return { type: "compose", dockerCommand, service };
}

export function resolvePostgresRuntime({ env = process.env } = {}) {
  const dockerCommand = env.MIGRATIONS_DOCKER_COMMAND?.trim() || "docker";
  const mode = env.MIGRATIONS_DOCKER_EXECUTION_MODE?.trim().toLowerCase();
  const containerId = env.MIGRATIONS_POSTGRES_CONTAINER?.trim();
  const cacheKey = JSON.stringify({
    dockerCommand,
    mode,
    containerId,
    service: env.MIGRATIONS_POSTGRES_SERVICE ?? "",
  });
  if (runtimeCache.has(cacheKey)) {
    return runtimeCache.get(cacheKey);
  }

  if (mode === "container") {
    const runtime = { type: "container" };
    runtimeCache.set(cacheKey, runtime);
    return runtime;
  }

  requireSuccessfulCommand(
    runCommand(dockerCommand, ["version", "--format", "{{.Server.Version}}"], { env }),
    "Docker is unavailable. Install and start Docker Desktop or Docker Engine.",
    "Docker is unavailable or its daemon is not running. Start Docker and retry.",
  );

  let runtime;
  if (containerId) {
    const inspectResult = requireSuccessfulCommand(
      runCommand(dockerCommand, ["inspect", "--format", "{{.State.Running}}", containerId], { env }),
      "Docker is unavailable.",
      "The configured CI PostgreSQL service container could not be inspected.",
    );
    if (inspectResult.stdout.trim() !== "true") {
      throw new Error("The configured CI PostgreSQL service container is not running.");
    }
    runtime = { type: "docker-container", dockerCommand, containerId };
  } else {
    runtime = resolveComposePostgresService(env, dockerCommand);
  }

  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

function databaseUrlForRuntime(databaseUrl, runtime) {
  if (runtime.type === "container") {
    return databaseUrl;
  }

  const parsed = new URL(databaseUrl);
  parsed.hostname = "127.0.0.1";
  parsed.port = "5432";
  return parsed.toString();
}

function normalizePsqlInput(args, input) {
  const normalizedArgs = [];
  let normalizedInput = input;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-f") {
      normalizedArgs.push(args[index]);
      continue;
    }

    const filePath = args[index + 1];
    if (!filePath) {
      throw new Error("psql -f requires a migration file path.");
    }
    if (normalizedInput !== undefined) {
      throw new Error("Cannot combine explicit SQL input with psql -f.");
    }
    normalizedInput = readFileSync(filePath, "utf8");
    index += 1;
  }

  return { args: normalizedArgs, input: normalizedInput };
}

export function createPsqlInvocation(args, { env = process.env } = {}) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const runtime = resolvePostgresRuntime({ env });
  const psqlArgs = [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    ...args,
    databaseUrlForRuntime(env.DATABASE_URL, runtime),
  ];

  if (runtime.type === "container") {
    return { command: "psql", args: psqlArgs, runtime };
  }
  if (runtime.type === "docker-container") {
    return {
      command: runtime.dockerCommand,
      args: ["exec", "-i", runtime.containerId, "psql", ...psqlArgs],
      runtime,
    };
  }
  return {
    command: runtime.dockerCommand,
    args: ["compose", "exec", "-T", runtime.service, "psql", ...psqlArgs],
    runtime,
  };
}

export function runPsql(args, { input, env = process.env, allowFailure = false } = {}) {
  const normalized = normalizePsqlInput(args, input);
  const invocation = createPsqlInvocation(normalized.args, { env });
  const result = runCommand(invocation.command, invocation.args, { env, input: normalized.input });

  if (result.error) {
    if (result.error.code === "ENOENT" && invocation.runtime.type === "container") {
      throw new Error("The migration runner container does not include the PostgreSQL client.");
    }
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
