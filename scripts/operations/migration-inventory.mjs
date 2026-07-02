import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const roots = [
  "services/game-engine/database",
  "services/auth-service/database",
  "supabase/migrations",
  "database",
];

function listSqlFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listSqlFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".sql")) return [];
    return [fullPath];
  });
}

function unique(values) {
  return [...new Set(values)].sort();
}

function matches(sql, regex) {
  return [...sql.matchAll(regex)].map((match) => match[1] || match[0]);
}

const files = roots.flatMap((root) =>
  listSqlFiles(root).map((filePath) => {
    const sql = readFileSync(filePath, "utf8");
    const createTables = matches(sql, /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)
      .map((table) => table.replaceAll('"', ""));
    const schemas = unique([
      ...matches(sql, /create\s+schema\s+(?:if\s+not\s+exists\s+)?([\w"]+)/gi),
      ...createTables
        .filter((table) => table.includes("."))
        .map((table) => table.split(".")[0]),
    ].map((schema) => schema.replaceAll('"', "")));

    return {
      path: filePath,
      sizeBytes: statSync(filePath).size,
      root,
      draft: /draft/i.test(path.basename(filePath)) || /schema_draft/i.test(sql),
      schemas,
      createTables,
      createTableIfNotExistsCount: matches(sql, /create\s+table\s+if\s+not\s+exists/gi).length,
      alterTableCount: matches(sql, /alter\s+table/gi).length,
      triggerCount: matches(sql, /create\s+(?:or\s+replace\s+)?trigger|create\s+trigger/gi).length,
      functionCount: matches(sql, /create\s+(?:or\s+replace\s+)?function/gi).length,
      appendOnlySignals: matches(sql, /append[- ]only|prevent_update|prevent_delete|immutable|no\s+update|no\s+delete/gi),
    };
  })
);

const tableToFiles = new Map();
for (const file of files) {
  for (const table of file.createTables) {
    const normalized = table.toLowerCase();
    tableToFiles.set(normalized, [...(tableToFiles.get(normalized) || []), file.path]);
  }
}

const duplicateCreateTableRisks = [...tableToFiles.entries()]
  .filter(([, filePaths]) => filePaths.length > 1)
  .map(([table, filePaths]) => ({ table, files: filePaths }));

const createTableIfNotExistsRisks = files
  .filter((file) => file.createTableIfNotExistsCount > 0)
  .map((file) => ({
    path: file.path,
    count: file.createTableIfNotExistsCount,
    reason: "Idempotent table creation can mask drift when no migration runner records applied versions.",
  }));

const missingAlterCoverage = files
  .filter((file) => file.createTables.length > 0 && file.alterTableCount === 0)
  .map((file) => file.path);

const appendOnlyCoverage = files
  .filter((file) => file.appendOnlySignals.length > 0)
  .map((file) => ({ path: file.path, signals: unique(file.appendOnlySignals.map((signal) => signal.toLowerCase())) }));

const migrationRunnerSignals = [
  "supabase/config.toml",
  "supabase/seed.sql",
  "dbmate.yml",
  "flyway.conf",
  "liquibase.properties",
  "migrations",
].filter((candidate) => existsSync(candidate));

const report = {
  status: files.length > 0 ? "READY_FOR_LOCAL_REVIEW" : "NO_MIGRATIONS_FOUND",
  generatedAt: new Date().toISOString(),
  roots: roots.map((root) => ({ root, exists: existsSync(root) })),
  migrationFileCount: files.length,
  files,
  schemas: unique(files.flatMap((file) => file.schemas)),
  draftFiles: files.filter((file) => file.draft).map((file) => file.path),
  duplicateCreateTableRisks,
  createTableIfNotExistsRisks,
  alterTableCoverage: {
    filesWithAlterTable: files.filter((file) => file.alterTableCount > 0).map((file) => file.path),
    filesCreatingTablesWithoutAlterTable: missingAlterCoverage,
  },
  triggerDefinitions: files
    .filter((file) => file.triggerCount > 0)
    .map((file) => ({ path: file.path, triggerCount: file.triggerCount, functionCount: file.functionCount })),
  appendOnlyEnforcement: {
    files: appendOnlyCoverage,
    status: appendOnlyCoverage.length > 0 ? "PARTIAL_SIGNALS_FOUND" : "NOT_DETECTED",
  },
  migrationRunner: {
    status: migrationRunnerSignals.length > 0 ? "PARTIAL" : "MISSING",
    signals: migrationRunnerSignals,
    blocker: "No repository-wide migration runner has been selected or normalized for local/staging/prod execution.",
  },
  unsafeSequencingRisks: [
    ...duplicateCreateTableRisks.map((risk) => `Duplicate create-table risk for ${risk.table}.`),
    ...createTableIfNotExistsRisks.map((risk) => `Drift can be hidden by ${risk.path}.`),
    ...(migrationRunnerSignals.length === 0 ? ["No migration runner signal found."] : []),
  ],
};

console.log(JSON.stringify(report, null, 2));
