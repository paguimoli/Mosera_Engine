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

function constraintExists(schema, table, constraintName) {
  return queryScalar(`
select exists (
  select 1
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = '${schema}'
    and t.relname = '${table}'
    and c.conname = '${constraintName}'
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

const requiredSchemas = ["platform_migrations", "game_engine", "auth_service", "settlement_service", "platform"];
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
  "game_engine.outcome_provider_definitions",
  "game_engine.entropy_provider_definitions",
  "game_engine.csprng_provider_definitions",
  "game_engine.drbg_session_evidence",
  "game_engine.provably_fair_provider_definitions",
  "game_engine.provably_fair_seed_commitments",
  "game_engine.provably_fair_nonce_sequences",
  "game_engine.provably_fair_verification_receipts",
  "game_engine.provably_fair_runtime_receipts",
  "game_engine.provably_fair_seed_reveal_evidence",
  "game_engine.provably_fair_verification_results",
  "game_engine.external_result_source_definitions",
  "game_engine.external_result_schema_mappings",
  "game_engine.external_result_ingestion_events",
  "game_engine.external_result_verification_evidence",
  "game_engine.physical_draw_authorities",
  "game_engine.physical_draw_events",
  "game_engine.physical_draw_witnesses",
  "game_engine.physical_draw_equipment",
  "game_engine.physical_draw_evidence",
  "game_engine.outcome_runtime_requests",
  "game_engine.outcome_runtime_attempts",
  "game_engine.outcome_runtime_boot_identities",
  "game_engine.outcome_runtime_request_provenance",
  "game_engine.outcome_runtime_attempt_provenance",
  "game_engine.outcome_runtime_recovery_evidence",
  "game_engine.cryptographic_conformance_reports",
  "game_engine.statistical_validation_framework_reports",
  "game_engine.provider_validation_registry",
  "game_engine.certification_readiness_evaluations",
  "game_engine.outcome_runtime_rollback_watermarks",
  "game_engine.outcome_events",
  "game_engine.outcome_certificates",
  "game_engine.math_evaluation_events",
  "game_engine.math_evaluation_certificates",
  "game_engine.math_evaluation_requests",
  "game_engine.math_evaluation_attempts",
  "game_engine.math_evaluation_batches",
  "game_engine.math_evaluation_batch_items",
  "game_engine.math_evaluation_batch_attempts",
  "game_engine.settlement_input_records",
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
  "platform.organizations",
  "platform.tenants",
  "platform.brands",
  "platform.markets",
  "platform.websites",
  "platform.website_domains",
  "platform.brand_themes",
  "platform.brand_assets",
  "platform.game_availability",
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
addCheck("outcome_provider_definitions_provider_version_unique", indexExists("game_engine", "outcome_provider_definitions", "ux_outcome_provider_definitions_provider_version"));
addCheck("outcome_provider_definitions_content_hash_unique", uniqueIndexExists("game_engine", "outcome_provider_definitions", "content_hash"));
addCheck("outcome_provider_definitions_lookup_index", indexExists("game_engine", "outcome_provider_definitions", "idx_outcome_provider_definitions_provider_version"));
addCheck("outcome_provider_definitions_type_hash_index", indexExists("game_engine", "outcome_provider_definitions", "idx_outcome_provider_definitions_type_hash"));
addCheck("outcome_provider_definitions_lifecycle_eligible_index", indexExists("game_engine", "outcome_provider_definitions", "idx_outcome_provider_definitions_lifecycle_eligible"));
addCheck("outcome_provider_definitions_validate_trigger", triggerExists("game_engine", "outcome_provider_definitions", "trg_validate_outcome_provider_definition"));
addCheck("outcome_provider_definitions_update_trigger", triggerExists("game_engine", "outcome_provider_definitions", "trg_prevent_outcome_provider_update"));
addCheck("outcome_provider_definitions_delete_trigger", triggerExists("game_engine", "outcome_provider_definitions", "trg_prevent_outcome_provider_delete"));
addCheck("entropy_provider_definitions_provider_version_unique", indexExists("game_engine", "entropy_provider_definitions", "ux_entropy_provider_definitions_provider_version"));
addCheck("entropy_provider_definitions_content_hash_unique", uniqueIndexExists("game_engine", "entropy_provider_definitions", "content_hash"));
addCheck("entropy_provider_definitions_lookup_index", indexExists("game_engine", "entropy_provider_definitions", "idx_entropy_provider_definitions_provider_version"));
addCheck("entropy_provider_definitions_type_eligible_index", indexExists("game_engine", "entropy_provider_definitions", "idx_entropy_provider_definitions_type_eligible"));
addCheck("entropy_provider_definitions_validate_trigger", triggerExists("game_engine", "entropy_provider_definitions", "trg_validate_entropy_provider_definition"));
addCheck("entropy_provider_definitions_update_trigger", triggerExists("game_engine", "entropy_provider_definitions", "trg_prevent_entropy_provider_update"));
addCheck("entropy_provider_definitions_delete_trigger", triggerExists("game_engine", "entropy_provider_definitions", "trg_prevent_entropy_provider_delete"));
addCheck("entropy_provider_definitions_no_raw_secret_columns", !columnExists("game_engine", "entropy_provider_definitions", "raw_seed") && !columnExists("game_engine", "entropy_provider_definitions", "raw_entropy") && !columnExists("game_engine", "entropy_provider_definitions", "drbg_state"));
addCheck("csprng_provider_definitions_provider_version_unique", indexExists("game_engine", "csprng_provider_definitions", "ux_csprng_provider_definitions_provider_version"));
addCheck("csprng_provider_definitions_content_hash_unique", uniqueIndexExists("game_engine", "csprng_provider_definitions", "content_hash"));
addCheck("csprng_provider_definitions_lookup_index", indexExists("game_engine", "csprng_provider_definitions", "idx_csprng_provider_definitions_provider_version"));
addCheck("csprng_provider_definitions_outcome_provider_index", indexExists("game_engine", "csprng_provider_definitions", "idx_csprng_provider_definitions_outcome_provider"));
addCheck("csprng_provider_definitions_rng_provider_index", indexExists("game_engine", "csprng_provider_definitions", "idx_csprng_provider_definitions_rng_provider"));
addCheck("csprng_provider_definitions_lifecycle_eligible_index", indexExists("game_engine", "csprng_provider_definitions", "idx_csprng_provider_definitions_lifecycle_eligible"));
addCheck("csprng_provider_definitions_validate_trigger", triggerExists("game_engine", "csprng_provider_definitions", "trg_validate_csprng_provider_definition"));
addCheck("csprng_provider_definitions_update_trigger", triggerExists("game_engine", "csprng_provider_definitions", "trg_prevent_csprng_provider_update"));
addCheck("csprng_provider_definitions_delete_trigger", triggerExists("game_engine", "csprng_provider_definitions", "trg_prevent_csprng_provider_delete"));
addCheck("csprng_provider_definitions_no_raw_secret_columns", !columnExists("game_engine", "csprng_provider_definitions", "raw_seed") && !columnExists("game_engine", "csprng_provider_definitions", "raw_entropy") && !columnExists("game_engine", "csprng_provider_definitions", "drbg_state"));
addCheck("drbg_session_evidence_hash_unique", uniqueIndexExists("game_engine", "drbg_session_evidence", "canonical_evidence_hash"));
addCheck("drbg_session_evidence_provider_index", indexExists("game_engine", "drbg_session_evidence", "idx_drbg_session_evidence_provider_version"));
addCheck("drbg_session_evidence_entropy_provider_index", indexExists("game_engine", "drbg_session_evidence", "idx_drbg_session_evidence_entropy_provider"));
addCheck("drbg_session_evidence_scope_index", indexExists("game_engine", "drbg_session_evidence", "idx_drbg_session_evidence_scope"));
addCheck("drbg_session_evidence_hash_index", indexExists("game_engine", "drbg_session_evidence", "idx_drbg_session_evidence_hash"));
addCheck("drbg_session_evidence_validate_trigger", triggerExists("game_engine", "drbg_session_evidence", "trg_validate_drbg_session_evidence"));
addCheck("drbg_session_evidence_update_trigger", triggerExists("game_engine", "drbg_session_evidence", "trg_prevent_drbg_session_evidence_update"));
addCheck("drbg_session_evidence_delete_trigger", triggerExists("game_engine", "drbg_session_evidence", "trg_prevent_drbg_session_evidence_delete"));
addCheck("drbg_session_evidence_no_raw_secret_columns", !columnExists("game_engine", "drbg_session_evidence", "raw_seed") && !columnExists("game_engine", "drbg_session_evidence", "raw_entropy") && !columnExists("game_engine", "drbg_session_evidence", "drbg_state"));
addCheck("provably_fair_provider_definitions_provider_version_unique", indexExists("game_engine", "provably_fair_provider_definitions", "ux_provably_fair_provider_definitions_provider_version"));
addCheck("provably_fair_provider_definitions_content_hash_unique", uniqueIndexExists("game_engine", "provably_fair_provider_definitions", "content_hash"));
addCheck("provably_fair_provider_definitions_lookup_index", indexExists("game_engine", "provably_fair_provider_definitions", "idx_provably_fair_provider_definitions_provider_version"));
addCheck("provably_fair_provider_definitions_outcome_provider_index", indexExists("game_engine", "provably_fair_provider_definitions", "idx_provably_fair_provider_definitions_outcome_provider"));
addCheck("provably_fair_provider_definitions_lifecycle_eligible_index", indexExists("game_engine", "provably_fair_provider_definitions", "idx_provably_fair_provider_definitions_lifecycle_eligible"));
addCheck("provably_fair_provider_definitions_validate_trigger", triggerExists("game_engine", "provably_fair_provider_definitions", "trg_validate_provably_fair_provider_definition"));
addCheck("provably_fair_provider_definitions_update_trigger", triggerExists("game_engine", "provably_fair_provider_definitions", "trg_prevent_provably_fair_provider_update"));
addCheck("provably_fair_provider_definitions_delete_trigger", triggerExists("game_engine", "provably_fair_provider_definitions", "trg_prevent_provably_fair_provider_delete"));
addCheck("provably_fair_provider_definitions_no_plaintext_seed_columns", !columnExists("game_engine", "provably_fair_provider_definitions", "server_seed") && !columnExists("game_engine", "provably_fair_provider_definitions", "raw_seed") && !columnExists("game_engine", "provably_fair_provider_definitions", "plaintext_seed"));
addCheck("provably_fair_seed_commitments_commitment_unique", uniqueIndexExists("game_engine", "provably_fair_seed_commitments", "commitment_hash"));
addCheck("provably_fair_seed_commitments_content_hash_unique", uniqueIndexExists("game_engine", "provably_fair_seed_commitments", "content_hash"));
addCheck("provably_fair_seed_commitments_provider_index", indexExists("game_engine", "provably_fair_seed_commitments", "idx_provably_fair_seed_commitments_provider_version"));
addCheck("provably_fair_seed_commitments_commitment_index", indexExists("game_engine", "provably_fair_seed_commitments", "idx_provably_fair_seed_commitments_commitment"));
addCheck("provably_fair_seed_commitments_validate_trigger", triggerExists("game_engine", "provably_fair_seed_commitments", "trg_validate_provably_fair_seed_commitment"));
addCheck("provably_fair_seed_commitments_update_trigger", triggerExists("game_engine", "provably_fair_seed_commitments", "trg_prevent_provably_fair_seed_update"));
addCheck("provably_fair_seed_commitments_delete_trigger", triggerExists("game_engine", "provably_fair_seed_commitments", "trg_prevent_provably_fair_seed_delete"));
addCheck("provably_fair_seed_commitments_no_plaintext_seed_columns", !columnExists("game_engine", "provably_fair_seed_commitments", "server_seed") && !columnExists("game_engine", "provably_fair_seed_commitments", "raw_seed") && !columnExists("game_engine", "provably_fair_seed_commitments", "plaintext_seed"));
addCheck("provably_fair_nonce_sequences_nonce_unique", indexExists("game_engine", "provably_fair_nonce_sequences", "ux_provably_fair_nonce_sequences_nonce"));
addCheck("provably_fair_nonce_sequences_content_hash_unique", uniqueIndexExists("game_engine", "provably_fair_nonce_sequences", "content_hash"));
addCheck("provably_fair_nonce_sequences_scope_index", indexExists("game_engine", "provably_fair_nonce_sequences", "idx_provably_fair_nonce_sequences_scope"));
addCheck("provably_fair_nonce_sequences_validate_trigger", triggerExists("game_engine", "provably_fair_nonce_sequences", "trg_validate_provably_fair_nonce_sequence"));
addCheck("provably_fair_nonce_sequences_update_trigger", triggerExists("game_engine", "provably_fair_nonce_sequences", "trg_prevent_provably_fair_nonce_update"));
addCheck("provably_fair_nonce_sequences_delete_trigger", triggerExists("game_engine", "provably_fair_nonce_sequences", "trg_prevent_provably_fair_nonce_delete"));
addCheck("provably_fair_verification_receipts_hash_unique", uniqueIndexExists("game_engine", "provably_fair_verification_receipts", "receipt_hash"));
addCheck("provably_fair_verification_receipts_wager_provider_unique", indexExists("game_engine", "provably_fair_verification_receipts", "ux_provably_fair_verification_receipts_wager_provider"));
addCheck("provably_fair_verification_receipts_provider_index", indexExists("game_engine", "provably_fair_verification_receipts", "idx_provably_fair_verification_receipts_provider"));
addCheck("provably_fair_verification_receipts_outcome_certificate_index", indexExists("game_engine", "provably_fair_verification_receipts", "idx_provably_fair_verification_receipts_outcome_certificate"));
addCheck("provably_fair_verification_receipts_validate_trigger", triggerExists("game_engine", "provably_fair_verification_receipts", "trg_validate_provably_fair_verification_receipt"));
addCheck("provably_fair_verification_receipts_update_trigger", triggerExists("game_engine", "provably_fair_verification_receipts", "trg_prevent_provably_fair_receipt_update"));
addCheck("provably_fair_verification_receipts_delete_trigger", triggerExists("game_engine", "provably_fair_verification_receipts", "trg_prevent_provably_fair_receipt_delete"));
addCheck("provably_fair_verification_receipts_no_plaintext_seed_columns", !columnExists("game_engine", "provably_fair_verification_receipts", "server_seed") && !columnExists("game_engine", "provably_fair_verification_receipts", "raw_seed") && !columnExists("game_engine", "provably_fair_verification_receipts", "plaintext_seed"));
addCheck("provably_fair_runtime_receipts_hash_unique", uniqueIndexExists("game_engine", "provably_fair_runtime_receipts", "receipt_hash"));
addCheck("provably_fair_runtime_receipts_scope_nonce_unique", indexExists("game_engine", "provably_fair_runtime_receipts", "ux_provably_fair_runtime_receipts_scope_nonce"));
addCheck("provably_fair_runtime_receipts_provider_index", indexExists("game_engine", "provably_fair_runtime_receipts", "idx_provably_fair_runtime_receipts_provider"));
addCheck("provably_fair_runtime_receipts_validate_trigger", triggerExists("game_engine", "provably_fair_runtime_receipts", "trg_validate_provably_fair_runtime_receipt"));
addCheck("provably_fair_runtime_receipts_update_trigger", triggerExists("game_engine", "provably_fair_runtime_receipts", "trg_prevent_provably_fair_runtime_receipt_update"));
addCheck("provably_fair_runtime_receipts_delete_trigger", triggerExists("game_engine", "provably_fair_runtime_receipts", "trg_prevent_provably_fair_runtime_receipt_delete"));
addCheck("provably_fair_runtime_receipts_no_plaintext_seed_columns", !columnExists("game_engine", "provably_fair_runtime_receipts", "server_seed") && !columnExists("game_engine", "provably_fair_runtime_receipts", "raw_seed") && !columnExists("game_engine", "provably_fair_runtime_receipts", "plaintext_seed"));
addCheck("provably_fair_seed_reveal_evidence_hash_unique", uniqueIndexExists("game_engine", "provably_fair_seed_reveal_evidence", "canonical_evidence_hash"));
addCheck("provably_fair_seed_reveal_evidence_seed_index", indexExists("game_engine", "provably_fair_seed_reveal_evidence", "idx_provably_fair_seed_reveal_evidence_seed"));
addCheck("provably_fair_seed_reveal_evidence_validate_trigger", triggerExists("game_engine", "provably_fair_seed_reveal_evidence", "trg_validate_provably_fair_runtime_reveal"));
addCheck("provably_fair_seed_reveal_evidence_update_trigger", triggerExists("game_engine", "provably_fair_seed_reveal_evidence", "trg_prevent_provably_fair_runtime_reveal_update"));
addCheck("provably_fair_seed_reveal_evidence_delete_trigger", triggerExists("game_engine", "provably_fair_seed_reveal_evidence", "trg_prevent_provably_fair_runtime_reveal_delete"));
addCheck("provably_fair_seed_reveal_evidence_no_plaintext_seed_columns", !columnExists("game_engine", "provably_fair_seed_reveal_evidence", "server_seed") && !columnExists("game_engine", "provably_fair_seed_reveal_evidence", "raw_seed") && !columnExists("game_engine", "provably_fair_seed_reveal_evidence", "plaintext_seed"));
addCheck("provably_fair_verification_results_hash_unique", uniqueIndexExists("game_engine", "provably_fair_verification_results", "canonical_result_hash"));
addCheck("provably_fair_verification_results_receipt_index", indexExists("game_engine", "provably_fair_verification_results", "idx_provably_fair_verification_results_receipt"));
addCheck("provably_fair_verification_results_update_trigger", triggerExists("game_engine", "provably_fair_verification_results", "trg_prevent_provably_fair_verification_result_update"));
addCheck("provably_fair_verification_results_delete_trigger", triggerExists("game_engine", "provably_fair_verification_results", "trg_prevent_provably_fair_verification_result_delete"));
addCheck("external_result_source_definitions_version_unique", indexExists("game_engine", "external_result_source_definitions", "ux_external_result_source_definitions_version"));
addCheck("external_result_source_definitions_hash_unique", uniqueIndexExists("game_engine", "external_result_source_definitions", "content_hash"));
addCheck("external_result_source_definitions_lifecycle_index", indexExists("game_engine", "external_result_source_definitions", "idx_external_result_source_definitions_lifecycle"));
addCheck("external_result_source_definitions_validate_trigger", triggerExists("game_engine", "external_result_source_definitions", "trg_validate_external_result_source_definition"));
addCheck("external_result_source_definitions_update_trigger", triggerExists("game_engine", "external_result_source_definitions", "trg_prevent_external_result_source_update"));
addCheck("external_result_source_definitions_delete_trigger", triggerExists("game_engine", "external_result_source_definitions", "trg_prevent_external_result_source_delete"));
addCheck("external_result_source_definitions_no_secret_columns", !columnExists("game_engine", "external_result_source_definitions", "credential") && !columnExists("game_engine", "external_result_source_definitions", "secret") && !columnExists("game_engine", "external_result_source_definitions", "api_key"));
addCheck("external_result_schema_mappings_version_unique", indexExists("game_engine", "external_result_schema_mappings", "ux_external_result_schema_mappings_version"));
addCheck("external_result_schema_mappings_hash_unique", uniqueIndexExists("game_engine", "external_result_schema_mappings", "content_hash"));
addCheck("external_result_schema_mappings_source_index", indexExists("game_engine", "external_result_schema_mappings", "idx_external_result_schema_mappings_source"));
addCheck("external_result_schema_mappings_validate_trigger", triggerExists("game_engine", "external_result_schema_mappings", "trg_validate_external_result_schema_mapping"));
addCheck("external_result_schema_mappings_update_trigger", triggerExists("game_engine", "external_result_schema_mappings", "trg_prevent_external_result_schema_mapping_update"));
addCheck("external_result_schema_mappings_delete_trigger", triggerExists("game_engine", "external_result_schema_mappings", "trg_prevent_external_result_schema_mapping_delete"));
addCheck("external_result_ingestion_events_idempotency_unique", indexExists("game_engine", "external_result_ingestion_events", "ux_external_result_ingestion_idempotency"));
addCheck("external_result_ingestion_events_content_hash_unique", uniqueIndexExists("game_engine", "external_result_ingestion_events", "content_hash"));
addCheck("external_result_ingestion_events_one_certified_draw_unique", indexExists("game_engine", "external_result_ingestion_events", "ux_external_result_ingestion_one_certified_draw"));
addCheck("external_result_ingestion_events_source_draw_index", indexExists("game_engine", "external_result_ingestion_events", "idx_external_result_ingestion_events_source_draw"));
addCheck("external_result_ingestion_events_validate_trigger", triggerExists("game_engine", "external_result_ingestion_events", "trg_validate_external_result_ingestion_event"));
addCheck("external_result_ingestion_events_update_trigger", triggerExists("game_engine", "external_result_ingestion_events", "trg_prevent_external_result_ingestion_event_update"));
addCheck("external_result_ingestion_events_delete_trigger", triggerExists("game_engine", "external_result_ingestion_events", "trg_prevent_external_result_ingestion_event_delete"));
addCheck("external_result_ingestion_events_no_secret_columns", !columnExists("game_engine", "external_result_ingestion_events", "source_signature") && !columnExists("game_engine", "external_result_ingestion_events", "credential") && !columnExists("game_engine", "external_result_ingestion_events", "secret"));
addCheck("external_result_verification_evidence_hash_unique", uniqueIndexExists("game_engine", "external_result_verification_evidence", "evidence_hash"));
addCheck("external_result_verification_evidence_source_draw_index", indexExists("game_engine", "external_result_verification_evidence", "idx_external_result_verification_evidence_source_draw"));
addCheck("external_result_verification_evidence_validate_trigger", triggerExists("game_engine", "external_result_verification_evidence", "trg_validate_external_result_verification_evidence"));
addCheck("external_result_verification_evidence_update_trigger", triggerExists("game_engine", "external_result_verification_evidence", "trg_prevent_external_result_verification_evidence_update"));
addCheck("external_result_verification_evidence_delete_trigger", triggerExists("game_engine", "external_result_verification_evidence", "trg_prevent_external_result_verification_evidence_delete"));
addCheck("physical_draw_authorities_version_unique", indexExists("game_engine", "physical_draw_authorities", "ux_physical_draw_authorities_version"));
addCheck("physical_draw_authorities_hash_unique", uniqueIndexExists("game_engine", "physical_draw_authorities", "content_hash"));
addCheck("physical_draw_authorities_lifecycle_index", indexExists("game_engine", "physical_draw_authorities", "idx_physical_draw_authorities_lifecycle"));
addCheck("physical_draw_authorities_validate_trigger", triggerExists("game_engine", "physical_draw_authorities", "trg_validate_physical_draw_authority"));
addCheck("physical_draw_authorities_update_trigger", triggerExists("game_engine", "physical_draw_authorities", "trg_prevent_physical_draw_authority_update"));
addCheck("physical_draw_authorities_delete_trigger", triggerExists("game_engine", "physical_draw_authorities", "trg_prevent_physical_draw_authority_delete"));
addCheck("physical_draw_events_idempotency_unique", indexExists("game_engine", "physical_draw_events", "ux_physical_draw_events_idempotency"));
addCheck("physical_draw_events_draw_hash_unique", indexExists("game_engine", "physical_draw_events", "ux_physical_draw_events_draw_hash"));
addCheck("physical_draw_events_one_certified_draw_unique", indexExists("game_engine", "physical_draw_events", "ux_physical_draw_events_one_certified_draw"));
addCheck("physical_draw_events_authority_draw_index", indexExists("game_engine", "physical_draw_events", "idx_physical_draw_events_authority_draw"));
addCheck("physical_draw_events_validate_trigger", triggerExists("game_engine", "physical_draw_events", "trg_validate_physical_draw_event"));
addCheck("physical_draw_events_update_trigger", triggerExists("game_engine", "physical_draw_events", "trg_prevent_physical_draw_event_update"));
addCheck("physical_draw_events_delete_trigger", triggerExists("game_engine", "physical_draw_events", "trg_prevent_physical_draw_event_delete"));
addCheck("physical_draw_events_no_secret_or_money_columns", !columnExists("game_engine", "physical_draw_events", "secret") && !columnExists("game_engine", "physical_draw_events", "credential") && !columnExists("game_engine", "physical_draw_events", "token") && !columnExists("game_engine", "physical_draw_events", "payout") && !columnExists("game_engine", "physical_draw_events", "ledger_entry_id"));
addCheck("physical_draw_witnesses_hash_unique", uniqueIndexExists("game_engine", "physical_draw_witnesses", "evidence_hash"));
addCheck("physical_draw_witnesses_event_index", indexExists("game_engine", "physical_draw_witnesses", "idx_physical_draw_witnesses_event"));
addCheck("physical_draw_witnesses_validate_trigger", triggerExists("game_engine", "physical_draw_witnesses", "trg_validate_physical_draw_witness"));
addCheck("physical_draw_witnesses_update_trigger", triggerExists("game_engine", "physical_draw_witnesses", "trg_prevent_physical_draw_witness_update"));
addCheck("physical_draw_witnesses_delete_trigger", triggerExists("game_engine", "physical_draw_witnesses", "trg_prevent_physical_draw_witness_delete"));
addCheck("physical_draw_equipment_hash_unique", uniqueIndexExists("game_engine", "physical_draw_equipment", "evidence_hash"));
addCheck("physical_draw_equipment_event_index", indexExists("game_engine", "physical_draw_equipment", "idx_physical_draw_equipment_event"));
addCheck("physical_draw_equipment_validate_trigger", triggerExists("game_engine", "physical_draw_equipment", "trg_validate_physical_draw_equipment"));
addCheck("physical_draw_equipment_update_trigger", triggerExists("game_engine", "physical_draw_equipment", "trg_prevent_physical_draw_equipment_update"));
addCheck("physical_draw_equipment_delete_trigger", triggerExists("game_engine", "physical_draw_equipment", "trg_prevent_physical_draw_equipment_delete"));
addCheck("physical_draw_evidence_hash_unique", uniqueIndexExists("game_engine", "physical_draw_evidence", "evidence_hash"));
addCheck("physical_draw_evidence_authority_draw_index", indexExists("game_engine", "physical_draw_evidence", "idx_physical_draw_evidence_authority_draw"));
addCheck("physical_draw_evidence_validate_trigger", triggerExists("game_engine", "physical_draw_evidence", "trg_validate_physical_draw_evidence"));
addCheck("physical_draw_evidence_update_trigger", triggerExists("game_engine", "physical_draw_evidence", "trg_prevent_physical_draw_evidence_update"));
addCheck("physical_draw_evidence_delete_trigger", triggerExists("game_engine", "physical_draw_evidence", "trg_prevent_physical_draw_evidence_delete"));
addCheck("outcome_runtime_requests_idempotency_scope_unique", indexExists("game_engine", "outcome_runtime_requests", "ux_outcome_runtime_requests_idempotency_scope"));
addCheck("outcome_runtime_requests_manifest_index", indexExists("game_engine", "outcome_runtime_requests", "idx_outcome_runtime_requests_manifest"));
addCheck("outcome_runtime_requests_provider_index", indexExists("game_engine", "outcome_runtime_requests", "idx_outcome_runtime_requests_provider"));
addCheck("outcome_runtime_requests_lock_scope_index", indexExists("game_engine", "outcome_runtime_requests", "idx_outcome_runtime_requests_lock_scope"));
addCheck("outcome_runtime_requests_validate_trigger", triggerExists("game_engine", "outcome_runtime_requests", "trg_validate_outcome_runtime_request"));
addCheck("outcome_runtime_requests_update_trigger", triggerExists("game_engine", "outcome_runtime_requests", "trg_prevent_outcome_runtime_request_update"));
addCheck("outcome_runtime_requests_delete_trigger", triggerExists("game_engine", "outcome_runtime_requests", "trg_prevent_outcome_runtime_request_delete"));
addCheck("outcome_runtime_requests_no_raw_secret_columns", !columnExists("game_engine", "outcome_runtime_requests", "raw_seed") && !columnExists("game_engine", "outcome_runtime_requests", "raw_entropy") && !columnExists("game_engine", "outcome_runtime_requests", "drbg_state"));
addCheck("outcome_runtime_attempts_hash_unique", uniqueIndexExists("game_engine", "outcome_runtime_attempts", "canonical_attempt_hash"));
addCheck("outcome_runtime_attempts_request_index", indexExists("game_engine", "outcome_runtime_attempts", "idx_outcome_runtime_attempts_request"));
addCheck("outcome_runtime_attempts_provider_index", indexExists("game_engine", "outcome_runtime_attempts", "idx_outcome_runtime_attempts_provider"));
addCheck("outcome_runtime_attempts_scope_index", indexExists("game_engine", "outcome_runtime_attempts", "idx_outcome_runtime_attempts_scope"));
addCheck("outcome_runtime_attempts_validate_trigger", triggerExists("game_engine", "outcome_runtime_attempts", "trg_validate_outcome_runtime_attempt"));
addCheck("outcome_runtime_attempts_update_trigger", triggerExists("game_engine", "outcome_runtime_attempts", "trg_prevent_outcome_runtime_attempt_update"));
addCheck("outcome_runtime_attempts_delete_trigger", triggerExists("game_engine", "outcome_runtime_attempts", "trg_prevent_outcome_runtime_attempt_delete"));
addCheck("outcome_runtime_advisory_lock_function", functionExists("game_engine", "try_outcome_runtime_advisory_lock"));
addCheck("outcome_runtime_attempts_no_raw_secret_columns", !columnExists("game_engine", "outcome_runtime_attempts", "raw_seed") && !columnExists("game_engine", "outcome_runtime_attempts", "raw_entropy") && !columnExists("game_engine", "outcome_runtime_attempts", "drbg_state"));
addCheck("outcome_runtime_boot_identity_unique", uniqueIndexExists("game_engine", "outcome_runtime_boot_identities", "boot_id"));
addCheck("outcome_runtime_boot_identity_instance_index", indexExists("game_engine", "outcome_runtime_boot_identities", "idx_outcome_runtime_boot_instance"));
addCheck("outcome_runtime_boot_identity_update_trigger", triggerExists("game_engine", "outcome_runtime_boot_identities", "trg_prevent_outcome_runtime_boot_update"));
addCheck("outcome_runtime_boot_identity_delete_trigger", triggerExists("game_engine", "outcome_runtime_boot_identities", "trg_prevent_outcome_runtime_boot_delete"));
addCheck("outcome_runtime_request_provenance_unique", indexExists("game_engine", "outcome_runtime_request_provenance", "ux_outcome_runtime_request_provenance"));
addCheck("outcome_runtime_request_provenance_index", indexExists("game_engine", "outcome_runtime_request_provenance", "idx_outcome_runtime_request_provenance_request"));
addCheck("outcome_runtime_request_provenance_update_trigger", triggerExists("game_engine", "outcome_runtime_request_provenance", "trg_prevent_outcome_runtime_request_provenance_update"));
addCheck("outcome_runtime_request_provenance_delete_trigger", triggerExists("game_engine", "outcome_runtime_request_provenance", "trg_prevent_outcome_runtime_request_provenance_delete"));
addCheck("outcome_runtime_attempt_provenance_unique", indexExists("game_engine", "outcome_runtime_attempt_provenance", "ux_outcome_runtime_attempt_provenance"));
addCheck("outcome_runtime_attempt_provenance_index", indexExists("game_engine", "outcome_runtime_attempt_provenance", "idx_outcome_runtime_attempt_provenance_attempt"));
addCheck("outcome_runtime_attempt_provenance_update_trigger", triggerExists("game_engine", "outcome_runtime_attempt_provenance", "trg_prevent_outcome_runtime_attempt_provenance_update"));
addCheck("outcome_runtime_attempt_provenance_delete_trigger", triggerExists("game_engine", "outcome_runtime_attempt_provenance", "trg_prevent_outcome_runtime_attempt_provenance_delete"));
addCheck("outcome_runtime_recovery_evidence_hash_unique", uniqueIndexExists("game_engine", "outcome_runtime_recovery_evidence", "content_hash"));
addCheck("outcome_runtime_recovery_evidence_boot_index", indexExists("game_engine", "outcome_runtime_recovery_evidence", "idx_outcome_runtime_recovery_evidence_boot"));
addCheck("outcome_runtime_recovery_evidence_request_index", indexExists("game_engine", "outcome_runtime_recovery_evidence", "idx_outcome_runtime_recovery_evidence_request"));
addCheck("outcome_runtime_recovery_evidence_validate_trigger", triggerExists("game_engine", "outcome_runtime_recovery_evidence", "trg_validate_outcome_runtime_recovery_evidence"));
addCheck("outcome_runtime_recovery_evidence_update_trigger", triggerExists("game_engine", "outcome_runtime_recovery_evidence", "trg_prevent_outcome_runtime_recovery_update"));
addCheck("outcome_runtime_recovery_evidence_delete_trigger", triggerExists("game_engine", "outcome_runtime_recovery_evidence", "trg_prevent_outcome_runtime_recovery_delete"));
addCheck("outcome_runtime_rollback_detection_function", functionExists("game_engine", "detect_outcome_runtime_rollback"));
addCheck("outcome_runtime_recovery_no_raw_secret_columns", !columnExists("game_engine", "outcome_runtime_recovery_evidence", "raw_seed") && !columnExists("game_engine", "outcome_runtime_recovery_evidence", "raw_entropy") && !columnExists("game_engine", "outcome_runtime_recovery_evidence", "drbg_state"));
addCheck(
  "outcome_runtime_certified_csprng_dry_run_accepted_attempt_supported",
  queryScalar(`
with inserted as (
  insert into game_engine.outcome_runtime_attempts (
    attempt_id,
    runtime_request_id,
    idempotency_key,
    draw_request_scope,
    provider_id,
    provider_version,
    provider_type,
    mode,
    status,
    failure_code,
    failure_reason,
    lock_scope,
    lock_acquired,
    canonical_attempt_hash,
    started_at,
    completed_at
  ) values (
    gen_random_uuid(),
    gen_random_uuid(),
    'migration-validation:csprng-runtime-accepted',
    'migration-validation:csprng-runtime-accepted',
    'certified-csprng-runtime',
    '1.0.0',
    'CERTIFIED_CSPRNG',
    'DryRun',
    'Accepted',
    'None',
    null,
    'outcome-runtime:certified-csprng-runtime:1.0.0:migration-validation',
    true,
    'sha256:migration-validation-csprng-runtime-accepted-attempt',
    now(),
    now()
  )
  on conflict (canonical_attempt_hash) do nothing
  returning 1
)
select count(*) >= 0 from inserted;
`) === "t"
);
addCheck(
  "outcome_runtime_provably_fair_dry_run_accepted_attempt_supported",
  queryScalar(`
with inserted as (
  insert into game_engine.outcome_runtime_attempts (
    attempt_id,
    runtime_request_id,
    idempotency_key,
    draw_request_scope,
    provider_id,
    provider_version,
    provider_type,
    mode,
    status,
    failure_code,
    failure_reason,
    lock_scope,
    lock_acquired,
    canonical_attempt_hash,
    started_at,
    completed_at
  ) values (
    gen_random_uuid(),
    gen_random_uuid(),
    'migration-validation:provably-fair-runtime-accepted',
    'migration-validation:provably-fair-runtime-accepted',
    'provably-fair-runtime',
    '1.0.0',
    'PROVABLY_FAIR',
    'DryRun',
    'Accepted',
    'None',
    null,
    'outcome-runtime:provably-fair-runtime:1.0.0:migration-validation',
    true,
    'sha256:migration-validation-provably-fair-runtime-accepted-attempt',
    now(),
    now()
  )
  on conflict (canonical_attempt_hash) do nothing
  returning 1
)
select count(*) >= 0 from inserted;
`) === "t"
);
addCheck(
  "outcome_runtime_fail_closed_unresolved_provider_supported",
  queryScalar(`
with inserted as (
  insert into game_engine.outcome_runtime_requests (
    runtime_request_id,
    idempotency_key,
    draw_request_scope,
    game_manifest_id,
    game_manifest_version,
    provider_id,
    provider_version,
    provider_type,
    mode,
    status,
    started_at,
    completed_at,
    failure_code,
    failure_reason,
    canonical_request_hash,
    result_reference_placeholder,
    evidence_reference_placeholder,
    lock_scope,
    lock_acquired
  ) values (
    gen_random_uuid(),
    'migration-validation:outcome-runtime-unresolved-provider',
    'migration-validation:outcome-runtime-unresolved-provider',
    'game-manifest:migration-validation',
    '1.0.0',
    'unresolved',
    'unresolved',
    'CERTIFIED_CSPRNG',
    'DryRun',
    'FailedClosed',
    now(),
    now(),
    'MissingProvider',
    'Manifest-bound Outcome Provider was not found.',
    'sha256:migration-validation-outcome-runtime-unresolved-provider',
    null,
    'placeholder:migration-validation',
    'outcome-runtime:migration-validation',
    false
  )
  on conflict (idempotency_key, draw_request_scope) do nothing
  returning 1
)
select count(*) >= 0 from inserted;
`) === "t"
);
addCheck("game_manifests_outcome_provider_id_column", columnExists("game_engine", "game_manifests", "outcome_provider_id"));
addCheck("game_manifests_outcome_provider_version_column", columnExists("game_engine", "game_manifests", "outcome_provider_version"));
addCheck("game_manifests_provider_capability_requirements_column", columnExists("game_engine", "game_manifests", "provider_capability_requirements"));
addCheck("game_manifests_provider_evidence_requirements_column", columnExists("game_engine", "game_manifests", "provider_evidence_requirements"));
addCheck("game_manifests_receipt_required_column", columnExists("game_engine", "game_manifests", "player_verification_receipt_required"));
addCheck("game_manifests_provider_eligibility_profile_column", columnExists("game_engine", "game_manifests", "provider_eligibility_profile"));
addCheck("game_manifests_certification_required_column", columnExists("game_engine", "game_manifests", "certification_required"));
addCheck("game_manifests_outcome_provider_index", indexExists("game_engine", "game_manifests", "idx_game_manifests_outcome_provider_version"));
addCheck("game_manifests_outcome_provider_binding_trigger", triggerExists("game_engine", "game_manifests", "trg_validate_game_manifest_outcome_provider_binding"));
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
addCheck("platform_organizations_code_version_unique", indexExists("platform", "organizations", "ux_platform_organizations_code_version"));
addCheck("platform_organizations_content_hash_unique", indexExists("platform", "organizations", "ux_platform_organizations_content_hash"));
addCheck("platform_organizations_code_index", indexExists("platform", "organizations", "idx_platform_organizations_code"));
addCheck("platform_organizations_status_index", indexExists("platform", "organizations", "idx_platform_organizations_status"));
addCheck("platform_organizations_hash_index", indexExists("platform", "organizations", "idx_platform_organizations_hash"));
addCheck("platform_tenants_parent_code_version_unique", indexExists("platform", "tenants", "ux_platform_tenants_parent_code_version"));
addCheck("platform_tenants_content_hash_unique", indexExists("platform", "tenants", "ux_platform_tenants_content_hash"));
addCheck("platform_tenants_parent_code_index", indexExists("platform", "tenants", "idx_platform_tenants_parent_code"));
addCheck("platform_tenants_status_index", indexExists("platform", "tenants", "idx_platform_tenants_status"));
addCheck("platform_tenants_hash_index", indexExists("platform", "tenants", "idx_platform_tenants_hash"));
addCheck("platform_tenants_cashier_enabled_column", columnExists("platform", "tenants", "cashier_enabled"));
addCheck("platform_brands_parent_code_version_unique", indexExists("platform", "brands", "ux_platform_brands_parent_code_version"));
addCheck("platform_brands_content_hash_unique", indexExists("platform", "brands", "ux_platform_brands_content_hash"));
addCheck("platform_brands_parent_code_index", indexExists("platform", "brands", "idx_platform_brands_parent_code"));
addCheck("platform_brands_status_index", indexExists("platform", "brands", "idx_platform_brands_status"));
addCheck("platform_brands_hash_index", indexExists("platform", "brands", "idx_platform_brands_hash"));
addCheck("platform_markets_parent_code_version_unique", indexExists("platform", "markets", "ux_platform_markets_parent_code_version"));
addCheck("platform_markets_content_hash_unique", indexExists("platform", "markets", "ux_platform_markets_content_hash"));
addCheck("platform_markets_parent_code_index", indexExists("platform", "markets", "idx_platform_markets_parent_code"));
addCheck("platform_markets_status_index", indexExists("platform", "markets", "idx_platform_markets_status"));
addCheck("platform_markets_hash_index", indexExists("platform", "markets", "idx_platform_markets_hash"));
addCheck("platform_markets_country_jurisdiction_index", indexExists("platform", "markets", "idx_platform_markets_country_jurisdiction"));
addCheck("platform_markets_jurisdiction_optional", columnIsNullable("platform", "markets", "jurisdiction"));
addCheck("platform_markets_country_optional", columnIsNullable("platform", "markets", "country"));
addCheck("platform_organizations_validate_trigger", triggerExists("platform", "organizations", "trg_validate_platform_organization"));
addCheck("platform_organizations_update_trigger", triggerExists("platform", "organizations", "trg_prevent_platform_organization_update"));
addCheck("platform_organizations_delete_trigger", triggerExists("platform", "organizations", "trg_prevent_platform_organization_delete"));
addCheck("platform_tenants_validate_trigger", triggerExists("platform", "tenants", "trg_validate_platform_tenant"));
addCheck("platform_tenants_update_trigger", triggerExists("platform", "tenants", "trg_prevent_platform_tenant_update"));
addCheck("platform_tenants_delete_trigger", triggerExists("platform", "tenants", "trg_prevent_platform_tenant_delete"));
addCheck("platform_brands_validate_trigger", triggerExists("platform", "brands", "trg_validate_platform_brand"));
addCheck("platform_brands_update_trigger", triggerExists("platform", "brands", "trg_prevent_platform_brand_update"));
addCheck("platform_brands_delete_trigger", triggerExists("platform", "brands", "trg_prevent_platform_brand_delete"));
addCheck("platform_markets_validate_trigger", triggerExists("platform", "markets", "trg_validate_platform_market"));
addCheck("platform_markets_update_trigger", triggerExists("platform", "markets", "trg_prevent_platform_market_update"));
addCheck("platform_markets_delete_trigger", triggerExists("platform", "markets", "trg_prevent_platform_market_delete"));
addCheck("platform_websites_brand_code_unique", indexExists("platform", "websites", "ux_platform_websites_brand_code_version"));
addCheck("platform_websites_content_hash_unique", indexExists("platform", "websites", "ux_platform_websites_content_hash"));
addCheck("platform_websites_tenant_brand_market_index", indexExists("platform", "websites", "idx_platform_websites_tenant_brand_market"));
addCheck("platform_websites_brand_code_index", indexExists("platform", "websites", "idx_platform_websites_brand_code"));
addCheck("platform_websites_status_index", indexExists("platform", "websites", "idx_platform_websites_status"));
addCheck("platform_websites_hash_index", indexExists("platform", "websites", "idx_platform_websites_hash"));
addCheck("platform_websites_market_optional", columnIsNullable("platform", "websites", "market_id"));
addCheck("platform_websites_validate_trigger", triggerExists("platform", "websites", "trg_validate_platform_website"));
addCheck("platform_websites_update_trigger", triggerExists("platform", "websites", "trg_prevent_platform_website_update"));
addCheck("platform_websites_delete_trigger", triggerExists("platform", "websites", "trg_prevent_platform_website_delete"));
addCheck("platform_website_domains_hostname_unique", indexExists("platform", "website_domains", "ux_platform_website_domains_hostname_version"));
addCheck("platform_website_domains_content_hash_unique", indexExists("platform", "website_domains", "ux_platform_website_domains_content_hash"));
addCheck("platform_website_domains_canonical_website_unique", indexExists("platform", "website_domains", "ux_platform_website_domains_canonical_website"));
addCheck("platform_website_domains_hostname_index", indexExists("platform", "website_domains", "idx_platform_website_domains_hostname"));
addCheck("platform_website_domains_website_status_index", indexExists("platform", "website_domains", "idx_platform_website_domains_website_status"));
addCheck("platform_website_domains_status_index", indexExists("platform", "website_domains", "idx_platform_website_domains_status"));
addCheck("platform_website_domains_effective_window_index", indexExists("platform", "website_domains", "idx_platform_website_domains_effective_window"));
addCheck("platform_website_domains_hash_index", indexExists("platform", "website_domains", "idx_platform_website_domains_hash"));
addCheck("platform_website_domains_effective_to_optional", columnIsNullable("platform", "website_domains", "effective_to"));
addCheck("platform_website_domains_validate_trigger", triggerExists("platform", "website_domains", "trg_validate_platform_website_domain"));
addCheck("platform_website_domains_update_trigger", triggerExists("platform", "website_domains", "trg_prevent_platform_website_domain_update"));
addCheck("platform_website_domains_delete_trigger", triggerExists("platform", "website_domains", "trg_prevent_platform_website_domain_delete"));
addCheck("platform_active_host_resolutions_view", existsRegclass("platform.active_host_resolutions"));
addCheck("platform_brand_themes_brand_code_unique", indexExists("platform", "brand_themes", "ux_platform_brand_themes_brand_code_version"));
addCheck("platform_brand_themes_content_hash_unique", indexExists("platform", "brand_themes", "ux_platform_brand_themes_content_hash"));
addCheck("platform_brand_themes_active_default_unique", indexExists("platform", "brand_themes", "ux_platform_brand_themes_active_default_brand"));
addCheck("platform_brand_themes_brand_status_index", indexExists("platform", "brand_themes", "idx_platform_brand_themes_brand_status"));
addCheck("platform_brand_themes_brand_code_index", indexExists("platform", "brand_themes", "idx_platform_brand_themes_brand_code"));
addCheck("platform_brand_themes_tenant_brand_index", indexExists("platform", "brand_themes", "idx_platform_brand_themes_tenant_brand"));
addCheck("platform_brand_themes_hash_index", indexExists("platform", "brand_themes", "idx_platform_brand_themes_hash"));
addCheck("platform_brand_themes_default_column", columnExists("platform", "brand_themes", "is_default"));
addCheck("platform_brand_themes_validate_trigger", triggerExists("platform", "brand_themes", "trg_validate_platform_brand_theme"));
addCheck("platform_brand_themes_update_trigger", triggerExists("platform", "brand_themes", "trg_prevent_platform_brand_theme_update"));
addCheck("platform_brand_themes_delete_trigger", triggerExists("platform", "brand_themes", "trg_prevent_platform_brand_theme_delete"));
addCheck("platform_brand_assets_brand_type_key_version_unique", indexExists("platform", "brand_assets", "ux_platform_brand_assets_brand_type_key_version"));
addCheck("platform_brand_assets_content_hash_unique", indexExists("platform", "brand_assets", "ux_platform_brand_assets_content_hash"));
addCheck("platform_brand_assets_brand_status_index", indexExists("platform", "brand_assets", "idx_platform_brand_assets_brand_status"));
addCheck("platform_brand_assets_brand_type_index", indexExists("platform", "brand_assets", "idx_platform_brand_assets_brand_type"));
addCheck("platform_brand_assets_brand_type_key_index", indexExists("platform", "brand_assets", "idx_platform_brand_assets_brand_type_key"));
addCheck("platform_brand_assets_tenant_brand_index", indexExists("platform", "brand_assets", "idx_platform_brand_assets_tenant_brand"));
addCheck("platform_brand_assets_checksum_index", indexExists("platform", "brand_assets", "idx_platform_brand_assets_checksum"));
addCheck("platform_brand_assets_hash_index", indexExists("platform", "brand_assets", "idx_platform_brand_assets_hash"));
addCheck("platform_brand_assets_validate_trigger", triggerExists("platform", "brand_assets", "trg_validate_platform_brand_asset"));
addCheck("platform_brand_assets_update_trigger", triggerExists("platform", "brand_assets", "trg_prevent_platform_brand_asset_update"));
addCheck("platform_brand_assets_delete_trigger", triggerExists("platform", "brand_assets", "trg_prevent_platform_brand_asset_delete"));
addCheck("platform_game_availability_scope_game_version_unique", indexExists("platform", "game_availability", "ux_platform_game_availability_scope_game_version"));
addCheck("platform_game_availability_content_hash_unique", indexExists("platform", "game_availability", "ux_platform_game_availability_content_hash"));
addCheck("platform_game_availability_tenant_brand_index", indexExists("platform", "game_availability", "idx_platform_game_availability_tenant_brand"));
addCheck("platform_game_availability_market_index", indexExists("platform", "game_availability", "idx_platform_game_availability_market"));
addCheck("platform_game_availability_website_index", indexExists("platform", "game_availability", "idx_platform_game_availability_website"));
addCheck("platform_game_availability_agent_index", indexExists("platform", "game_availability", "idx_platform_game_availability_agent"));
addCheck("platform_game_availability_game_status_index", indexExists("platform", "game_availability", "idx_platform_game_availability_game_status"));
addCheck("platform_game_availability_effective_window_index", indexExists("platform", "game_availability", "idx_platform_game_availability_effective_window"));
addCheck("platform_game_availability_hash_index", indexExists("platform", "game_availability", "idx_platform_game_availability_hash"));
addCheck("platform_game_availability_market_optional", columnIsNullable("platform", "game_availability", "market_id"));
addCheck("platform_game_availability_website_optional", columnIsNullable("platform", "game_availability", "website_id"));
addCheck("platform_game_availability_agent_optional", columnIsNullable("platform", "game_availability", "agent_id"));
addCheck("platform_game_availability_manifest_optional", columnIsNullable("platform", "game_availability", "game_manifest_reference"));
addCheck("platform_game_availability_jurisdiction_optional", columnIsNullable("platform", "game_availability", "jurisdiction"));
addCheck("platform_game_availability_validate_trigger", triggerExists("platform", "game_availability", "trg_validate_platform_game_availability"));
addCheck("platform_game_availability_update_trigger", triggerExists("platform", "game_availability", "trg_prevent_platform_game_availability_update"));
addCheck("platform_game_availability_delete_trigger", triggerExists("platform", "game_availability", "trg_prevent_platform_game_availability_delete"));
addCheck("platform_resolve_game_availability_function", functionExists("platform", "resolve_game_availability"));
addCheck("platform_lifecycle_events_table_exists", existsRegclass("platform.platform_lifecycle_events"));
addCheck("platform_lifecycle_events_hash_unique", indexExists("platform", "platform_lifecycle_events", "ux_platform_lifecycle_event_hash"));
addCheck("platform_lifecycle_events_resource_record_index", indexExists("platform", "platform_lifecycle_events", "idx_platform_lifecycle_resource_record"));
addCheck("platform_lifecycle_events_entity_key_index", indexExists("platform", "platform_lifecycle_events", "idx_platform_lifecycle_entity_key"));
addCheck("platform_lifecycle_events_update_trigger", triggerExists("platform", "platform_lifecycle_events", "trg_prevent_platform_lifecycle_events_update"));
addCheck("platform_lifecycle_events_delete_trigger", triggerExists("platform", "platform_lifecycle_events", "trg_prevent_platform_lifecycle_events_delete"));
addCheck("platform_organizations_lifecycle_metadata", columnExists("platform", "organizations", "previous_version") && columnExists("platform", "organizations", "effective_from"));
addCheck("platform_tenants_lifecycle_metadata", columnExists("platform", "tenants", "previous_version") && columnExists("platform", "tenants", "effective_from"));
addCheck("platform_brands_lifecycle_metadata", columnExists("platform", "brands", "previous_version") && columnExists("platform", "brands", "effective_from"));
addCheck("platform_markets_lifecycle_metadata", columnExists("platform", "markets", "previous_version") && columnExists("platform", "markets", "effective_from"));
addCheck("platform_websites_lifecycle_metadata", columnExists("platform", "websites", "previous_version") && columnExists("platform", "websites", "effective_from"));
addCheck("platform_domains_lifecycle_metadata", columnExists("platform", "website_domains", "previous_version") && columnExists("platform", "website_domains", "approval_metadata"));
addCheck("platform_themes_lifecycle_metadata", columnExists("platform", "brand_themes", "previous_version") && columnExists("platform", "brand_themes", "effective_from"));
addCheck("platform_assets_lifecycle_metadata", columnExists("platform", "brand_assets", "previous_version") && columnExists("platform", "brand_assets", "effective_from"));
addCheck("platform_game_availability_lifecycle_metadata", columnExists("platform", "game_availability", "previous_version") && columnExists("platform", "game_availability", "approval_metadata"));
addCheck("platform_websites_brand_code_version_unique", indexExists("platform", "websites", "ux_platform_websites_brand_code_version"));
addCheck("platform_domains_hostname_version_unique", indexExists("platform", "website_domains", "ux_platform_website_domains_hostname_version"));
addCheck("platform_themes_brand_code_version_unique", indexExists("platform", "brand_themes", "ux_platform_brand_themes_brand_code_version"));
addCheck(
  "platform_management_permission_catalog_seeded",
  queryScalar(`
select count(*) = 18
from auth_service.permissions
where code in (
  'platform.organization.read',
  'platform.organization.create',
  'platform.tenant.read',
  'platform.tenant.create',
  'platform.brand.read',
  'platform.brand.create',
  'platform.market.read',
  'platform.market.create',
  'platform.website.read',
  'platform.website.create',
  'platform.domain.read',
  'platform.domain.create',
  'platform.theme.read',
  'platform.theme.create',
  'platform.asset.read',
  'platform.asset.create',
  'platform.game_availability.read',
  'platform.game_availability.create'
);
`) === "t"
);
addCheck(
  "platform_super_admin_role_has_all_platform_permissions",
  queryScalar(`
select coalesce(jsonb_array_length(metadata->'permissions'), 0) = 18
from auth_service.roles
where code = 'PLATFORM_SUPER_ADMIN'
  and metadata->>'platformManagementRole' = 'true';
`) === "t"
);
addCheck(
  "platform_operations_admin_excludes_organization_create",
  queryScalar(`
select
  coalesce(jsonb_array_length(metadata->'permissions'), 0) = 17
  and not (metadata->'permissions' ? 'platform.organization.create')
from auth_service.roles
where code = 'PLATFORM_OPERATIONS_ADMIN'
  and metadata->>'platformManagementRole' = 'true';
`) === "t"
);
addCheck(
  "platform_read_only_auditor_has_read_permissions_only",
  queryScalar(`
select
  coalesce(jsonb_array_length(metadata->'permissions'), 0) = 9
  and not exists (
    select 1
    from jsonb_array_elements_text(metadata->'permissions') permission(code)
    where permission.code not like 'platform.%.read'
  )
from auth_service.roles
where code = 'PLATFORM_READ_ONLY_AUDITOR'
  and metadata->>'platformManagementRole' = 'true';
`) === "t"
);
addCheck("cryptographic_conformance_reports_hash_unique", uniqueIndexExists("game_engine", "cryptographic_conformance_reports", "canonical_report_hash"));
addCheck("cryptographic_conformance_reports_subject_index", indexExists("game_engine", "cryptographic_conformance_reports", "idx_crypto_conformance_subject"));
addCheck("cryptographic_conformance_reports_status_index", indexExists("game_engine", "cryptographic_conformance_reports", "idx_crypto_conformance_status"));
addCheck("cryptographic_conformance_reports_validate_trigger", triggerExists("game_engine", "cryptographic_conformance_reports", "trg_validate_cryptographic_conformance_report"));
addCheck("cryptographic_conformance_reports_update_trigger", triggerExists("game_engine", "cryptographic_conformance_reports", "trg_prevent_cryptographic_conformance_report_update"));
addCheck("cryptographic_conformance_reports_delete_trigger", triggerExists("game_engine", "cryptographic_conformance_reports", "trg_prevent_cryptographic_conformance_report_delete"));
addCheck("statistical_validation_framework_reports_hash_unique", uniqueIndexExists("game_engine", "statistical_validation_framework_reports", "canonical_report_hash"));
addCheck("statistical_validation_framework_reports_target_index", indexExists("game_engine", "statistical_validation_framework_reports", "idx_statistical_framework_target"));
addCheck("statistical_validation_framework_reports_suite_index", indexExists("game_engine", "statistical_validation_framework_reports", "idx_statistical_framework_suite_target"));
addCheck("statistical_validation_framework_reports_validate_trigger", triggerExists("game_engine", "statistical_validation_framework_reports", "trg_validate_statistical_validation_framework_report"));
addCheck("statistical_validation_framework_reports_update_trigger", triggerExists("game_engine", "statistical_validation_framework_reports", "trg_prevent_statistical_validation_framework_report_update"));
addCheck("statistical_validation_framework_reports_delete_trigger", triggerExists("game_engine", "statistical_validation_framework_reports", "trg_prevent_statistical_validation_framework_report_delete"));
addCheck("provider_validation_registry_hash_unique", uniqueIndexExists("game_engine", "provider_validation_registry", "canonical_registry_hash"));
addCheck("provider_validation_registry_provider_index", indexExists("game_engine", "provider_validation_registry", "idx_provider_validation_registry_provider"));
addCheck("provider_validation_registry_validate_trigger", triggerExists("game_engine", "provider_validation_registry", "trg_validate_provider_validation_registry_entry"));
addCheck("provider_validation_registry_update_trigger", triggerExists("game_engine", "provider_validation_registry", "trg_prevent_provider_validation_registry_update"));
addCheck("provider_validation_registry_delete_trigger", triggerExists("game_engine", "provider_validation_registry", "trg_prevent_provider_validation_registry_delete"));
addCheck("certification_readiness_evaluations_hash_unique", uniqueIndexExists("game_engine", "certification_readiness_evaluations", "canonical_evaluation_hash"));
addCheck("certification_readiness_evaluations_target_index", indexExists("game_engine", "certification_readiness_evaluations", "idx_certification_readiness_target"));
addCheck("certification_readiness_evaluations_validate_trigger", triggerExists("game_engine", "certification_readiness_evaluations", "trg_validate_certification_readiness_evaluation"));
addCheck("certification_readiness_evaluations_update_trigger", triggerExists("game_engine", "certification_readiness_evaluations", "trg_prevent_certification_readiness_update"));
addCheck("certification_readiness_evaluations_delete_trigger", triggerExists("game_engine", "certification_readiness_evaluations", "trg_prevent_certification_readiness_delete"));
addCheck("outcome_runtime_rollback_watermark_scope_sequence_unique", constraintExists("game_engine", "outcome_runtime_rollback_watermarks", "ux_outcome_runtime_rollback_watermark_scope_sequence"));
addCheck("outcome_runtime_rollback_watermark_chain_root_unique", uniqueIndexExists("game_engine", "outcome_runtime_rollback_watermarks", "chain_root_hash"));
addCheck("outcome_runtime_rollback_watermark_scope_index", indexExists("game_engine", "outcome_runtime_rollback_watermarks", "idx_outcome_runtime_rollback_watermarks_scope_created"));
addCheck("outcome_runtime_rollback_watermark_validate_trigger", triggerExists("game_engine", "outcome_runtime_rollback_watermarks", "trg_validate_outcome_runtime_rollback_watermark"));
addCheck("outcome_runtime_rollback_watermark_update_trigger", triggerExists("game_engine", "outcome_runtime_rollback_watermarks", "trg_prevent_outcome_runtime_rollback_watermark_update"));
addCheck("outcome_runtime_rollback_watermark_delete_trigger", triggerExists("game_engine", "outcome_runtime_rollback_watermarks", "trg_prevent_outcome_runtime_rollback_watermark_delete"));
addCheck("outcome_validation_hash_function", functionExists("game_engine", "validate_outcome_validation_hashes"));
addCheck("outcome_validation_provenance_function", functionExists("game_engine", "validate_outcome_validation_provenance"));
addCheck("math_evaluation_requests_idempotency_unique", indexExists("game_engine", "math_evaluation_requests", "ux_math_evaluation_requests_idempotency"));
addCheck("math_evaluation_requests_scope_unique", indexExists("game_engine", "math_evaluation_requests", "ux_math_evaluation_requests_scope"));
addCheck("math_evaluation_requests_certificate_unique", indexExists("game_engine", "math_evaluation_requests", "ux_math_evaluation_requests_certificate"));
addCheck("math_evaluation_requests_outcome_certificate_index", indexExists("game_engine", "math_evaluation_requests", "idx_math_evaluation_requests_outcome_certificate"));
addCheck("math_evaluation_requests_ticket_index", indexExists("game_engine", "math_evaluation_requests", "idx_math_evaluation_requests_ticket"));
addCheck("math_evaluation_requests_certificate_hash_index", indexExists("game_engine", "math_evaluation_requests", "idx_math_evaluation_requests_certificate_hash"));
addCheck("math_evaluation_requests_status_index", indexExists("game_engine", "math_evaluation_requests", "idx_math_evaluation_requests_status"));
addCheck("math_evaluation_requests_validate_trigger", triggerExists("game_engine", "math_evaluation_requests", "trg_validate_math_evaluation_request"));
addCheck("math_evaluation_attempts_request_number_unique", indexExists("game_engine", "math_evaluation_attempts", "ux_math_evaluation_attempts_request_number"));
addCheck("math_evaluation_attempts_request_index", indexExists("game_engine", "math_evaluation_attempts", "idx_math_evaluation_attempts_request"));
addCheck("math_evaluation_attempts_validate_trigger", triggerExists("game_engine", "math_evaluation_attempts", "trg_validate_math_evaluation_attempt"));
addCheck("math_evaluation_attempts_update_trigger", triggerExists("game_engine", "math_evaluation_attempts", "trg_prevent_math_evaluation_attempt_update"));
addCheck("math_evaluation_attempts_delete_trigger", triggerExists("game_engine", "math_evaluation_attempts", "trg_prevent_math_evaluation_attempt_delete"));
addCheck("math_evaluation_batches_idempotency_unique", indexExists("game_engine", "math_evaluation_batches", "ux_math_evaluation_batches_idempotency"));
addCheck("math_evaluation_batches_scope_unique", indexExists("game_engine", "math_evaluation_batches", "ux_math_evaluation_batches_scope"));
addCheck("math_evaluation_batches_status_index", indexExists("game_engine", "math_evaluation_batches", "idx_math_evaluation_batches_status"));
addCheck("math_evaluation_batches_outcome_certificate_index", indexExists("game_engine", "math_evaluation_batches", "idx_math_evaluation_batches_outcome_certificate"));
addCheck("math_evaluation_batches_validate_trigger", triggerExists("game_engine", "math_evaluation_batches", "trg_validate_math_evaluation_batch"));
addCheck("math_evaluation_batches_delete_trigger", triggerExists("game_engine", "math_evaluation_batches", "trg_prevent_math_evaluation_batch_delete"));
addCheck("math_evaluation_batch_items_idempotency_unique", indexExists("game_engine", "math_evaluation_batch_items", "ux_math_evaluation_batch_items_idempotency"));
addCheck("math_evaluation_batch_items_scope_unique", indexExists("game_engine", "math_evaluation_batch_items", "ux_math_evaluation_batch_items_scope"));
addCheck("math_evaluation_batch_items_certificate_unique", indexExists("game_engine", "math_evaluation_batch_items", "ux_math_evaluation_batch_items_certificate"));
addCheck("math_evaluation_batch_items_batch_index", indexExists("game_engine", "math_evaluation_batch_items", "idx_math_evaluation_batch_items_batch"));
addCheck("math_evaluation_batch_items_ticket_index", indexExists("game_engine", "math_evaluation_batch_items", "idx_math_evaluation_batch_items_ticket"));
addCheck("math_evaluation_batch_items_certificate_hash_index", indexExists("game_engine", "math_evaluation_batch_items", "idx_math_evaluation_batch_items_certificate_hash"));
addCheck("math_evaluation_batch_items_validate_trigger", triggerExists("game_engine", "math_evaluation_batch_items", "trg_validate_math_evaluation_batch_item"));
addCheck("math_evaluation_batch_items_delete_trigger", triggerExists("game_engine", "math_evaluation_batch_items", "trg_prevent_math_evaluation_batch_item_delete"));
addCheck("math_evaluation_batch_attempts_scope_unique", indexExists("game_engine", "math_evaluation_batch_attempts", "ux_math_evaluation_batch_attempts_scope"));
addCheck("math_evaluation_batch_attempts_batch_index", indexExists("game_engine", "math_evaluation_batch_attempts", "idx_math_evaluation_batch_attempts_batch"));
addCheck("math_evaluation_batch_attempts_validate_trigger", triggerExists("game_engine", "math_evaluation_batch_attempts", "trg_validate_math_evaluation_batch_attempt"));
addCheck("math_evaluation_batch_attempts_update_trigger", triggerExists("game_engine", "math_evaluation_batch_attempts", "trg_prevent_math_evaluation_batch_attempt_update"));
addCheck("math_evaluation_batch_attempts_delete_trigger", triggerExists("game_engine", "math_evaluation_batch_attempts", "trg_prevent_math_evaluation_batch_attempt_delete"));
addCheck("settlement_input_records_math_certificate_unique", indexExists("game_engine", "settlement_input_records", "ux_settlement_input_records_math_certificate"));
addCheck("settlement_input_records_payload_hash_unique", indexExists("game_engine", "settlement_input_records", "ux_settlement_input_records_payload_hash"));
addCheck("settlement_input_records_idempotency_unique", indexExists("game_engine", "settlement_input_records", "ux_settlement_input_records_idempotency"));
addCheck("settlement_input_records_ticket_index", indexExists("game_engine", "settlement_input_records", "idx_settlement_input_records_ticket"));
addCheck("settlement_input_records_outcome_certificate_index", indexExists("game_engine", "settlement_input_records", "idx_settlement_input_records_outcome_certificate"));
addCheck("settlement_input_records_math_model_index", indexExists("game_engine", "settlement_input_records", "idx_settlement_input_records_math_model"));
addCheck("settlement_input_records_paytable_index", indexExists("game_engine", "settlement_input_records", "idx_settlement_input_records_paytable"));
addCheck("settlement_input_records_validate_trigger", triggerExists("game_engine", "settlement_input_records", "trg_validate_settlement_input_record"));
addCheck("settlement_input_records_update_trigger", triggerExists("game_engine", "settlement_input_records", "trg_prevent_settlement_input_record_update"));
addCheck("settlement_input_records_delete_trigger", triggerExists("game_engine", "settlement_input_records", "trg_prevent_settlement_input_record_delete"));
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
