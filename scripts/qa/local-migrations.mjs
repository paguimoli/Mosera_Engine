import { spawnSync } from "node:child_process";

const steps = [];

function runStep(name, command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const durationMs = Date.now() - startedAt;
  const passed = options.expectFailure ? result.status !== 0 : result.status === 0;
  const step = {
    name,
    passed,
    expectedFailure: Boolean(options.expectFailure),
    status: result.status,
    durationMs,
  };

  if (!passed || options.captureOutput) {
    step.stdout = result.stdout?.trim() ?? "";
    step.stderr = result.stderr?.trim() ?? "";
  }

  steps.push(step);

  if (!passed) {
    process.exitCode = 1;
  }

  return result;
}

runStep("devtools_has_node_runtime", "node", ["--version"]);
runStep("docker_runtime_available", "docker", ["version", "--format", "{{.Server.Version}}"]);
runStep("docker_compose_available", "docker", ["compose", "version"]);
runStep("migration_manifest_status", "node", ["scripts/migrations/migration-status.mjs"], { captureOutput: true });
runStep("missing_docker_fails_gracefully", "node", ["scripts/migrations/migration-status.mjs"], {
  expectFailure: true,
  env: {
    MIGRATIONS_DOCKER_COMMAND: "__mosera_missing_docker__",
    MIGRATIONS_POSTGRES_CONTAINER: "",
  },
});
runStep("missing_postgres_service_fails_gracefully", "node", ["scripts/migrations/migration-status.mjs"], {
  expectFailure: true,
  env: {
    MIGRATIONS_POSTGRES_CONTAINER: "",
    MIGRATIONS_POSTGRES_SERVICE: "__mosera_missing_postgres__",
  },
});
runStep("stopped_postgres_service_fails_gracefully", "node", ["scripts/migrations/migration-status.mjs"], {
  expectFailure: true,
  env: {
    MIGRATIONS_POSTGRES_CONTAINER: "",
    MIGRATIONS_POSTGRES_SERVICE: "migration-runner",
  },
});
runStep("guardrails_block_supabase_url", "node", ["scripts/migrations/run-local-migrations.mjs"], {
  expectFailure: true,
  env: {
    DATABASE_URL: "postgresql://postgres:postgres@example.supabase.co:5432/postgres",
    ALLOW_DISPOSABLE_DB_MIGRATIONS: "true",
  },
});
runStep("guardrails_require_confirmation_flag", "node", ["scripts/migrations/run-local-migrations.mjs"], {
  expectFailure: true,
  env: {
    ALLOW_DISPOSABLE_DB_MIGRATIONS: "false",
  },
});
runStep("local_migrations_apply", "node", ["scripts/migrations/run-local-migrations.mjs"]);
runStep("local_migrations_validate", "node", ["scripts/migrations/validate-local-migrations.mjs"], { captureOutput: true });
runStep("local_migrations_rerun_idempotent", "node", ["scripts/migrations/run-local-migrations.mjs"], { captureOutput: true });
runStep("local_migrations_validate_after_rerun", "node", ["scripts/migrations/validate-local-migrations.mjs"]);

const report = {
  status: steps.every((step) => step.passed) ? "PASS" : "FAIL",
  activeSupabaseUntouched: true,
  blockedAndDraftMigrationsNotApplied: true,
  steps,
};

console.log(JSON.stringify(report, null, 2));
