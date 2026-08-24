begin;

alter table game_engine.game_definition_versions
  add column product_configuration jsonb not null default '{}'::jsonb,
  add column publication_state text not null default 'LEGACY',
  add column activation_state text not null default 'LEGACY',
  add column assignment_state text not null default 'LEGACY',
  add column approval_state text not null default 'LEGACY',
  add column game_manifest_id uuid,
  add column game_manifest_hash text,
  add column math_model_definition_id uuid,
  add column math_model_hash text,
  add column paytable_definition_id uuid,
  add column paytable_hash text,
  add column schedule_version_id uuid,
  add column schedule_hash text,
  add column outcome_provider_id text,
  add column outcome_provider_version text,
  add column provider_configuration_version text,
  add column provider_configuration_hash text,
  add column settlement_policy_version text,
  add column supersedes_version_id uuid,
  add column publication_metadata jsonb not null default '{}'::jsonb;

alter table game_engine.game_definition_versions
  add constraint ck_product_configuration_object
    check (jsonb_typeof(product_configuration) = 'object'),
  add constraint ck_product_publication_metadata_object
    check (jsonb_typeof(publication_metadata) = 'object'),
  add constraint ck_product_publication_state
    check (publication_state in ('LEGACY', 'DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  add constraint ck_product_activation_state
    check (activation_state in ('LEGACY', 'INACTIVE', 'ACTIVE', 'SUSPENDED', 'RETIRED')),
  add constraint ck_product_assignment_state
    check (assignment_state in ('LEGACY', 'UNASSIGNED', 'ASSIGNED')),
  add constraint ck_product_approval_state
    check (approval_state in ('LEGACY', 'INTERNAL_APPROVED', 'EXTERNAL_REVIEW_PENDING', 'EXTERNAL_APPROVED'));

create index idx_game_definition_versions_product_state
  on game_engine.game_definition_versions(publication_state, activation_state, assignment_state);

insert into game_engine.game_modules (
  id, code, display_name, lifecycle_status, active_version_id)
values (
  '12000000-0000-4000-8000-000000000001',
  'KENO_GENERIC',
  'Generic Keno Engine',
  'ACTIVE',
  null)
on conflict (code) do nothing;

insert into game_engine.game_module_versions (
  id, game_module_id, version, sdk_version, manifest_hash, lifecycle_status)
select
  '12000000-0000-4000-8000-000000000002',
  module.id,
  '1.0.0-pilot',
  'game-engine-sdk-1',
  'sha256:' || encode(digest('KENO_GENERIC|1.0.0-pilot|keno-math-evaluator-2', 'sha256'), 'hex'),
  'APPROVED'
from game_engine.game_modules module
where module.code = 'KENO_GENERIC'
on conflict (game_module_id, version) do nothing;

update game_engine.game_modules module
set active_version_id = version.id
from game_engine.game_module_versions version
where module.code = 'KENO_GENERIC'
  and version.game_module_id = module.id
  and version.version = '1.0.0-pilot'
  and module.active_version_id is null;

insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema,
  constraints, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_placeholder, signature_metadata)
values (
  '12000000-0000-4000-8000-000000000003',
  'MOSERA_KENO_20_OF_80_V1',
  '1.0.0',
  '[{"nodeId":"primary-draw","primitiveType":"UniqueNumberSet","minNumber":1,"maxNumber":80,"count":20}]'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object","required":["numbers"]}'::jsonb,
  '{"numberCount":20,"numberRange":{"min":1,"max":80},"unique":true,"ordering":"DRAW_ORDER"}'::jsonb,
  '[]'::jsonb,
  'GovernanceApproved',
  'sha256:' || encode(digest('MOSERA_KENO_20_OF_80_V1|1.0.0|unique:20:1-80', 'sha256'), 'hex'),
  null,
  '{"status":"UNSIGNED_INTERNAL"}'::jsonb)
on conflict (strategy_id, strategy_version) do nothing;

insert into game_engine.game_definitions (id, code, display_name, active_version_id, game_module_id)
select seed.id, seed.code, seed.display_name, null, module.id
from (values
  ('12000000-0000-4000-8000-000000000010'::uuid, 'FAST_KENO_V1', 'Fast Keno'),
  ('12000000-0000-4000-8000-000000000020'::uuid, 'HOT_SPOT_V1', 'Hot Spot')
) seed(id, code, display_name)
join game_engine.game_modules module on module.code = 'KENO_GENERIC'
on conflict (code) do nothing;

insert into game_engine.draw_authorities (
  id, code, display_name, provider_type, status, active_version_id)
values (
  '12000000-0000-4000-8000-000000000030',
  'MOSERA_INTERNAL_CSPRNG',
  'Mosera Internal CSPRNG',
  'InternalProductionPrng',
  'APPROVED',
  null)
on conflict (code) do nothing;

insert into game_engine.draw_authority_versions (
  id, draw_authority_id, version, provider_version, configuration_hash, status)
select
  '12000000-0000-4000-8000-000000000031',
  authority.id,
  '2.0.0-config-2',
  '2.0.0',
  configuration.configuration_hash,
  'APPROVED'
from game_engine.draw_authorities authority
join game_engine.outcome_provider_configuration_versions configuration
  on configuration.provider_id = 'mosera-internal-csprng'
 and configuration.provider_version = '2.0.0'
 and configuration.configuration_version = '2'
where authority.code = 'MOSERA_INTERNAL_CSPRNG'
on conflict (draw_authority_id, version) do nothing;

update game_engine.draw_authorities authority
set active_version_id = version.id
from game_engine.draw_authority_versions version
where authority.code = 'MOSERA_INTERNAL_CSPRNG'
  and version.draw_authority_id = authority.id
  and version.version = '2.0.0-config-2'
  and authority.active_version_id is null;

insert into game_engine.math_model_definitions (
  id, math_model_id, version, game_family_compatibility, supported_wager_schemas,
  expected_rtp, expected_value, volatility_profile, hit_frequency,
  prize_liability_profile, jackpot_contribution_model, rounding_policy,
  currency_minor_unit_policy, jurisdiction_profile_references, lifecycle_state,
  content_hash, certification_binding_state, signature_metadata)
values
(
  '12000000-0000-4000-8000-000000000013',
  'MOSERA_FAST_KENO_MATH_V1',
  '1.0.0',
  '["Keno"]'::jsonb,
  '["KenoBigSmall","KenoOddEven","KenoDragonTiger","KenoUpDown","KenoParlay","KenoElement"]'::jsonb,
  0.97928652,
  -0.02071348,
  'MARKET_SPECIFIC',
  0.50219821,
  '{"basis":"exact-combinatorial-20-of-80","marketRtpStoredInProductConfiguration":true,"combinedTicketPayoutCapMinor":1000000}'::jsonb,
  '{}'::jsonb,
  '{"mode":"HALF_AWAY_FROM_ZERO","precision":"USD_MINOR_UNIT"}'::jsonb,
  '{"currency":"USD","minorUnit":2}'::jsonb,
  '[]'::jsonb,
  'GovernanceApproved',
  'sha256:' || encode(digest('MOSERA_FAST_KENO_MATH_V1|1.0.0|approved-market-odds', 'sha256'), 'hex'),
  'InternalVerified',
  '{"approvalState":"INTERNAL_APPROVED"}'::jsonb
),
(
  '12000000-0000-4000-8000-000000000023',
  'MOSERA_HOT_SPOT_MATH_V1',
  '1.0.0',
  '["Keno"]'::jsonb,
  '["KenoSpot"]'::jsonb,
  0.63884907,
  -0.36115093,
  'SPOT_AND_HIT_SPECIFIC',
  0.25894675,
  '{"basis":"exact-hypergeometric-20-of-80","sourcePaytable":"MOSERA_HOT_SPOT_PAYTABLE_V1","perPlayPayoutCapMinor":5000000}'::jsonb,
  '{}'::jsonb,
  '{"mode":"HALF_AWAY_FROM_ZERO","precision":"USD_MINOR_UNIT"}'::jsonb,
  '{"currency":"USD","minorUnit":2}'::jsonb,
  '[]'::jsonb,
  'GovernanceApproved',
  'sha256:' || encode(digest('MOSERA_HOT_SPOT_MATH_V1|1.0.0|official-source-3843d611', 'sha256'), 'hex'),
  'InternalVerified',
  '{"approvalState":"INTERNAL_APPROVED","externalReview":"PENDING"}'::jsonb
)
on conflict (math_model_id, version) do nothing;

insert into game_engine.paytable_definitions (
  id, paytable_id, version, math_model_id, math_model_version,
  prize_matrix_rows, bonus_side_bet_rows, caps, lifecycle_state,
  content_hash, certification_binding_state, signature_metadata)
values (
  '12000000-0000-4000-8000-000000000014',
  'MOSERA_FAST_KENO_PAYTABLE_V1',
  '1.0.0',
  'MOSERA_FAST_KENO_MATH_V1',
  '1.0.0',
  '[
    {"rowId":"fast-big","wagerSchema":"KenoBigSmall","prizeCode":"BIG","multiplier":1.95,"payoutValue":0,"conditions":{"selection":"BIG"}},
    {"rowId":"fast-small","wagerSchema":"KenoBigSmall","prizeCode":"SMALL","multiplier":1.95,"payoutValue":0,"conditions":{"selection":"SMALL"}},
    {"rowId":"fast-odd","wagerSchema":"KenoOddEven","prizeCode":"ODD","multiplier":1.95,"payoutValue":0,"conditions":{"selection":"ODD"}},
    {"rowId":"fast-even","wagerSchema":"KenoOddEven","prizeCode":"EVEN","multiplier":1.95,"payoutValue":0,"conditions":{"selection":"EVEN"}},
    {"rowId":"fast-dragon","wagerSchema":"KenoDragonTiger","prizeCode":"DRAGON","multiplier":1.95,"payoutValue":0,"conditions":{"selection":"DRAGON"}},
    {"rowId":"fast-tiger","wagerSchema":"KenoDragonTiger","prizeCode":"TIGER","multiplier":1.95,"payoutValue":0,"conditions":{"selection":"TIGER"}},
    {"rowId":"fast-dt-tie","wagerSchema":"KenoDragonTiger","prizeCode":"DT_TIE","multiplier":9.00,"payoutValue":0,"conditions":{"selection":"DT_TIE"}},
    {"rowId":"fast-up","wagerSchema":"KenoUpDown","prizeCode":"UP","multiplier":2.30,"payoutValue":0,"conditions":{"selection":"UP"}},
    {"rowId":"fast-down","wagerSchema":"KenoUpDown","prizeCode":"DOWN","multiplier":2.30,"payoutValue":0,"conditions":{"selection":"DOWN"}},
    {"rowId":"fast-ud-tie","wagerSchema":"KenoUpDown","prizeCode":"UD_TIE","multiplier":4.30,"payoutValue":0,"conditions":{"selection":"UD_TIE"}},
    {"rowId":"fast-big-odd","wagerSchema":"KenoParlay","prizeCode":"BIG_ODD","multiplier":3.70,"payoutValue":0,"conditions":{"selection":"BIG_ODD"}},
    {"rowId":"fast-big-even","wagerSchema":"KenoParlay","prizeCode":"BIG_EVEN","multiplier":3.70,"payoutValue":0,"conditions":{"selection":"BIG_EVEN"}},
    {"rowId":"fast-small-odd","wagerSchema":"KenoParlay","prizeCode":"SMALL_ODD","multiplier":3.70,"payoutValue":0,"conditions":{"selection":"SMALL_ODD"}},
    {"rowId":"fast-small-even","wagerSchema":"KenoParlay","prizeCode":"SMALL_EVEN","multiplier":3.70,"payoutValue":0,"conditions":{"selection":"SMALL_EVEN"}},
    {"rowId":"fast-gold","wagerSchema":"KenoElement","prizeCode":"GOLD","multiplier":9.20,"payoutValue":0,"conditions":{"selection":"GOLD"}},
    {"rowId":"fast-wood","wagerSchema":"KenoElement","prizeCode":"WOOD","multiplier":4.60,"payoutValue":0,"conditions":{"selection":"WOOD"}},
    {"rowId":"fast-water","wagerSchema":"KenoElement","prizeCode":"WATER","multiplier":2.40,"payoutValue":0,"conditions":{"selection":"WATER"}},
    {"rowId":"fast-fire","wagerSchema":"KenoElement","prizeCode":"FIRE","multiplier":4.60,"payoutValue":0,"conditions":{"selection":"FIRE"}},
    {"rowId":"fast-earth","wagerSchema":"KenoElement","prizeCode":"EARTH","multiplier":9.20,"payoutValue":0,"conditions":{"selection":"EARTH"}}
  ]'::jsonb,
  '[]'::jsonb,
  '{"combinedTicketPayoutCapMinor":1000000,"capScope":"TICKET_DRAW"}'::jsonb,
  'GovernanceApproved',
  'sha256:' || encode(digest('MOSERA_FAST_KENO_PAYTABLE_V1|1.0.0|approved-2026-08-23', 'sha256'), 'hex'),
  'InternalVerified',
  '{"approvalState":"INTERNAL_APPROVED"}'::jsonb
)
on conflict (paytable_id, version) do nothing;

with source as (
  select '{
    "sourceArtifact":"mosera-hot-spot-official-paytable-source.zip",
    "sourceSha256":"sha256:3843d61146af35100872178b5100a6b527e4f88add112398d81bd0b0edf8fe62",
    "sourceEffectiveDate":"",
    "sourceEffectiveDateNote":"Not stated in the supplied screenshots; screenshots were captured 2026-08-21.",
    "currency":"USD","unitStakeMinor":100,"promotional":false,
    "rows":[
      {"spotCount":1,"hotSpotOnlyByHits":[0,200],"combinedBullseyeByHits":[0,5400]},
      {"spotCount":2,"hotSpotOnlyByHits":[0,0,1000],"combinedBullseyeByHits":[0,1500,7000]},
      {"spotCount":3,"hotSpotOnlyByHits":[0,0,200,2500],"combinedBullseyeByHits":[0,600,2000,15500]},
      {"spotCount":4,"hotSpotOnlyByHits":[0,0,100,400,7800],"combinedBullseyeByHits":[0,400,1100,3700,30000]},
      {"spotCount":5,"hotSpotOnlyByHits":[0,0,0,200,1500,43500],"combinedBullseyeByHits":[0,300,600,1600,8000,100000]},
      {"spotCount":6,"hotSpotOnlyByHits":[0,0,0,100,600,6700,90000],"combinedBullseyeByHits":[0,500,200,700,4000,25000,200000]},
      {"spotCount":7,"hotSpotOnlyByHits":[0,0,0,100,300,1200,19000,200000],"combinedBullseyeByHits":[0,500,200,300,2000,6800,57500,1000000]},
      {"spotCount":8,"hotSpotOnlyByHits":[100,0,0,0,0,1200,8000,55000,1000000],"combinedBullseyeByHits":[100,500,200,200,700,5000,20000,130000,3000000]},
      {"spotCount":9,"hotSpotOnlyByHits":[100,0,0,0,0,600,3000,13500,275000,3000000],"combinedBullseyeByHits":[100,500,200,200,500,2000,9000,47500,600000,6500000]},
      {"spotCount":10,"hotSpotOnlyByHits":[200,0,0,0,0,300,1700,4200,57500,500000,10000000],"combinedBullseyeByHits":[200,500,200,200,200,900,6000,21500,140000,1500000,30000000]}
    ]}'::jsonb payload
), expanded as (
  select
    (spot->>'spotCount')::integer spot_count,
    hit_index - 1 hit_count,
    ((spot->'hotSpotOnlyByHits'->>(hit_index - 1))::numeric / 100) base_payout,
    ((spot->'combinedBullseyeByHits'->>(hit_index - 1))::numeric / 100) combined_payout
  from source,
  lateral jsonb_array_elements(payload->'rows') spot,
  lateral generate_series(1, jsonb_array_length(spot->'hotSpotOnlyByHits')) hit_index
), rows as (
  select jsonb_agg(row_value order by row_value->>'rowId') rows
  from (
    select jsonb_build_object(
      'rowId', format('hot-spot-%s-%s-base', spot_count, hit_count),
      'wagerSchema', 'KenoSpot', 'prizeCode', format('HOT_SPOT_%s_%s', spot_count, hit_count),
      'multiplier', base_payout, 'payoutValue', 0, 'maxPayout', 50000,
      'conditions', jsonb_build_object('spotCount', spot_count, 'hitCount', hit_count,
        'bullseyePurchased', false, 'bullseyeMatch', false,
        'basePayoutPerUnit', base_payout, 'combinedPayoutPerUnit', base_payout)
    ) row_value from expanded where base_payout > 0
    union all
    select jsonb_build_object(
      'rowId', format('hot-spot-%s-%s-bullseye-miss', spot_count, hit_count),
      'wagerSchema', 'KenoSpot', 'prizeCode', format('HOT_SPOT_%s_%s', spot_count, hit_count),
      'multiplier', base_payout / 2, 'payoutValue', 0, 'maxPayout', 50000,
      'conditions', jsonb_build_object('spotCount', spot_count, 'hitCount', hit_count,
        'bullseyePurchased', true, 'bullseyeMatch', false,
        'basePayoutPerUnit', base_payout, 'combinedPayoutPerUnit', base_payout)
    ) row_value from expanded where base_payout > 0
    union all
    select jsonb_build_object(
      'rowId', format('hot-spot-%s-%s-bullseye-hit', spot_count, hit_count),
      'wagerSchema', 'KenoSpot', 'prizeCode', format('HOT_SPOT_BULLSEYE_%s_%s', spot_count, hit_count),
      'multiplier', combined_payout / 2, 'payoutValue', 0, 'maxPayout', 50000,
      'conditions', jsonb_build_object('spotCount', spot_count, 'hitCount', hit_count,
        'bullseyePurchased', true, 'bullseyeMatch', true,
        'basePayoutPerUnit', base_payout, 'combinedPayoutPerUnit', combined_payout)
    ) row_value from expanded where combined_payout > 0
  ) generated
)
insert into game_engine.paytable_definitions (
  id, paytable_id, version, math_model_id, math_model_version,
  prize_matrix_rows, bonus_side_bet_rows, caps, lifecycle_state,
  content_hash, certification_binding_state, signature_metadata)
select
  '12000000-0000-4000-8000-000000000024',
  'MOSERA_HOT_SPOT_PAYTABLE_V1',
  '1.0.0',
  'MOSERA_HOT_SPOT_MATH_V1',
  '1.0.0',
  rows.rows,
  '[]'::jsonb,
  '{"maxPayout":50000,"perPlayPayoutCapMinor":5000000,"capScope":"PLAY_DRAW","combinedPayoutIncludesBase":true}'::jsonb,
  'GovernanceApproved',
  'sha256:8dc01631d3dc22ef7941fa7cb95253d06f9aee038853a62458341b46acdeeeaa',
  'InternalVerified',
  '{"approvalState":"INTERNAL_APPROVED","externalReview":"PENDING","sourceArchiveSha256":"sha256:3843d61146af35100872178b5100a6b527e4f88add112398d81bd0b0edf8fe62","sourceEffectiveDateStatus":"NOT_STATED"}'::jsonb
from rows
on conflict (paytable_id, version) do nothing;

insert into game_engine.game_manifests (
  id, game_id, game_code, game_name, game_family, jurisdiction_bindings,
  wager_schemas, outcome_strategy_references, math_model_references,
  paytable_references, settlement_policy_references, sales_rules,
  cancellation_correction_rules, replay_resettlement_policy,
  certification_pack_reference, regulator_profile, operator_approval_state,
  lifecycle_state, effective_from, semantic_version, content_hash,
  signature_metadata, outcome_provider_id, outcome_provider_version,
  provider_capability_requirements, provider_evidence_requirements,
  player_verification_receipt_required, provider_eligibility_profile,
  certification_required)
select
  seed.manifest_id, definition.id, definition.code, definition.display_name, 'Keno', '[]'::jsonb,
  seed.wager_schemas, '["MOSERA_KENO_20_OF_80_V1:1.0.0"]'::jsonb,
  jsonb_build_array(seed.math_model_reference), jsonb_build_array(seed.paytable_reference),
  '["CANONICAL_SETTLEMENT_V1"]'::jsonb, seed.sales_rules,
  '{"playerCancellation":false,"governedCancellationUntil":"OUTCOME_GENERATION_START","postOutcomeAction":"CORRECTION_REVERSAL_RESETTLEMENT"}'::jsonb,
  '{"deterministicReplay":true,"historicVersionsRequired":true}'::jsonb,
  'none', 'global', 'Approved', 'GovernanceApproved', transaction_timestamp(),
  '1.0.0', seed.manifest_hash,
  '{"approvalState":"INTERNAL_APPROVED","signatureState":"UNSIGNED_INTERNAL"}'::jsonb,
  'mosera-internal-csprng', '2.0.0',
  '{"requiredPrimitives":["UniqueNumberSet","ConstraintValidation"]}'::jsonb,
  '{"generatedBytesHash":true,"healthEvidence":true,"canonicalOutcomeHash":true}'::jsonb,
  false,
  '{"failureMode":"FAIL_CLOSED","silentFallback":false,"configurationVersion":"2"}'::jsonb,
  false
from (values
  ('FAST_KENO_V1', '12000000-0000-4000-8000-000000000012'::uuid,
    '["KenoBigSmall","KenoOddEven","KenoDragonTiger","KenoUpDown","KenoParlay","KenoElement"]'::jsonb,
    'MOSERA_FAST_KENO_MATH_V1:1.0.0', 'MOSERA_FAST_KENO_PAYTABLE_V1:1.0.0',
    '{"cutoffSeconds":5,"maximumWagersPerTicket":20,"spotWageringEnabled":false,"quickPickEnabled":false,"opposingWagersAllowed":true}'::jsonb,
    'sha256:' || encode(digest('FAST_KENO_V1|manifest|1.0.0', 'sha256'), 'hex')),
  ('HOT_SPOT_V1', '12000000-0000-4000-8000-000000000022'::uuid,
    '["KenoSpot"]'::jsonb,
    'MOSERA_HOT_SPOT_MATH_V1:1.0.0', 'MOSERA_HOT_SPOT_PAYTABLE_V1:1.0.0',
    '{"cutoffSeconds":15,"maximumPlaysPerTicket":10,"spotCounts":[1,2,3,4,5,6,7,8,9,10],"quickPickEnabled":true,"bullseyeEnabled":true,"multiDrawCounts":[1,5,10,20]}'::jsonb,
    'sha256:' || encode(digest('HOT_SPOT_V1|manifest|1.0.0', 'sha256'), 'hex'))
) seed(game_code, manifest_id, wager_schemas, math_model_reference, paytable_reference, sales_rules, manifest_hash)
join game_engine.game_definitions definition on definition.code = seed.game_code
on conflict (game_id, semantic_version) do nothing;

insert into game_engine.draw_authority_assignments (
  id, game_definition_id, draw_authority_id, draw_authority_version_id,
  settlement_trigger_policy, effective_from, effective_to)
select seed.assignment_id, definition.id, authority.id, version.id,
  'OnDrawCertification', transaction_timestamp(), null
from (values
  ('FAST_KENO_V1', '12000000-0000-4000-8000-000000000015'::uuid),
  ('HOT_SPOT_V1', '12000000-0000-4000-8000-000000000025'::uuid)
) seed(game_code, assignment_id)
join game_engine.game_definitions definition on definition.code = seed.game_code
join game_engine.draw_authorities authority on authority.code = 'MOSERA_INTERNAL_CSPRNG'
join game_engine.draw_authority_versions version
  on version.draw_authority_id = authority.id and version.version = '2.0.0-config-2'
on conflict (id) do nothing;

insert into game_engine.published_draw_schedule_versions (
  schedule_version_id, schedule_id, version_number, game_definition_id,
  draw_authority_assignment_id, schedule_kind, schedule_configuration,
  time_zone_id, schedule_hash, published_at)
select seed.schedule_version_id, seed.schedule_id, 1, definition.id,
  seed.assignment_id, seed.schedule_kind, seed.configuration,
  'America/New_York', seed.schedule_hash, transaction_timestamp()
from (values
  ('FAST_KENO_V1',
   '12000000-0000-4000-8000-000000000016'::uuid,
   '12000000-0000-4000-8000-000000000017'::uuid,
   '12000000-0000-4000-8000-000000000015'::uuid,
   'FIXED_INTERVAL_SECONDS',
   '{"intervalSeconds":25,"anchorLocalTime":"00:00:00","cutoffSeconds":5,"serviceWindow":"24/7","driftPolicy":"DETERMINISTIC_ANCHOR","persistAs":"UTC","dstPolicy":"IANA_TIME_ZONE_FAIL_CLOSED","schedulerRuntimeEnabled":false,"publicDrawSequence":"PRODUCT_INDEPENDENT"}'::jsonb,
   'sha256:' || encode(digest('FAST_KENO_V1|schedule|1|America/New_York|25|5|00:00:00', 'sha256'), 'hex')),
  ('HOT_SPOT_V1',
   '12000000-0000-4000-8000-000000000026'::uuid,
   '12000000-0000-4000-8000-000000000027'::uuid,
   '12000000-0000-4000-8000-000000000025'::uuid,
   'DAILY_WINDOW_INTERVAL',
   '{"intervalMinutes":4,"firstDrawLocalTime":"06:00:00","finalDrawLocalTime":"02:00:00","cutoffSeconds":15,"closedWindow":{"from":"02:00:00","to":"06:00:00"},"multiDrawCounts":[1,5,10,20],"closedWindowPolicy":"SKIP_AND_RESUME","persistAs":"UTC","dstPolicy":"IANA_TIME_ZONE_FAIL_CLOSED","schedulerRuntimeEnabled":false,"publicDrawSequence":"PRODUCT_INDEPENDENT"}'::jsonb,
   'sha256:' || encode(digest('HOT_SPOT_V1|schedule|1|America/New_York|4|15|06:00:00|02:00:00', 'sha256'), 'hex'))
) seed(game_code, schedule_version_id, schedule_id, assignment_id, schedule_kind, configuration, schedule_hash)
join game_engine.game_definitions definition on definition.code = seed.game_code
on conflict (schedule_id, version_number) do nothing;

with product as (
  select * from (values
    (
      'FAST_KENO_V1', '12000000-0000-4000-8000-000000000011'::uuid,
      '12000000-0000-4000-8000-000000000012'::uuid,
      '12000000-0000-4000-8000-000000000013'::uuid,
      '12000000-0000-4000-8000-000000000014'::uuid,
      '12000000-0000-4000-8000-000000000016'::uuid,
      '{
        "productCode":"FAST_KENO_V1","productVersion":"1.0.0","displayName":"Fast Keno","engineCode":"KENO_GENERIC","engineVersion":"1.0.0-pilot",
        "publicationState":"PUBLISHED","activationState":"INACTIVE","assignmentState":"UNASSIGNED","channels":{"playerWeb":false,"playerMobile":false,"retailPos":false,"externalWageringApi":false},
        "draw":{"numberRange":{"min":1,"max":80},"numbersRequired":20,"unique":true,"providerId":"mosera-internal-csprng","providerVersion":"2.0.0","providerConfigurationVersion":"2"},
        "wagering":{"mode":"DERIVED_ONLY","spotWageringEnabled":false,"quickPickEnabled":false,"maximumWagersPerTicket":20,"opposingWagersAllowed":true,"currency":"USD","minimumStakeMinor":200,
          "markets":[
            {"code":"BIG","rule":"SUM_GTE_811","odds":1.95,"maximumStakeMinor":72000,"theoreticalRtp":0.970713482517},
            {"code":"SMALL","rule":"SUM_LTE_810","odds":1.95,"maximumStakeMinor":72000,"theoreticalRtp":0.979286517481},
            {"code":"ODD","rule":"SUM_ODD","odds":1.95,"maximumStakeMinor":72000,"theoreticalRtp":0.974999999766},
            {"code":"EVEN","rule":"SUM_EVEN","odds":1.95,"maximumStakeMinor":72000,"theoreticalRtp":0.975000000232},
            {"code":"DRAGON","rule":"SECOND_TO_LAST_DIGIT_GT_LAST_DIGIT","odds":1.95,"maximumStakeMinor":72000,"tieRule":"PUSH","theoreticalRtp":0.977499999523},
            {"code":"TIGER","rule":"LAST_DIGIT_GT_SECOND_TO_LAST_DIGIT","odds":1.95,"maximumStakeMinor":72000,"tieRule":"PUSH","theoreticalRtp":0.977500000474},
            {"code":"DT_TIE","rule":"COMPARED_DIGITS_EQUAL","odds":9.00,"maximumStakeMinor":9000,"theoreticalRtp":0.900000000180},
            {"code":"UP","rule":"LOWER_HALF_COUNT_GT_10","odds":2.30,"maximumStakeMinor":55400,"tieRule":"LOSE","theoreticalRtp":0.916270513554},
            {"code":"DOWN","rule":"UPPER_HALF_COUNT_GT_10","odds":2.30,"maximumStakeMinor":55400,"tieRule":"LOSE","theoreticalRtp":0.916270513554},
            {"code":"UD_TIE","rule":"HALVES_EXACTLY_10_10","odds":4.30,"maximumStakeMinor":21800,"theoreticalRtp":0.873945036267},
            {"code":"BIG_ODD","rule":"BIG_AND_ODD","odds":3.70,"maximumStakeMinor":26700,"theoreticalRtp":0.924999999778},
            {"code":"BIG_EVEN","rule":"BIG_AND_EVEN","odds":3.70,"maximumStakeMinor":26700,"theoreticalRtp":0.916866608074},
            {"code":"SMALL_ODD","rule":"SMALL_AND_ODD","odds":3.70,"maximumStakeMinor":26700,"theoreticalRtp":0.924999999778},
            {"code":"SMALL_EVEN","rule":"SMALL_AND_EVEN","odds":3.70,"maximumStakeMinor":26700,"theoreticalRtp":0.933133392366},
            {"code":"GOLD","rule":"SUM_210_695","odds":9.20,"maximumStakeMinor":8800,"theoreticalRtp":0.943140823968},
            {"code":"WOOD","rule":"SUM_696_763","odds":4.60,"maximumStakeMinor":20000,"theoreticalRtp":0.927027133167},
            {"code":"WATER","rule":"SUM_764_855","odds":2.40,"maximumStakeMinor":51400,"theoreticalRtp":0.931296911268},
            {"code":"FIRE","rule":"SUM_856_923","odds":4.60,"maximumStakeMinor":20000,"theoreticalRtp":0.935602860042},
            {"code":"EARTH","rule":"SUM_924_1410","odds":9.20,"maximumStakeMinor":8800,"theoreticalRtp":0.961627696394}
          ],"combinedTicketPayoutCapMinor":1000000},
        "schedule":{"scheduleVersion":"1","timeZone":"America/New_York","intervalSeconds":25,"anchorLocalTime":"00:00:00","cutoffSeconds":5,"serviceWindow":"24/7","publicDrawSequence":"PRODUCT_INDEPENDENT","schedulerRuntimeEnabled":false},
        "ticket":{"oneDrawOnly":true,"rebetCopiesOnly":true,"explicitConfirmationRequired":true,"recentResultCount":50,"playerHistoryDays":90},
        "funding":{"reservation":"FULL_ATOMIC_UPFRONT","partialAcceptance":false},"suspension":{"newAcceptanceStops":true,"acceptedWagersRemainValid":true},
        "settlement":{"policyVersion":"CANONICAL_SETTLEMENT_V1","authoritativeResultRequired":true,"combinedTicketCapApplied":true},"jurisdictionProfiles":[],"certificationRequired":false
      }'::jsonb
    ),
    (
      'HOT_SPOT_V1', '12000000-0000-4000-8000-000000000021'::uuid,
      '12000000-0000-4000-8000-000000000022'::uuid,
      '12000000-0000-4000-8000-000000000023'::uuid,
      '12000000-0000-4000-8000-000000000024'::uuid,
      '12000000-0000-4000-8000-000000000026'::uuid,
      '{
        "productCode":"HOT_SPOT_V1","productVersion":"1.0.0","displayName":"Hot Spot","engineCode":"KENO_GENERIC","engineVersion":"1.0.0-pilot",
        "publicationState":"PUBLISHED","activationState":"INACTIVE","assignmentState":"UNASSIGNED","channels":{"playerWeb":false,"playerMobile":false,"retailPos":false,"externalWageringApi":false},
        "draw":{"numberRange":{"min":1,"max":80},"numbersRequired":20,"unique":true,"providerId":"mosera-internal-csprng","providerVersion":"2.0.0","providerConfigurationVersion":"2","bullseye":{"enabled":true,"designation":"ONE_OF_DRAWN_20","rngDomain":"HOT_SPOT_BULLSEYE_V1","evidence":"IMMUTABLE"}},
        "wagering":{"mode":"TRADITIONAL_SPOT","spotCounts":[1,2,3,4,5,6,7,8,9,10],"quickPick":{"enabled":true,"unique":true,"persistSelection":true,"reuseAcrossMultiDraw":true,"rngDomain":"HOT_SPOT_QUICK_PICK_V1"},"baseStakeMinor":{"min":100,"max":2000},"bullseye":{"optionalAttachedAddOn":true,"standalone":false,"equalBaseStake":true,"combinedPayoutIncludesBase":true},"maximumPlaysPerTicket":10,"multiDrawCounts":[1,5,10,20],"fullUpfrontReservation":true,"perPlayPayoutCapMinor":5000000},
        "schedule":{"scheduleVersion":"1","timeZone":"America/New_York","intervalMinutes":4,"firstDrawLocalTime":"06:00:00","finalDrawLocalTime":"02:00:00","cutoffSeconds":15,"closedWindow":{"from":"02:00:00","to":"06:00:00"},"closedWindowPolicy":"SKIP_AND_RESUME","publicDrawSequence":"PRODUCT_INDEPENDENT","schedulerRuntimeEnabled":false},
        "ticket":{"rebetCopiesOnly":true,"explicitConfirmationRequired":true,"recentResultCount":20,"playerHistoryDays":90,"futureUndrawnCancellationOnly":true},
        "resultContract":{"winningNumberCount":20,"bullseyeDistinguished":true,"matchingNumbers":true,"matchCount":true,"basePrizeComponent":true,"bullseyeSupplementalComponent":true,"finalCombinedPayoutAfterCap":true},
        "funding":{"reservation":"FULL_ATOMIC_UPFRONT","partialAcceptance":false},"suspension":{"newAcceptanceStops":true,"acceptedAndFutureFundedWagersRemainValid":true},
        "settlement":{"policyVersion":"CANONICAL_SETTLEMENT_V1","authoritativeResultRequired":true,"perPlayCapApplied":true},"jurisdictionProfiles":[],"certificationRequired":false
      }'::jsonb
    )
  ) value(game_code, version_id, manifest_id, math_model_id, paytable_id, schedule_version_id, configuration)
), resolved as (
  select product.*, definition.id game_definition_id, manifest.content_hash manifest_hash,
    math.content_hash math_hash, paytable.content_hash paytable_hash,
    schedule.schedule_hash, provider.configuration_hash provider_configuration_hash
  from product
  join game_engine.game_definitions definition on definition.code = product.game_code
  join game_engine.game_manifests manifest on manifest.id = product.manifest_id
  join game_engine.math_model_definitions math on math.id = product.math_model_id
  join game_engine.paytable_definitions paytable on paytable.id = product.paytable_id
  join game_engine.published_draw_schedule_versions schedule on schedule.schedule_version_id = product.schedule_version_id
  join game_engine.outcome_provider_configuration_versions provider
    on provider.provider_id = 'mosera-internal-csprng'
   and provider.provider_version = '2.0.0'
   and provider.configuration_version = '2'
)
insert into game_engine.game_definition_versions (
  id, game_definition_id, version_number, definition_hash, paytable_version,
  evaluator_version, draw_generator_version, effective_from, effective_to,
  outcome_generation_definition, product_configuration, publication_state,
  activation_state, assignment_state, approval_state, game_manifest_id,
  game_manifest_hash, math_model_definition_id, math_model_hash,
  paytable_definition_id, paytable_hash, schedule_version_id, schedule_hash,
  outcome_provider_id, outcome_provider_version, provider_configuration_version,
  provider_configuration_hash, settlement_policy_version, supersedes_version_id,
  publication_metadata)
select
  version_id, game_definition_id, 1,
  'sha256:' || encode(digest(configuration::text, 'sha256'), 'hex'),
  case game_code when 'FAST_KENO_V1' then 'MOSERA_FAST_KENO_PAYTABLE_V1:1.0.0' else 'MOSERA_HOT_SPOT_PAYTABLE_V1:1.0.0' end,
  'keno-math-evaluator-2', 'OUTCOME_PROVIDER_AUTHORITY', transaction_timestamp(), null,
  jsonb_build_object('NumberUniverse', to_jsonb(array(select generate_series(1, 80))),
    'NumbersRequired', 20, 'Unique', true, 'WithReplacement', false, 'Ordering', 'DrawOrder'),
  configuration, 'PUBLISHED', 'INACTIVE', 'UNASSIGNED', 'INTERNAL_APPROVED',
  manifest_id, manifest_hash, math_model_id, math_hash, paytable_id, paytable_hash,
  schedule_version_id, schedule_hash, 'mosera-internal-csprng', '2.0.0', '2',
  provider_configuration_hash, 'CANONICAL_SETTLEMENT_V1', null,
  jsonb_build_object('publishedByRole', 'SUPER_ADMIN', 'source', 'PR-02_APPROVED_SPECIFICATION',
    'availabilityAssignmentCreated', false, 'schedulerRuntimeEnabled', false,
    'externalCertificationState', 'PENDING')
from resolved
on conflict (game_definition_id, version_number) do nothing;

alter table game_engine.game_definition_versions
  add constraint fk_product_version_manifest
    foreign key (game_manifest_id) references game_engine.game_manifests(id) on delete restrict,
  add constraint fk_product_version_math_model
    foreign key (math_model_definition_id) references game_engine.math_model_definitions(id) on delete restrict,
  add constraint fk_product_version_paytable
    foreign key (paytable_definition_id) references game_engine.paytable_definitions(id) on delete restrict,
  add constraint fk_product_version_schedule
    foreign key (schedule_version_id) references game_engine.published_draw_schedule_versions(schedule_version_id) on delete restrict,
  add constraint fk_product_version_provider_configuration
    foreign key (outcome_provider_id, outcome_provider_version, provider_configuration_version)
    references game_engine.outcome_provider_configuration_versions(provider_id, provider_version, configuration_version) on delete restrict,
  add constraint fk_product_version_supersedes
    foreign key (supersedes_version_id) references game_engine.game_definition_versions(id) on delete restrict;

create or replace function game_engine.validate_published_product_version()
returns trigger
language plpgsql
as $$
begin
  if new.publication_state <> 'PUBLISHED' then
    return new;
  end if;

  if new.activation_state <> 'INACTIVE' or new.assignment_state <> 'UNASSIGNED' then
    raise exception 'PR-02 published products must remain INACTIVE and UNASSIGNED';
  end if;
  if new.game_manifest_id is null or new.math_model_definition_id is null
    or new.paytable_definition_id is null or new.schedule_version_id is null
    or new.outcome_provider_id is null or new.provider_configuration_version is null
    or new.settlement_policy_version is null then
    raise exception 'Published product requires exact manifest, math, paytable, schedule, provider, and settlement lineage';
  end if;
  if new.product_configuration->>'publicationState' <> 'PUBLISHED'
    or new.product_configuration->>'activationState' <> 'INACTIVE'
    or new.product_configuration->>'assignmentState' <> 'UNASSIGNED' then
    raise exception 'Published product state columns and immutable configuration disagree';
  end if;
  if not (new.product_configuration ? 'wagering')
    or not (new.product_configuration ? 'draw')
    or not (new.product_configuration ? 'schedule')
    or not (new.product_configuration ? 'settlement') then
    raise exception 'Published product is missing required immutable configuration';
  end if;
  return new;
end;
$$;

create trigger trg_validate_published_product_version
before insert on game_engine.game_definition_versions
for each row execute function game_engine.validate_published_product_version();

create or replace function game_engine.prevent_published_product_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.publication_state = 'PUBLISHED' then
    raise exception 'Published product versions are immutable; create a superseding version';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger trg_prevent_published_product_version_update
before update on game_engine.game_definition_versions
for each row execute function game_engine.prevent_published_product_version_mutation();

create trigger trg_prevent_published_product_version_delete
before delete on game_engine.game_definition_versions
for each row execute function game_engine.prevent_published_product_version_mutation();

comment on column game_engine.game_definition_versions.product_configuration is
  'Immutable product configuration over a reusable engine. Published versions bind exact manifest, math, paytable, schedule, provider configuration, limits, caps, and settlement policy.';

comment on table game_engine.published_draw_schedule_versions is
  'Immutable schedule definitions only. PR-02 schedules are published configuration with schedulerRuntimeEnabled=false; durable scheduler runtime remains PR-03 scope.';

commit;
