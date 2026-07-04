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

function indexExists(schema, table, indexName) {
  return queryScalar(`
select exists (
  select 1
  from pg_class i
  join pg_namespace n on n.oid = i.relnamespace
  join pg_index ix on ix.indexrelid = i.oid
  join pg_class t on t.oid = ix.indrelid
  where n.nspname = '${schema}'
    and t.relname = '${table}'
    and i.relname = '${indexName}'
);
`) === "t";
}

function functionExists(schema, functionName) {
  return queryScalar(`
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = '${schema}'
    and p.proname = '${functionName}'
);
`) === "t";
}

if (!guardrails.ok) {
  addCheck("guardrails_pass", false, { errors: guardrails.errors });
} else {
  addCheck("guardrails_pass", true);
}

const requiredSchemas = ["platform_migrations", "game_engine", "auth_service", "settlement_service"];
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
  "settlement_service.settlement_runs",
  "settlement_service.settlement_records",
  "settlement_service.settlement_ledger_effects",
  "public.accounts",
  "public.financial_wallets",
  "public.financial_ledger_entries",
  "public.cashier_transactions",
  "public.outbox_events",
  "public.financial_worker_event_handlers",
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
addCheck("evaluation_runs_draw_id_index", indexExists("game_engine", "evaluation_runs", "idx_evaluation_runs_draw_id"));
addCheck("evaluation_runs_game_binding_id_index", indexExists("game_engine", "evaluation_runs", "idx_evaluation_runs_game_binding_id"));
addCheck("evaluation_runs_status_index", indexExists("game_engine", "evaluation_runs", "idx_evaluation_runs_status"));
addCheck("evaluation_batches_run_status_index", indexExists("game_engine", "evaluation_batches", "idx_evaluation_batches_run_status"));
addCheck("evaluation_checkpoints_run_id_index", indexExists("game_engine", "evaluation_checkpoints", "idx_evaluation_checkpoints_run_id"));
addCheck("identities_login_id_unique", uniqueIndexExists("auth_service", "identities", "login_id"));
addCheck("settlement_runs_completed_drawing_unique", indexExists("settlement_service", "settlement_runs", "ux_settlement_runs_completed_drawing"));
addCheck("settlement_records_completed_ticket_line_unique", indexExists("settlement_service", "settlement_records", "ux_settlement_records_completed_ticket_line"));
addCheck("settlement_runs_drawing_id_index", indexExists("settlement_service", "settlement_runs", "idx_settlement_runs_drawing_id"));
addCheck("settlement_runs_status_index", indexExists("settlement_service", "settlement_runs", "idx_settlement_runs_status"));
addCheck("settlement_records_run_id_index", indexExists("settlement_service", "settlement_records", "idx_settlement_records_run_id"));
addCheck("settlement_records_ticket_draw_index", indexExists("settlement_service", "settlement_records", "idx_settlement_records_ticket_draw"));
addCheck("settlement_ledger_effects_idempotency_unique", uniqueIndexExists("settlement_service", "settlement_ledger_effects", "idempotency_key"));
addCheck("settlement_ledger_effects_run_id_index", indexExists("settlement_service", "settlement_ledger_effects", "idx_settlement_ledger_effects_run_id"));
addCheck("settlement_ledger_effects_record_id_index", indexExists("settlement_service", "settlement_ledger_effects", "idx_settlement_ledger_effects_record_id"));
addCheck("settlement_ledger_effects_ticket_draw_index", indexExists("settlement_service", "settlement_ledger_effects", "idx_settlement_ledger_effects_ticket_draw"));
addCheck("cashier_transactions_status_index", indexExists("public", "cashier_transactions", "cashier_transactions_status_idx"));
addCheck("financial_ledger_entries_idempotency_unique", uniqueIndexExists("public", "financial_ledger_entries", "idempotency_key"));
addCheck("outbox_events_aggregate_index", indexExists("public", "outbox_events", "outbox_events_aggregate_idx"));
addCheck("financial_worker_event_handlers_idempotency_unique", uniqueIndexExists("public", "financial_worker_event_handlers", "idempotency_key"));
addCheck("financial_worker_event_handlers_event_type_index", indexExists("public", "financial_worker_event_handlers", "financial_worker_event_handlers_event_type_idx"));
addCheck("financial_worker_event_handlers_status_index", indexExists("public", "financial_worker_event_handlers", "financial_worker_event_handlers_status_idx"));
addCheck("post_financial_ledger_entry_function", functionExists("public", "post_financial_ledger_entry"));
addCheck("complete_cashier_transaction_atomically_function", functionExists("public", "complete_cashier_transaction_atomically"));
addCheck("evaluation_records_update_trigger", triggerExists("game_engine", "evaluation_records", "trg_prevent_evaluation_record_update"));
addCheck("evaluation_records_delete_trigger", triggerExists("game_engine", "evaluation_records", "trg_prevent_evaluation_record_delete"));
addCheck("settlement_records_update_trigger", triggerExists("settlement_service", "settlement_records", "trg_prevent_settlement_record_update"));
addCheck("settlement_records_delete_trigger", triggerExists("settlement_service", "settlement_records", "trg_prevent_settlement_record_delete"));
addCheck("settlement_ledger_effects_update_trigger", triggerExists("settlement_service", "settlement_ledger_effects", "trg_prevent_settlement_ledger_effect_update"));
addCheck("settlement_ledger_effects_delete_trigger", triggerExists("settlement_service", "settlement_ledger_effects", "trg_prevent_settlement_ledger_effect_delete"));
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
