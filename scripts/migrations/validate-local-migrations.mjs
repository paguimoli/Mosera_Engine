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

function columnExists(schema, table, column) {
  return queryScalar(`
select exists (
  select 1
  from information_schema.columns
  where table_schema = '${schema}'
    and table_name = '${table}'
    and column_name = '${column}'
);
`) === "t";
}

function columnIsNullable(schema, table, column) {
  return queryScalar(`
select is_nullable = 'YES'
from information_schema.columns
where table_schema = '${schema}'
  and table_name = '${table}'
  and column_name = '${column}';
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
  "game_engine.game_manifests",
  "game_engine.authority_certificates",
  "game_engine.outcome_strategy_definitions",
  "game_engine.math_model_definitions",
  "game_engine.paytable_definitions",
  "game_engine.rng_provider_definitions",
  "game_engine.rng_provider_evidence",
  "game_engine.outcome_events",
  "game_engine.outcome_certificates",
  "game_engine.math_evaluation_events",
  "game_engine.math_evaluation_certificates",
  "game_engine.certification_packs",
  "game_engine.signing_providers",
  "game_engine.certificate_signatures",
  "game_engine.statistical_validation_results",
  "game_engine.simulation_evidence",
  "game_engine.outcome_operational_controls",
  "game_engine.outcome_custody_events",
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
  "public.credit_reservations",
  "public.credit_reservation_releases",
  "public.credit_settlement_applications",
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
addCheck("game_manifests_game_id_version_unique", indexExists("game_engine", "game_manifests", "ux_game_manifests_game_version"));
addCheck("game_manifests_content_hash_unique", uniqueIndexExists("game_engine", "game_manifests", "content_hash"));
addCheck("game_manifests_lookup_index", indexExists("game_engine", "game_manifests", "idx_game_manifests_game_id_version"));
addCheck("authority_certificates_subject_version_hash_unique", indexExists("game_engine", "authority_certificates", "ux_authority_certificates_subject_hash"));
addCheck("authority_certificates_lookup_index", indexExists("game_engine", "authority_certificates", "idx_authority_certificates_subject_version_hash"));
addCheck("authority_certificates_previous_index", indexExists("game_engine", "authority_certificates", "idx_authority_certificates_previous_certificate"));
addCheck("outcome_strategy_definitions_strategy_version_unique", indexExists("game_engine", "outcome_strategy_definitions", "ux_outcome_strategy_definitions_strategy_version"));
addCheck("outcome_strategy_definitions_content_hash_unique", uniqueIndexExists("game_engine", "outcome_strategy_definitions", "content_hash"));
addCheck("outcome_strategy_definitions_lookup_index", indexExists("game_engine", "outcome_strategy_definitions", "idx_outcome_strategy_definitions_strategy_version"));
addCheck("math_model_definitions_model_version_unique", indexExists("game_engine", "math_model_definitions", "ux_math_model_definitions_model_version"));
addCheck("math_model_definitions_content_hash_unique", uniqueIndexExists("game_engine", "math_model_definitions", "content_hash"));
addCheck("math_model_definitions_lookup_index", indexExists("game_engine", "math_model_definitions", "idx_math_model_definitions_model_version"));
addCheck("math_model_definitions_optional_jurisdiction_profiles", columnExists("game_engine", "math_model_definitions", "jurisdiction_profile_references"));
addCheck("math_model_definitions_jurisdiction_profiles_nullable", columnIsNullable("game_engine", "math_model_definitions", "jurisdiction_profile_references"));
addCheck("math_model_definitions_optional_rtp_policy_constraints", columnExists("game_engine", "math_model_definitions", "rtp_policy_constraints"));
addCheck("math_model_definitions_rtp_policy_constraints_nullable", columnIsNullable("game_engine", "math_model_definitions", "rtp_policy_constraints"));
addCheck("math_model_definitions_certification_state", columnExists("game_engine", "math_model_definitions", "certification_binding_state"));
addCheck("math_model_definitions_no_certification_placeholder", !columnExists("game_engine", "math_model_definitions", "certification_binding_placeholder"));
addCheck("paytable_definitions_paytable_version_unique", indexExists("game_engine", "paytable_definitions", "ux_paytable_definitions_paytable_version"));
addCheck("paytable_definitions_content_hash_unique", uniqueIndexExists("game_engine", "paytable_definitions", "content_hash"));
addCheck("paytable_definitions_lookup_index", indexExists("game_engine", "paytable_definitions", "idx_paytable_definitions_paytable_version"));
addCheck("paytable_definitions_optional_jurisdiction_profiles", columnExists("game_engine", "paytable_definitions", "jurisdiction_profile_references"));
addCheck("paytable_definitions_jurisdiction_profiles_nullable", columnIsNullable("game_engine", "paytable_definitions", "jurisdiction_profile_references"));
addCheck("paytable_definitions_certification_state", columnExists("game_engine", "paytable_definitions", "certification_binding_state"));
addCheck("paytable_definitions_no_certification_placeholder", !columnExists("game_engine", "paytable_definitions", "certification_binding_placeholder"));
addCheck("rng_provider_definitions_provider_version_unique", indexExists("game_engine", "rng_provider_definitions", "ux_rng_provider_definitions_provider_version"));
addCheck("rng_provider_definitions_content_hash_unique", uniqueIndexExists("game_engine", "rng_provider_definitions", "content_hash"));
addCheck("rng_provider_definitions_lookup_index", indexExists("game_engine", "rng_provider_definitions", "idx_rng_provider_definitions_provider_version"));
addCheck("rng_provider_definitions_production_eligible_index", indexExists("game_engine", "rng_provider_definitions", "idx_rng_provider_definitions_production_eligible"));
addCheck("rng_provider_evidence_hash_unique", uniqueIndexExists("game_engine", "rng_provider_evidence", "canonical_evidence_hash"));
addCheck("rng_provider_evidence_provider_version_index", indexExists("game_engine", "rng_provider_evidence", "idx_rng_provider_evidence_provider_version"));
addCheck("rng_provider_evidence_hash_index", indexExists("game_engine", "rng_provider_evidence", "idx_rng_provider_evidence_hash"));
addCheck("outcome_events_idempotency_unique", uniqueIndexExists("game_engine", "outcome_events", "idempotency_key"));
addCheck("outcome_events_draw_id_index", indexExists("game_engine", "outcome_events", "idx_outcome_events_draw_id"));
addCheck("outcome_events_strategy_index", indexExists("game_engine", "outcome_events", "idx_outcome_events_strategy"));
addCheck("outcome_events_provider_index", indexExists("game_engine", "outcome_events", "idx_outcome_events_provider"));
addCheck("outcome_events_hash_index", indexExists("game_engine", "outcome_events", "idx_outcome_events_hash"));
addCheck("outcome_certificates_outcome_unique", indexExists("game_engine", "outcome_certificates", "ux_outcome_certificates_outcome"));
addCheck("outcome_certificates_draw_id_index", indexExists("game_engine", "outcome_certificates", "idx_outcome_certificates_draw_id"));
addCheck("outcome_certificates_outcome_hash_index", indexExists("game_engine", "outcome_certificates", "idx_outcome_certificates_outcome_hash"));
addCheck("outcome_certificates_provider_index", indexExists("game_engine", "outcome_certificates", "idx_outcome_certificates_provider"));
addCheck("math_evaluation_events_idempotency_unique", uniqueIndexExists("game_engine", "math_evaluation_events", "idempotency_key"));
addCheck("math_evaluation_events_outcome_certificate_index", indexExists("game_engine", "math_evaluation_events", "idx_math_evaluation_events_outcome_certificate"));
addCheck("math_evaluation_events_math_model_index", indexExists("game_engine", "math_evaluation_events", "idx_math_evaluation_events_math_model"));
addCheck("math_evaluation_events_paytable_index", indexExists("game_engine", "math_evaluation_events", "idx_math_evaluation_events_paytable"));
addCheck("math_evaluation_events_ticket_index", indexExists("game_engine", "math_evaluation_events", "idx_math_evaluation_events_ticket"));
addCheck("math_evaluation_events_prize_hash_index", indexExists("game_engine", "math_evaluation_events", "idx_math_evaluation_events_prize_hash"));
addCheck("math_evaluation_certificates_evaluation_unique", indexExists("game_engine", "math_evaluation_certificates", "ux_math_evaluation_certificates_evaluation"));
addCheck("math_evaluation_certificates_outcome_certificate_index", indexExists("game_engine", "math_evaluation_certificates", "idx_math_evaluation_certificates_outcome_certificate"));
addCheck("math_evaluation_certificates_math_model_index", indexExists("game_engine", "math_evaluation_certificates", "idx_math_evaluation_certificates_math_model"));
addCheck("math_evaluation_certificates_paytable_index", indexExists("game_engine", "math_evaluation_certificates", "idx_math_evaluation_certificates_paytable"));
addCheck("math_evaluation_certificates_ticket_index", indexExists("game_engine", "math_evaluation_certificates", "idx_math_evaluation_certificates_ticket"));
addCheck("math_evaluation_certificates_prize_hash_index", indexExists("game_engine", "math_evaluation_certificates", "idx_math_evaluation_certificates_prize_hash"));
addCheck("certification_packs_pack_version_unique", indexExists("game_engine", "certification_packs", "ux_certification_packs_pack_version"));
addCheck("certification_packs_content_hash_unique", indexExists("game_engine", "certification_packs", "ux_certification_packs_content_hash"));
addCheck("certification_packs_pack_version_index", indexExists("game_engine", "certification_packs", "idx_certification_packs_pack_version"));
addCheck("certification_packs_content_hash_index", indexExists("game_engine", "certification_packs", "idx_certification_packs_content_hash"));
addCheck("certification_packs_game_manifest_index", indexExists("game_engine", "certification_packs", "idx_certification_packs_game_manifest"));
addCheck("certification_packs_certification_state_index", indexExists("game_engine", "certification_packs", "idx_certification_packs_certification_state"));
addCheck("signing_providers_provider_version_unique", indexExists("game_engine", "signing_providers", "ux_signing_providers_provider_version"));
addCheck("signing_providers_content_hash_unique", indexExists("game_engine", "signing_providers", "ux_signing_providers_content_hash"));
addCheck("signing_providers_provider_version_index", indexExists("game_engine", "signing_providers", "idx_signing_providers_provider_version"));
addCheck("signing_providers_content_hash_index", indexExists("game_engine", "signing_providers", "idx_signing_providers_content_hash"));
addCheck("signing_providers_lifecycle_state_index", indexExists("game_engine", "signing_providers", "idx_signing_providers_lifecycle_state"));
addCheck("certificate_signatures_provider_certificate_hash_unique", indexExists("game_engine", "certificate_signatures", "ux_certificate_signatures_provider_certificate_hash"));
addCheck("certificate_signatures_value_unique", indexExists("game_engine", "certificate_signatures", "ux_certificate_signatures_value"));
addCheck("certificate_signatures_provider_index", indexExists("game_engine", "certificate_signatures", "idx_certificate_signatures_provider"));
addCheck("certificate_signatures_certificate_index", indexExists("game_engine", "certificate_signatures", "idx_certificate_signatures_certificate"));
addCheck("certificate_signatures_payload_hash_index", indexExists("game_engine", "certificate_signatures", "idx_certificate_signatures_payload_hash"));
addCheck("certificate_signatures_value_index", indexExists("game_engine", "certificate_signatures", "idx_certificate_signatures_value"));
addCheck("statistical_validation_results_hash_unique", indexExists("game_engine", "statistical_validation_results", "ux_statistical_validation_results_hash"));
addCheck("statistical_validation_artifact_index", indexExists("game_engine", "statistical_validation_results", "idx_statistical_validation_artifact"));
addCheck("statistical_validation_type_artifact_hash_index", indexExists("game_engine", "statistical_validation_results", "idx_statistical_validation_type_artifact_hash"));
addCheck("statistical_validation_result_hash_index", indexExists("game_engine", "statistical_validation_results", "idx_statistical_validation_result_hash"));
addCheck("statistical_validation_status_index", indexExists("game_engine", "statistical_validation_results", "idx_statistical_validation_status"));
addCheck("simulation_evidence_hash_unique", indexExists("game_engine", "simulation_evidence", "ux_simulation_evidence_hash"));
addCheck("simulation_evidence_outcome_strategy_index", indexExists("game_engine", "simulation_evidence", "idx_simulation_evidence_outcome_strategy"));
addCheck("simulation_evidence_math_model_index", indexExists("game_engine", "simulation_evidence", "idx_simulation_evidence_math_model"));
addCheck("simulation_evidence_paytable_index", indexExists("game_engine", "simulation_evidence", "idx_simulation_evidence_paytable"));
addCheck("simulation_evidence_rng_provider_index", indexExists("game_engine", "simulation_evidence", "idx_simulation_evidence_rng_provider"));
addCheck("simulation_evidence_hash_index", indexExists("game_engine", "simulation_evidence", "idx_simulation_evidence_hash"));
addCheck("outcome_operational_controls_hash_unique", indexExists("game_engine", "outcome_operational_controls", "ux_outcome_operational_controls_hash"));
addCheck("outcome_operational_controls_target_index", indexExists("game_engine", "outcome_operational_controls", "idx_outcome_operational_controls_target"));
addCheck("outcome_operational_controls_type_index", indexExists("game_engine", "outcome_operational_controls", "idx_outcome_operational_controls_type"));
addCheck("outcome_operational_controls_status_index", indexExists("game_engine", "outcome_operational_controls", "idx_outcome_operational_controls_status"));
addCheck("outcome_operational_controls_hash_index", indexExists("game_engine", "outcome_operational_controls", "idx_outcome_operational_controls_hash"));
addCheck("outcome_custody_events_hash_unique", indexExists("game_engine", "outcome_custody_events", "ux_outcome_custody_events_hash"));
addCheck("outcome_custody_events_certificate_index", indexExists("game_engine", "outcome_custody_events", "idx_outcome_custody_events_certificate"));
addCheck("outcome_custody_events_state_index", indexExists("game_engine", "outcome_custody_events", "idx_outcome_custody_events_state"));
addCheck("outcome_custody_events_control_index", indexExists("game_engine", "outcome_custody_events", "idx_outcome_custody_events_control"));
addCheck("outcome_custody_events_hash_index", indexExists("game_engine", "outcome_custody_events", "idx_outcome_custody_events_hash"));
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
addCheck("credit_reservations_idempotency_unique", uniqueIndexExists("public", "credit_reservations", "idempotency_key"));
addCheck("credit_reservations_player_id_index", indexExists("public", "credit_reservations", "credit_reservations_player_id_idx"));
addCheck("credit_reservation_releases_idempotency_unique", uniqueIndexExists("public", "credit_reservation_releases", "idempotency_key"));
addCheck("credit_settlement_applications_idempotency_unique", uniqueIndexExists("public", "credit_settlement_applications", "idempotency_key"));
addCheck("post_financial_ledger_entry_function", functionExists("public", "post_financial_ledger_entry"));
addCheck("complete_cashier_transaction_atomically_function", functionExists("public", "complete_cashier_transaction_atomically"));
addCheck("get_player_credit_summary_function", functionExists("public", "get_player_credit_summary"));
addCheck("reserve_credit_exposure_function", functionExists("public", "reserve_credit_exposure"));
addCheck("release_credit_exposure_function", functionExists("public", "release_credit_exposure"));
addCheck("apply_credit_settlement_function", functionExists("public", "apply_credit_settlement"));
addCheck("evaluation_records_update_trigger", triggerExists("game_engine", "evaluation_records", "trg_prevent_evaluation_record_update"));
addCheck("evaluation_records_delete_trigger", triggerExists("game_engine", "evaluation_records", "trg_prevent_evaluation_record_delete"));
addCheck("game_manifests_update_trigger", triggerExists("game_engine", "game_manifests", "trg_prevent_game_manifest_update"));
addCheck("game_manifests_delete_trigger", triggerExists("game_engine", "game_manifests", "trg_prevent_game_manifest_delete"));
addCheck("authority_certificates_update_trigger", triggerExists("game_engine", "authority_certificates", "trg_prevent_authority_certificate_update"));
addCheck("authority_certificates_delete_trigger", triggerExists("game_engine", "authority_certificates", "trg_prevent_authority_certificate_delete"));
addCheck("outcome_strategy_definitions_validate_trigger", triggerExists("game_engine", "outcome_strategy_definitions", "trg_validate_outcome_strategy_definition"));
addCheck("outcome_strategy_definitions_update_trigger", triggerExists("game_engine", "outcome_strategy_definitions", "trg_prevent_outcome_strategy_definition_update"));
addCheck("outcome_strategy_definitions_delete_trigger", triggerExists("game_engine", "outcome_strategy_definitions", "trg_prevent_outcome_strategy_definition_delete"));
addCheck("math_model_definitions_validate_trigger", triggerExists("game_engine", "math_model_definitions", "trg_validate_math_model_definition"));
addCheck("math_model_definitions_update_trigger", triggerExists("game_engine", "math_model_definitions", "trg_prevent_math_model_definition_update"));
addCheck("math_model_definitions_delete_trigger", triggerExists("game_engine", "math_model_definitions", "trg_prevent_math_model_definition_delete"));
addCheck("paytable_definitions_validate_trigger", triggerExists("game_engine", "paytable_definitions", "trg_validate_paytable_definition"));
addCheck("paytable_definitions_update_trigger", triggerExists("game_engine", "paytable_definitions", "trg_prevent_paytable_definition_update"));
addCheck("paytable_definitions_delete_trigger", triggerExists("game_engine", "paytable_definitions", "trg_prevent_paytable_definition_delete"));
addCheck("rng_provider_definitions_validate_trigger", triggerExists("game_engine", "rng_provider_definitions", "trg_validate_rng_provider_definition"));
addCheck("rng_provider_definitions_update_trigger", triggerExists("game_engine", "rng_provider_definitions", "trg_prevent_rng_provider_definition_update"));
addCheck("rng_provider_definitions_delete_trigger", triggerExists("game_engine", "rng_provider_definitions", "trg_prevent_rng_provider_definition_delete"));
addCheck("rng_provider_evidence_validate_trigger", triggerExists("game_engine", "rng_provider_evidence", "trg_validate_rng_provider_evidence"));
addCheck("rng_provider_evidence_update_trigger", triggerExists("game_engine", "rng_provider_evidence", "trg_prevent_rng_provider_evidence_update"));
addCheck("rng_provider_evidence_delete_trigger", triggerExists("game_engine", "rng_provider_evidence", "trg_prevent_rng_provider_evidence_delete"));
addCheck("outcome_events_validate_trigger", triggerExists("game_engine", "outcome_events", "trg_validate_outcome_event"));
addCheck("outcome_events_update_trigger", triggerExists("game_engine", "outcome_events", "trg_prevent_outcome_event_update"));
addCheck("outcome_events_delete_trigger", triggerExists("game_engine", "outcome_events", "trg_prevent_outcome_event_delete"));
addCheck("outcome_certificates_validate_trigger", triggerExists("game_engine", "outcome_certificates", "trg_validate_outcome_certificate"));
addCheck("outcome_certificates_update_trigger", triggerExists("game_engine", "outcome_certificates", "trg_prevent_outcome_certificate_update"));
addCheck("outcome_certificates_delete_trigger", triggerExists("game_engine", "outcome_certificates", "trg_prevent_outcome_certificate_delete"));
addCheck("math_evaluation_events_validate_trigger", triggerExists("game_engine", "math_evaluation_events", "trg_validate_math_evaluation_event"));
addCheck("math_evaluation_events_update_trigger", triggerExists("game_engine", "math_evaluation_events", "trg_prevent_math_evaluation_event_update"));
addCheck("math_evaluation_events_delete_trigger", triggerExists("game_engine", "math_evaluation_events", "trg_prevent_math_evaluation_event_delete"));
addCheck("math_evaluation_certificates_validate_trigger", triggerExists("game_engine", "math_evaluation_certificates", "trg_validate_math_evaluation_certificate"));
addCheck("math_evaluation_certificates_update_trigger", triggerExists("game_engine", "math_evaluation_certificates", "trg_prevent_math_evaluation_certificate_update"));
addCheck("math_evaluation_certificates_delete_trigger", triggerExists("game_engine", "math_evaluation_certificates", "trg_prevent_math_evaluation_certificate_delete"));
addCheck("certification_packs_validate_trigger", triggerExists("game_engine", "certification_packs", "trg_validate_certification_pack"));
addCheck("certification_packs_update_trigger", triggerExists("game_engine", "certification_packs", "trg_prevent_certification_pack_update"));
addCheck("certification_packs_delete_trigger", triggerExists("game_engine", "certification_packs", "trg_prevent_certification_pack_delete"));
addCheck("signing_providers_validate_trigger", triggerExists("game_engine", "signing_providers", "trg_validate_signing_provider"));
addCheck("signing_providers_update_trigger", triggerExists("game_engine", "signing_providers", "trg_prevent_signing_provider_update"));
addCheck("signing_providers_delete_trigger", triggerExists("game_engine", "signing_providers", "trg_prevent_signing_provider_delete"));
addCheck("certificate_signatures_validate_trigger", triggerExists("game_engine", "certificate_signatures", "trg_validate_certificate_signature"));
addCheck("certificate_signatures_update_trigger", triggerExists("game_engine", "certificate_signatures", "trg_prevent_certificate_signature_update"));
addCheck("certificate_signatures_delete_trigger", triggerExists("game_engine", "certificate_signatures", "trg_prevent_certificate_signature_delete"));
addCheck("statistical_validation_results_validate_trigger", triggerExists("game_engine", "statistical_validation_results", "trg_validate_statistical_validation_result"));
addCheck("statistical_validation_results_update_trigger", triggerExists("game_engine", "statistical_validation_results", "trg_prevent_statistical_validation_result_update"));
addCheck("statistical_validation_results_delete_trigger", triggerExists("game_engine", "statistical_validation_results", "trg_prevent_statistical_validation_result_delete"));
addCheck("simulation_evidence_validate_trigger", triggerExists("game_engine", "simulation_evidence", "trg_validate_simulation_evidence"));
addCheck("simulation_evidence_update_trigger", triggerExists("game_engine", "simulation_evidence", "trg_prevent_simulation_evidence_update"));
addCheck("simulation_evidence_delete_trigger", triggerExists("game_engine", "simulation_evidence", "trg_prevent_simulation_evidence_delete"));
addCheck("outcome_operational_controls_validate_trigger", triggerExists("game_engine", "outcome_operational_controls", "trg_validate_outcome_operational_control"));
addCheck("outcome_operational_controls_update_trigger", triggerExists("game_engine", "outcome_operational_controls", "trg_prevent_outcome_operational_control_update"));
addCheck("outcome_operational_controls_delete_trigger", triggerExists("game_engine", "outcome_operational_controls", "trg_prevent_outcome_operational_control_delete"));
addCheck("outcome_custody_events_validate_trigger", triggerExists("game_engine", "outcome_custody_events", "trg_validate_outcome_custody_event"));
addCheck("outcome_custody_events_update_trigger", triggerExists("game_engine", "outcome_custody_events", "trg_prevent_outcome_custody_event_update"));
addCheck("outcome_custody_events_delete_trigger", triggerExists("game_engine", "outcome_custody_events", "trg_prevent_outcome_custody_event_delete"));
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
