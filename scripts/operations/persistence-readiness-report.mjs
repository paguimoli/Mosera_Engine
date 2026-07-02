import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function runJson(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout };
  }

  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function scan(path, patterns) {
  const content = readIfExists(path);
  return Object.fromEntries(
    Object.entries(patterns).map(([name, regex]) => [name, regex.test(content)])
  );
}

const migrationInventory = runJson("node", ["scripts/operations/migration-inventory.mjs"]);
const gameEngineApplication = readIfExists("services/game-engine/src/GameEngine.Application/Services/EvaluationStorageService.cs")
  + readIfExists("services/game-engine/src/GameEngine.Application/Services/EvaluationSettlementPreparationService.cs")
  + readIfExists("services/game-engine/src/GameEngine.Infrastructure/InfrastructurePlaceholders.cs");
const authInfrastructure = readIfExists("services/auth-service/src/AuthService.Infrastructure/InfrastructurePlaceholders.cs")
  + readIfExists("services/auth-service/src/AuthService.Infrastructure/SupabaseLegacyPlatformIdentitySource.cs");
const authContracts = readIfExists("services/auth-service/src/AuthService.Application/Contracts/AuthRepositoryContracts.cs");

const gameSignals = {
  schemaExists: existsSync("services/game-engine/database/001_game_engine_schema_draft.sql"),
  durableStorageMigrationExists: existsSync("services/game-engine/database/002_durable_evaluation_storage.sql"),
  inMemorySignals: /InMemory|Dictionary|List<|ConcurrentDictionary/i.test(gameEngineApplication),
  databaseRepositorySignals: /DbContext|Npgsql|SqlConnection|Supabase|database-backed/i.test(gameEngineApplication),
};

const authSignals = {
  schemaExists: existsSync("services/auth-service/database/001_auth_service_schema_draft.sql"),
  repositoryContractsExist: /interface\s+IIdentityRepository/.test(authContracts),
  readOnlySupabaseSourceExists: /HttpMethod\.Get|supabase-rest-readonly/.test(authInfrastructure),
  databaseWriteRepositorySignals: /DbContext|Npgsql|SqlConnection|insert|update|delete/i.test(authInfrastructure),
};

const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts || {};

const report = {
  status: "BLOCKED_FOR_PRODUCTION_PERSISTENCE",
  generatedAt: new Date().toISOString(),
  gameEngineStorage: {
    status: gameSignals.durableStorageMigrationExists ? "SCHEMA_ARTIFACTS_PRESENT_RUNTIME_BACKING_PENDING" : "DRAFT_ONLY",
    ...gameSignals,
    gaps: [
      "Database-backed Game Engine repositories are not normalized for local integrated runtime.",
      "Local disposable migration application is active, but runtime repositories are not wired to it.",
      "Settlement consumption remains disabled by phase constraint.",
    ],
  },
  authServiceStorage: {
    status: authSignals.readOnlySupabaseSourceExists ? "READ_ONLY_SOURCE_PRESENT_WRITE_REPOSITORIES_PENDING" : "CONTRACTS_ONLY",
    ...authSignals,
    gaps: [
      "Auth Service repository contracts exist, but write-side database repositories are not implemented.",
      "Shadow import reads existing platform data only and does not persist Auth identities.",
      "Production login, sessions, and token issuance remain disabled.",
    ],
  },
  currentInMemoryRepositories: {
    gameEngine: gameSignals.inMemorySignals,
    authService: !authSignals.databaseWriteRepositorySignals,
    note: "In-memory behavior remains acceptable for this readiness phase where production activation is prohibited.",
  },
  databaseBackedRepositoryGaps: [
    "Game Engine durable evaluation repositories need database-backed implementation against the local migration baseline.",
    "Auth Service identity, credential, lifecycle, role, claim, membership, session, token, OAuth, service-account, API-client, audit, and signing-key repositories need database-backed implementations.",
    "Repository integration tests need to use the repeatable local database target.",
  ],
  schemaDraftConflicts: migrationInventory.ok
    ? {
        duplicateCreateTableRisks: migrationInventory.data.duplicateCreateTableRisks,
        createTableIfNotExistsRisks: migrationInventory.data.createTableIfNotExistsRisks,
        draftFiles: migrationInventory.data.draftFiles,
      }
    : { error: migrationInventory.error },
  requiredMigrationFramework: {
    status: migrationInventory.ok ? migrationInventory.data.migrationRunner.status : "UNKNOWN",
    recommendation: "Use the local disposable runner for development only; define staging and production approval procedures before non-local execution.",
  },
  recommendedLocalMigrationOrder: [
    "scripts/migrations/local/001_create_game_engine_schema.sql",
    "scripts/migrations/local/002_create_auth_service_schema.sql",
    "scripts/migrations/local/003_add_game_engine_evaluation_storage.sql",
  ],
  productionBlockers: [
    "No staging migration rehearsal procedure approved.",
    "No production migration approval, backup, rollback, or drift-detection procedure approved.",
    "Game Engine database repositories are not wired.",
    "Auth Service database repositories are not wired for production identity persistence.",
    "Auth Service login/token/session runtime remains intentionally disabled.",
    "Game Engine settlement consumer remains intentionally disabled.",
  ],
  availableScripts: {
    migrationInventory: Boolean(packageScripts["ops:migration-inventory"]),
    migrationStatus: Boolean(packageScripts["migrations:status"]),
    localMigrationRun: Boolean(packageScripts["migrations:local:run"]),
    localMigrationValidate: Boolean(packageScripts["migrations:local:validate"]),
    localRuntimeInventory: Boolean(packageScripts["ops:local-runtime-inventory"]),
    qaLocalIntegratedRuntime: Boolean(packageScripts["qa:local-integrated-runtime"]),
    qaLocalMigrations: Boolean(packageScripts["qa:local-migrations"]),
    qaDevtools: Boolean(packageScripts["qa:devtools"]),
  },
  sourceChecks: {
    gameEngineApplication: scan("services/game-engine/src/GameEngine.Application/Services/EvaluationStorageService.cs", {
      containsInMemory: /InMemory|Dictionary|List<|ConcurrentDictionary/i,
      containsRepository: /Repository/i,
    }),
    authInfrastructure: scan("services/auth-service/src/AuthService.Infrastructure/SupabaseLegacyPlatformIdentitySource.cs", {
      readOnlyHttpGet: /HttpMethod\.Get/,
      writesDetected: /HttpMethod\.(Post|Put|Patch|Delete)/,
    }),
  },
};

console.log(JSON.stringify(report, null, 2));
