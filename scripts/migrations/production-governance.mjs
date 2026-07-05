import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checksumFile, classifyEntries, loadManifest, printJson, repoRoot } from "./lib/local-migration-utils.mjs";

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=", 2)[1] ?? "dry-run";
const allowedModes = new Set(["plan", "dry-run", "drift-check"]);
const evidenceDir = process.env.PRODUCTION_MIGRATION_EVIDENCE_DIR || ".qa/production-migration-governance";
const generatedAt = new Date().toISOString();

function unsafe(value) {
  return /(__PRODUCTION_REQUIRED_|production-required|placeholder|replace-with|changeme|dummy|sample|example|your-|lottery_dev_password)/i.test(
    String(value ?? ""),
  );
}

function validateProductionDatabaseUrl(value) {
  const errors = [];
  let parsed = null;

  if (!value) {
    return { ok: false, errors: ["MIGRATIONS_DATABASE_URL is required."], parsed: null };
  }

  try {
    parsed = new URL(value);
  } catch (error) {
    return { ok: false, errors: [`MIGRATIONS_DATABASE_URL is invalid: ${error.message}`], parsed: null };
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    errors.push("MIGRATIONS_DATABASE_URL must use postgres/postgresql protocol.");
  }
  if (unsafe(value)) {
    errors.push("MIGRATIONS_DATABASE_URL contains a placeholder or unsafe value.");
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "local-postgres"].includes(parsed.hostname)) {
    errors.push("MIGRATIONS_DATABASE_URL must not point at a local database.");
  }
  if (!parsed.username || !parsed.password) {
    errors.push("MIGRATIONS_DATABASE_URL must include managed migration credentials.");
  }

  const sslMode = String(parsed.searchParams.get("sslmode") || process.env.DATABASE_SSL_MODE || "").toLowerCase();
  if (!["require", "verify-full", "verify-ca"].includes(sslMode)) {
    errors.push("MIGRATIONS_DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full.");
  }

  return { ok: errors.length === 0, errors, parsed };
}

function requireEvidence(name, label, errors, { expected } = {}) {
  const value = process.env[name];
  if (!value || unsafe(value)) {
    errors.push(`${label} is required and must not be a placeholder.`);
    return null;
  }
  if (expected && value !== expected) {
    errors.push(`${label} must be ${expected}.`);
  }
  return value;
}

function buildPlan() {
  const manifest = loadManifest();
  const classifications = classifyEntries(manifest);
  const applyLocal = classifications.applyLocal.map((entry) => {
    if (!entry.exists) {
      return {
        id: entry.id,
        path: entry.path,
        status: "MISSING_FILE",
        checksum: null,
      };
    }

    return {
      id: entry.id,
      path: entry.path,
      status: "PLANNED_FOR_REVIEW",
      checksum: checksumFile(entry.absolutePath),
      schemas: entry.schemas ?? [],
    };
  });

  return {
    manifestVersion: manifest.version,
    runner: manifest.runner,
    applyLocal,
    excludedFromAutomaticApply: [
      ...classifications.draftOnly,
      ...classifications.superseded,
      ...classifications.manualReviewRequired,
      ...classifications.blocked,
    ].map((entry) => ({
      id: entry.id,
      path: entry.path,
      classification: entry.classification,
      reason: entry.reason,
    })),
    knownConflicts: manifest.knownConflicts ?? [],
  };
}

function governanceDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const errors = [];
const warnings = [];

if (!allowedModes.has(mode)) {
  errors.push(`Unsupported production migration governance mode: ${mode}.`);
}
if (process.env.DEPLOYMENT_ENVIRONMENT !== "production") {
  errors.push("DEPLOYMENT_ENVIRONMENT=production is required.");
}

const database = validateProductionDatabaseUrl(process.env.MIGRATIONS_DATABASE_URL);
errors.push(...database.errors);

const backupCheckpoint = requireEvidence(
  "PRODUCTION_MIGRATION_BACKUP_CHECKPOINT",
  "Backup/PITR checkpoint evidence",
  errors,
);
const stagingEvidence = requireEvidence(
  "PRODUCTION_MIGRATION_STAGING_REHEARSAL_EVIDENCE",
  "Staging rehearsal evidence",
  errors,
);
const approvalToken = requireEvidence("PRODUCTION_MIGRATION_APPROVAL_TOKEN", "Production migration approval token", errors);
requireEvidence("PRODUCTION_MIGRATION_APPROVED", "Production migration approval flag", errors, { expected: "true" });
requireEvidence("PRODUCTION_MIGRATION_DRIFT_CHECK", "Production migration drift check marker", errors, {
  expected: "completed",
});
requireEvidence("PRODUCTION_MIGRATION_DRIFT_RESULT", "Production migration drift result", errors, { expected: "no-drift" });

if (process.env.ALLOW_DISPOSABLE_DB_MIGRATIONS === "true") {
  errors.push("ALLOW_DISPOSABLE_DB_MIGRATIONS must not be true for production migration governance.");
}

const plan = buildPlan();
const missingFiles = plan.applyLocal.filter((entry) => entry.status === "MISSING_FILE");
if (missingFiles.length > 0) {
  errors.push("One or more planned migration files are missing.");
}

const report = {
  status: errors.length === 0 ? "PASS" : "FAIL",
  mode,
  generatedAt,
  executionPolicy: "NO_APPLY_GOVERNANCE_ONLY",
  database: {
    host: database.parsed?.hostname ?? null,
    database: database.parsed?.pathname.replace(/^\/+/, "") ?? null,
    sslmode: database.parsed?.searchParams.get("sslmode") ?? process.env.DATABASE_SSL_MODE ?? null,
    localDatabaseRejected: database.parsed
      ? ["localhost", "127.0.0.1", "0.0.0.0", "::1", "local-postgres"].includes(database.parsed.hostname)
      : null,
  },
  gates: {
    deploymentEnvironmentProduction: process.env.DEPLOYMENT_ENVIRONMENT === "production",
    migrationDatabaseUrlSafe: database.ok,
    backupCheckpointDeclared: Boolean(backupCheckpoint),
    stagingRehearsalEvidencePresent: Boolean(stagingEvidence),
    approvalPresent: Boolean(approvalToken) && process.env.PRODUCTION_MIGRATION_APPROVED === "true",
    driftDetectionCompleted:
      process.env.PRODUCTION_MIGRATION_DRIFT_CHECK === "completed" &&
      process.env.PRODUCTION_MIGRATION_DRIFT_RESULT === "no-drift",
  },
  evidence: {
    backupCheckpoint,
    stagingEvidence,
    approvalTokenPresent: Boolean(approvalToken),
    driftCheck: process.env.PRODUCTION_MIGRATION_DRIFT_CHECK ?? null,
    driftResult: process.env.PRODUCTION_MIGRATION_DRIFT_RESULT ?? null,
  },
  plan,
  warnings,
  errors,
};

report.evidenceDigest = governanceDigest({
  mode: report.mode,
  generatedAt: report.generatedAt,
  gates: report.gates,
  evidence: report.evidence,
  plan: report.plan,
});

mkdirSync(path.join(repoRoot, evidenceDir), { recursive: true });
const evidencePath = path.join(repoRoot, evidenceDir, `production-migration-${mode}-${report.evidenceDigest.slice(0, 12)}.json`);
writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
report.evidencePath = path.relative(repoRoot, evidencePath);

printJson(report);

if (errors.length > 0) {
  process.exitCode = 1;
}
