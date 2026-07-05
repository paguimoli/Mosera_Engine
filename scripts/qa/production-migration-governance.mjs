import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const governanceScript = "scripts/migrations/production-governance.mjs";
const runbook = "docs/operations/production-migration-governance-runbook.md";
const productionComposeFile = "docker-compose.production.yml";
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function runGovernance(env, mode = "dry-run") {
  const result = spawnSync("node", [governanceScript, `--mode=${mode}`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...env,
    },
  });

  let report = null;
  try {
    report = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    report = null;
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
    report,
  };
}

const safeEnv = {
  DEPLOYMENT_ENVIRONMENT: "production",
  MIGRATIONS_DATABASE_URL:
    "postgresql://migration_user:StrongMigrationCredential987@postgres.managed.vendor.net:5432/lottery_prod?sslmode=require",
  DATABASE_SSL_MODE: "require",
  PRODUCTION_MIGRATION_BACKUP_CHECKPOINT: "pitr-20260704T220000Z-change-1234",
  PRODUCTION_MIGRATION_STAGING_REHEARSAL_EVIDENCE: "sha256:staging-rehearsal-evidence-1234567890abcdef",
  PRODUCTION_MIGRATION_APPROVAL_TOKEN: "change-ticket-1234-approved-by-dba",
  PRODUCTION_MIGRATION_APPROVED: "true",
  PRODUCTION_MIGRATION_DRIFT_CHECK: "completed",
  PRODUCTION_MIGRATION_DRIFT_RESULT: "no-drift",
  PRODUCTION_MIGRATION_EVIDENCE_DIR: ".qa/production-migration-governance",
  ALLOW_DISPOSABLE_DB_MIGRATIONS: "false",
};

assert(existsSync(governanceScript), "Production migration governance script is missing.", {
  governanceScript,
});
assert(existsSync(productionComposeFile), "Production compose file is missing.", {
  productionComposeFile,
});
assert(existsSync(runbook), "Production migration governance runbook is missing.", { runbook });

const withoutApproval = runGovernance({
  ...safeEnv,
  PRODUCTION_MIGRATION_APPROVED: "false",
  PRODUCTION_MIGRATION_APPROVAL_TOKEN: "",
});
assert(!withoutApproval.ok, "Production migration without approval must fail.", {
  result: withoutApproval,
});

const localDatabase = runGovernance({
  ...safeEnv,
  MIGRATIONS_DATABASE_URL:
    "postgresql://lottery:lottery_dev_password@localhost:55432/lottery_local?sslmode=require",
});
assert(!localDatabase.ok, "Production migration with local database URL must fail.", {
  result: localDatabase,
});

const missingBackup = runGovernance({
  ...safeEnv,
  PRODUCTION_MIGRATION_BACKUP_CHECKPOINT: "",
});
assert(!missingBackup.ok, "Production migration without backup/PITR checkpoint must fail.", {
  result: missingBackup,
});

const missingStaging = runGovernance({
  ...safeEnv,
  PRODUCTION_MIGRATION_STAGING_REHEARSAL_EVIDENCE: "",
});
assert(!missingStaging.ok, "Production migration without staging rehearsal evidence must fail.", {
  result: missingStaging,
});

const driftMissing = runGovernance({
  ...safeEnv,
  PRODUCTION_MIGRATION_DRIFT_CHECK: "required",
  PRODUCTION_MIGRATION_DRIFT_RESULT: "required",
});
assert(!driftMissing.ok, "Production migration without completed drift detection must fail.", {
  result: driftMissing,
});

const approvedDryRun = runGovernance(safeEnv);
assert(approvedDryRun.ok, "Synthetic fully approved dry-run must pass.", {
  result: approvedDryRun,
});
assert(approvedDryRun.report?.executionPolicy === "NO_APPLY_GOVERNANCE_ONLY", "Dry-run must not apply migrations.", {
  report: approvedDryRun.report,
});
assert(approvedDryRun.report?.evidencePath, "Dry-run must emit an evidence artifact path.", {
  report: approvedDryRun.report,
});
assert(existsSync(approvedDryRun.report.evidencePath), "Dry-run evidence artifact must be written.", {
  evidencePath: approvedDryRun.report.evidencePath,
});

const planResult = runGovernance(safeEnv, "plan");
assert(planResult.ok, "Production migration plan mode must pass with full evidence.", {
  result: planResult,
});

const composeText = readFileSync(productionComposeFile, "utf8");
assert(composeText.includes("migrations:production:dry-run"), "Production migration-runner must use governance dry-run.");
assert(composeText.includes("PRODUCTION_MIGRATION_BACKUP_CHECKPOINT"), "Production compose must require backup checkpoint evidence.");
assert(
  composeText.includes("PRODUCTION_MIGRATION_STAGING_REHEARSAL_EVIDENCE"),
  "Production compose must require staging rehearsal evidence.",
);
assert(composeText.includes("PRODUCTION_MIGRATION_APPROVAL_TOKEN"), "Production compose must require approval evidence.");
assert(composeText.includes("PRODUCTION_MIGRATION_DRIFT_CHECK"), "Production compose must require drift check evidence.");

assert(
  packageJson.scripts["migrations:local:run"] === "node scripts/migrations/run-local-migrations.mjs",
  "Local migration run command must remain unchanged.",
);
assert(
  packageJson.scripts["migrations:local:validate"] === "node scripts/migrations/validate-local-migrations.mjs",
  "Local migration validate command must remain unchanged.",
);

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    productionMigrationWithoutApprovalFails: "PASS",
    productionMigrationWithLocalDatabaseFails: "PASS",
    missingBackupCheckpointFails: "PASS",
    missingStagingRehearsalFails: "PASS",
    missingDriftDetectionFails: "PASS",
    syntheticFullyApprovedDryRunPasses: "PASS",
    evidenceArtifactOutput: "PASS",
    localMigrationCommandsUnchanged: "PASS",
  },
}, null, 2));
