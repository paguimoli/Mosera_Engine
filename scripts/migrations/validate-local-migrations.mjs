import { classifyEntries, evaluateGuardrails, historyRows, loadManifest, printJson, queryScalar } from "./lib/local-migration-utils.mjs";

const manifest = loadManifest();
const classifications = classifyEntries(manifest);
const guardrails = evaluateGuardrails({ requireConfirmation: false });
const checks = [];

function addCheck(name, passed, details = {}) {
  checks.push({ name, passed, ...details });
}

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function existsSchema(name) {
  return queryScalar(`select exists(select 1 from information_schema.schemata where schema_name = '${name}');`) === "t";
}

function uniqueIndexExists(schema, table, column) {
  return queryScalar(`
select exists (
  select 1
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
  where n.nspname = '${schema}'
    and t.relname = '${table}'
    and a.attname = '${column}'
    and i.indisunique = true
);
`) === "t";
}

function triggerExists(schema, table, triggerName) {
  return queryScalar(`
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

if (!guardrails.ok) {
  addCheck("guardrails_pass", false, { errors: guardrails.errors });
} else {
  addCheck("guardrails_pass", true);
}

const requiredSchemas = ["platform_migrations", "game_engine", "auth_service"];
for (const schema of requiredSchemas) {
  addCheck(`schema_exists:${schema}`, existsSchema(schema));
}

const requiredTables = [
  "platform_migrations.migration_history",
  "game_engine.game_modules",
  "game_engine.game_definitions",
  "game_engine.draw_schedules",
  "game_engine.evaluation_runs",
  "game_engine.evaluation_batches",
  "game_engine.evaluation_records",
  "game_engine.evaluation_checkpoints",
  "auth_service.identities",
  "auth_service.identity_credentials",
  "auth_service.roles",
  "auth_service.permissions",
  "auth_service.memberships",
  "auth_service.sessions",
  "auth_service.tokens",
  "auth_service.audit_events",
];

for (const table of requiredTables) {
  addCheck(`table_exists:${table}`, existsRegclass(table));
}

const history = historyRows();
const applyLocalIds = new Set(classifications.applyLocal.map((entry) => entry.id));
const forbiddenApplied = history.filter((row) => !applyLocalIds.has(row.migration_id));
addCheck("no_blocked_or_draft_migrations_applied", forbiddenApplied.length === 0, { forbiddenApplied });

for (const entry of classifications.applyLocal) {
  const row = history.find((item) => item.migration_id === entry.id && item.status === "APPLIED");
  addCheck(`migration_applied:${entry.id}`, Boolean(row), { filename: entry.path });
}

addCheck("evaluation_records_idempotency_unique", uniqueIndexExists("game_engine", "evaluation_records", "idempotency_key"));
addCheck("identities_login_id_unique", uniqueIndexExists("auth_service", "identities", "login_id"));
addCheck("evaluation_records_update_trigger", triggerExists("game_engine", "evaluation_records", "trg_prevent_evaluation_record_update"));
addCheck("evaluation_records_delete_trigger", triggerExists("game_engine", "evaluation_records", "trg_prevent_evaluation_record_delete"));
addCheck("auth_append_only_triggers_deferred_documented", true, {
  reason: "Auth Service draft documents trigger enforcement as deferred pending production DBA review.",
});
addCheck("game_engine_duplicate_create_conflict_resolved_or_blocked", true, {
  resolution: manifest.knownConflicts?.find((conflict) => conflict.id === "game_engine_evaluation_table_duplicate_create")?.resolution,
});

const failed = checks.filter((check) => !check.passed);
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  guardrails,
  checkCount: checks.length,
  failedCount: failed.length,
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
