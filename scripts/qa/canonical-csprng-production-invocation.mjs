import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";

import {
  canonicalHash,
  createCanonicalOutcomeFixture,
} from "./lib/canonical-outcome-authority-fixture.mjs";

const databaseUrl = process.env.DATABASE_URL
  ?? "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const port = Number(process.env.QA_CANONICAL_CSPRNG_PORT ?? 5591);
const baseUrl = `http://127.0.0.1:${port}`;
const evidenceDirectory = ".qa/csprng-1.1a";
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const checks = [];
const runId = randomUUID();
mkdirSync(evidenceDirectory, { recursive: true });

function check(name, condition, evidence = {}) {
  if (!condition) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  checks.push({ name, status: "PASS", evidence });
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function waitFor(name, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) {
        check(name, true, last);
        return last;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

function run(command, args, environment = {}) {
  console.error(`[csprng-1.1a] start ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  console.error(`[csprng-1.1a] pass ${command} ${args.join(" ")}`);
  return result.stdout;
}

function canonicalSourcePayload(fixture, numbers) {
  return JSON.stringify({
    drawId: fixture.drawId,
    executionManifestId: fixture.manifestId,
    gameDefinitionVersionId: fixture.gameDefinitionVersionId,
    numbers,
    executionSucceeded: true,
  });
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
let service;

async function startService(label) {
  const log = createWriteStream(`${evidenceDirectory}/game-engine-${label}.log`, { flags: "a" });
  service = spawn("dotnet", [
    "run", "--no-build", "--no-launch-profile", "--project",
    "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ASPNETCORE_URLS: baseUrl,
      DEPLOYMENT_ENVIRONMENT: "local",
      OUTCOME_CANONICAL_PIPELINE_ENABLED: "true",
      OUTCOME_LEGACY_PUBLICATION_ENABLED: "false",
      GAME_ENGINE_PRODUCTION_ACTIVATION_ENABLED: "true",
      GAME_ENGINE_PRODUCTION_SIGNING_ENABLED: "true",
      GAME_ENGINE_SIGNING_PROVIDER_ID: "mosera-software-signing",
      GAME_ENGINE_SIGNING_PROVIDER_VERSION: "1.0.0",
      GAME_ENGINE_SIGNING_KEY_VERSION: "key-v1",
      GAME_ENGINE_SIGNING_PUBLIC_KEY_PEM: publicKeyPem,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.pipe(log);
  service.stderr.pipe(log);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) throw new Error(`Game Engine exited with ${service.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Game Engine did not become live.");
}

async function stopService() {
  if (!service || service.exitCode !== null) return;
  service.kill("SIGTERM");
  await Promise.race([once(service, "exit"), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (service.exitCode === null) service.kill("SIGKILL");
}

async function execute(fixture, overrides = {}) {
  const command = {
    drawId: fixture.drawId,
    productReference: "product:csprng-1.1",
    idempotencyKey: `draw-execution:${fixture.drawId}`,
    outcomeCertificateId: null,
    settlementInputId: null,
    correlationId: `csprng-1.1:${fixture.drawId}`,
    causationId: `draw:${fixture.drawId}`,
    auditReference: `audit:${fixture.drawId}`,
    actorReference: "qa:csprng-1.1",
    reasonCode: "SCHEDULED_DRAW_EXECUTION",
    ...overrides,
  };
  const response = await fetch(`${baseUrl}/api/game-engine/draw-executions/${fixture.drawId}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.json();
  return { status: response.status, body, command };
}

async function ensureGameDefinitionFixture() {
  const existing = await pool.query(`
select 1
from game_engine.draw_authority_assignments assignment
join game_engine.game_definitions definition on definition.id=assignment.game_definition_id
join game_engine.game_definition_versions version on version.game_definition_id=definition.id
join game_engine.game_modules module on module.id=definition.game_module_id
join game_engine.game_module_versions module_version on module_version.id=module.active_version_id
where version.outcome_generation_definition is not null
limit 1;
`);
  if (existing.rowCount === 1) return;
  const moduleId = randomUUID();
  const moduleVersionId = randomUUID();
  const definitionId = randomUUID();
  const definitionVersionId = randomUUID();
  const authorityId = randomUUID();
  const authorityVersionId = randomUUID();
  await pool.query(`
insert into game_engine.game_modules (id,code,display_name,lifecycle_status,active_version_id)
values ($1,$2,'Canonical CSPRNG QA Module','ACTIVE',$3);
`, [moduleId, `csprng-qa-module-${runId}`, moduleVersionId]);
  await pool.query(`
insert into game_engine.game_module_versions
  (id,game_module_id,version,sdk_version,manifest_hash,lifecycle_status)
values ($1,$2,'1.0.0','csprng-1.1',$3,'ACTIVE');
`, [moduleVersionId, moduleId, canonicalHash(`csprng-qa-module:${runId}`)]);
  await pool.query(`
insert into game_engine.game_definitions (id,code,display_name,active_version_id,game_module_id)
values ($1,$2,'Canonical CSPRNG QA Game',$3,$4);
`, [definitionId, `csprng-qa-game-${runId}`, definitionVersionId, moduleId]);
  await pool.query(`
insert into game_engine.game_definition_versions (
  id,game_definition_id,version_number,definition_hash,paytable_version,
  evaluator_version,draw_generator_version,effective_from,outcome_generation_definition)
values ($1,$2,1,$3,'qa-paytable','qa-evaluator','internal-csprng:2.0.0',now(),
  '{"NumberUniverse":[2,4,6,8,10],"NumbersRequired":3,"Unique":true,"WithReplacement":false,"Ordering":"Ascending"}'::jsonb);
`, [
    definitionVersionId,
    definitionId,
    canonicalHash(`csprng-qa-definition:${runId}`),
  ]);
  await pool.query(`
insert into game_engine.draw_authorities
  (id,code,display_name,provider_type,status,active_version_id)
values ($1,$2,'Canonical CSPRNG QA Authority','InternalTestPrng','Testing',$3);
`, [authorityId, `csprng-qa-authority-${runId}`, authorityVersionId]);
  await pool.query(`
insert into game_engine.draw_authority_versions
  (id,draw_authority_id,version,provider_version,configuration_hash,status)
values ($1,$2,'1.0.0','2.0.0',$3,'Testing');
`, [authorityVersionId, authorityId, canonicalHash(`csprng-qa-authority:${runId}`)]);
  await pool.query(`
insert into game_engine.draw_authority_assignments
  (id,game_definition_id,draw_authority_id,draw_authority_version_id,settlement_trigger_policy,effective_from)
values ($1,$2,$3,$4,'Manual',now());
`, [randomUUID(), definitionId, authorityId, authorityVersionId]);
}

async function ensureDisposablePlatformScopes() {
  run("npm", ["run", "qa:platform-foundation"], { DATABASE_URL: databaseUrl });
  const scopeCount = Number((await pool.query(`
select count(*)::int count
from platform.markets market
join platform.brands brand on brand.id=market.brand_id
join platform.tenants tenant on tenant.id=brand.tenant_id
join platform.organizations organization on organization.id=tenant.organization_id
join platform.platforms platform on platform.id=organization.platform_id
where market.status='Active' and brand.status='Active' and tenant.status='Active'
  and organization.status='Active' and platform.status='Active';
`)).rows[0].count);
  if (scopeCount >= 2) return;
  const source = (await pool.query(`
select market.brand_id,market.language,market.currency,market.timezone
from platform.markets market
join platform.brands brand on brand.id=market.brand_id
where market.status='Active' and brand.status='Active'
order by market.id limit 1;
`)).rows[0];
  if (!source) throw new Error("Disposable Platform fixture did not create an active market.");
  const suffix = runId.slice(0, 8);
  await pool.query(`
insert into platform.markets (
  id,brand_id,market_code,name,display_name,language,currency,timezone,
  status,version,content_hash,audit_metadata)
values ($1,$2,$3,$4,$4,$5,$6,$7,'Active','1.0.0',$8,$9::jsonb);
`, [
    randomUUID(), source.brand_id, `csprng-scope-${suffix}`, `CSPRNG Scope ${suffix}`,
    source.language, source.currency, source.timezone,
    hash(`csprng-platform-scope:${runId}`), JSON.stringify({ runId, disposable: true }),
  ]);
}

async function loadTicketTemplate() {
  let result = await pool.query(`
select ticket.player_account_id, ticket.player_profile_id, ticket.product_id,
  ticket.manifest_id, ticket.paytable_definition_id, ticket.currency
from ticket_authority.tickets ticket
where exists (
  select 1 from public.financial_wallets wallet
  where wallet.account_id=ticket.player_account_id and wallet.status='ACTIVE'
    and wallet.wallet_type='CREDIT' and wallet.currency_code=ticket.currency)
order by ticket.accepted_at desc limit 1;
`);
  if (!result.rows[0]) {
    run("npm", ["run", "qa:canonical-ticket-lifecycle"], { DATABASE_URL: databaseUrl });
    result = await pool.query(`
select ticket.player_account_id, ticket.player_profile_id, ticket.product_id,
  ticket.manifest_id, ticket.paytable_definition_id, ticket.currency
from ticket_authority.tickets ticket
where exists (
  select 1 from public.financial_wallets wallet
  where wallet.account_id=ticket.player_account_id and wallet.status='ACTIVE'
    and wallet.wallet_type='CREDIT' and wallet.currency_code=ticket.currency)
order by ticket.accepted_at desc limit 1;
`);
  }
  if (!result.rows[0]) throw new Error("Canonical CREDIT ticket template was not found.");
  const template = result.rows[0];
  const version = (await pool.query(`
select id from game_engine.game_definition_versions
where game_definition_id=$1 and outcome_generation_definition is not null
order by version_number desc limit 1;
`, [template.product_id])).rows[0];
  if (!version) throw new Error("Ticket product has no outcome-capable immutable version.");
  return { ...template, qualification_version_id: version.id };
}

async function acceptTicket(template, fixture) {
  const scope = (await pool.query(`
select canonical_tenant_id tenant_id, canonical_brand_id brand_id
from public.accounts where id=$1;
`, [template.player_account_id])).rows[0];
  await pool.query(`
insert into ticket_authority.liability_limit_configurations (
  configuration_id,tenant_id,brand_id,scope_type,scope_reference,
  maximum_wager_minor,maximum_theoretical_payout_minor,maximum_exposure_minor,
  status,effective_from,version,content_hash,audit_metadata)
values ($1,$2,$3,'DRAW',$4,1000000,100000000,100000000,'Active',
  clock_timestamp()-interval '1 millisecond',1,$5,$6::jsonb);
`, [randomUUID(), scope.tenant_id, scope.brand_id, fixture.drawId,
    hash(`csprng-1.1a-liability:${runId}`), JSON.stringify({ runId, authority: "TicketLiabilityAuthority" })]);
  const wallet = (await pool.query(`
select id from public.financial_wallets
where account_id=$1 and wallet_type='CREDIT' and currency_code=$2 and status='ACTIVE'
order by id limit 1;
`, [template.player_account_id, template.currency])).rows[0];
  if (!wallet) throw new Error("Canonical CREDIT wallet was not found.");
  const result = (await pool.query(`
select ticket_authority.accept_ticket(
  $1,$2,'CREDIT',$3,$4,$5,$6,$7,null,$8,$9,$10::jsonb,$11,$12,$13,$14,$15
) result;
`, [
    template.player_account_id, template.player_profile_id, wallet.id,
    template.product_id, template.manifest_id, template.paytable_definition_id,
    fixture.drawId, `csprng-1.1a-${runId}`, template.currency,
    JSON.stringify([{ wagerType: "STRAIGHT", wagerVersion: "1.0.0", selections: [1, 2, 3], stakeMinor: 1 }]),
    `csprng-1.1a-ticket:${runId}`, `csprng-1.1a:${runId}`,
    `draw:${fixture.drawId}`, "qa:csprng-1.1a", "CSPRNG_FULL_CHAIN_QUALIFICATION",
  ])).rows[0].result;
  const item = (await pool.query(`
select item.ticket_item_id,ticket.reservation_id,ticket.accepted_at,ticket.acceptance_hash
from ticket_authority.ticket_items item
join ticket_authority.tickets ticket on ticket.ticket_id=item.ticket_id
where item.ticket_id=$1;
`, [result.ticketId])).rows[0];
  if (!item) throw new Error("Canonical Ticket Authority produced no ticket item.");
  return { ...result, ...item, walletId: wallet.id };
}

async function reactivateDisposableTicketAvailability(template) {
  const suspended = await pool.query(`
select availability.id,availability.version
from platform.game_availability availability
join public.accounts account on account.id=$1
join game_engine.game_definitions definition on definition.id=$2
left join lateral (
  select event.to_status from platform.platform_lifecycle_events event
  where event.resource='game-availability' and event.record_id=availability.id
  order by event.created_at desc,event.event_id desc limit 1
) lifecycle on true
where availability.tenant_id=account.canonical_tenant_id
  and availability.brand_id=account.canonical_brand_id
  and availability.game_code=definition.code
  and (availability.market_id is null or availability.market_id=account.canonical_market_id)
  and (availability.player_account_id is null or availability.player_account_id=account.id)
  and coalesce(lifecycle.to_status,availability.status)='Suspended';
`, [template.player_account_id, template.product_id]);
  for (const availability of suspended.rows) {
    const eventId = randomUUID();
    await pool.query(`
insert into platform.platform_lifecycle_events (
  event_id,resource,record_id,entity_key,from_status,to_status,from_version,to_version,
  reason,operator,approval_metadata,event_hash)
values ($1,'game-availability',$2,$3::jsonb,'Suspended','Active',$4,$5,
  'CSPRNG_1_1A_DISPOSABLE_QUALIFICATION','qa:csprng-1.1a',$6::jsonb,$7);
`, [
      eventId, availability.id, JSON.stringify({ availabilityId: availability.id }),
      availability.version, `${availability.version}:csprng:${runId.slice(0, 8)}`,
      JSON.stringify({ runId, disposable: true }), hash(`availability-reactivation:${eventId}`),
    ]);
  }
}

async function ensureTicketMathModel(template) {
  const paytable = (await pool.query(`
select math_model_id,math_model_version
from game_engine.paytable_definitions where id=$1;
`, [template.paytable_definition_id])).rows[0];
  if (!paytable) throw new Error("Ticket paytable definition was not found.");
  const existing = await pool.query(`
select 1 from game_engine.math_model_definitions
where math_model_id=$1 and version=$2;
`, [paytable.math_model_id, paytable.math_model_version]);
  if (existing.rowCount === 1) return;
  await pool.query(`
insert into game_engine.math_model_definitions (
  id,math_model_id,version,game_family_compatibility,supported_wager_schemas,
  expected_rtp,expected_value,volatility_profile,hit_frequency,
  prize_liability_profile,jackpot_contribution_model,rounding_policy,
  currency_minor_unit_policy,jurisdiction_profile_references,lifecycle_state,
  content_hash,certification_binding_state,signature_metadata)
values ($1,$2,$3,'["NumberDraw"]'::jsonb,'["STRAIGHT"]'::jsonb,
  0.5,0.5,'Qualification',0.5,'{}'::jsonb,'{}'::jsonb,
  '{"mode":"HalfUp"}'::jsonb,'{"minorUnits":2}'::jsonb,'[]'::jsonb,
  'GovernanceApproved',$4,'InternalVerified',$5::jsonb);
`, [
    randomUUID(), paytable.math_model_id, paytable.math_model_version,
    hash(`csprng-1.1a-math-model:${paytable.math_model_id}:${paytable.math_model_version}`),
    JSON.stringify({ authority: "MathAuthority", qualification: "CSPRNG-1.1A" }),
  ]);
}

async function createMathEvaluationAndSettlementInput(template, fixture, certificate, ticket) {
  const paytable = (await pool.query(`
select paytable_id,version,content_hash,math_model_id,math_model_version
from game_engine.paytable_definitions where id=$1;
`, [template.paytable_definition_id])).rows[0];
  if (!paytable) throw new Error("Ticket paytable definition was not found.");
  const mathModel = (await pool.query(`
select content_hash from game_engine.math_model_definitions
where math_model_id=$1 and version=$2;
`, [paytable.math_model_id, paytable.math_model_version])).rows[0];
  if (!mathModel) throw new Error("Ticket math model definition was not found.");

  const evaluationId = randomUUID();
  const mathCertificateId = randomUUID();
  const settlementInputId = randomUUID();
  const ticketReference = ticket.ticket_item_id;
  const prizeFacts = { outcome: "Win", prizeTier: "CSPRNG_1_1A", payoutUnits: 1, multiplier: 2 };
  const prizeFactsJson = (await pool.query("select $1::jsonb::text value", [JSON.stringify(prizeFacts)])).rows[0].value;
  const prizeFactsHash = canonicalHash(prizeFactsJson);
  const manifestReference = `manifest:${fixture.manifestId}`;
  await pool.query(`
insert into game_engine.math_evaluation_events (
  math_evaluation_id,request_id,outcome_certificate_id,outcome_certificate_hash,
  game_manifest_reference,math_model_id,math_model_version,math_model_hash,
  paytable_id,paytable_version,paytable_hash,ticket_reference,wager_payload,
  prize_facts,canonical_prize_facts_hash,idempotency_key,evaluation_mode,evaluated_at)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,'DryRun',now());
`, [
    evaluationId, randomUUID(), certificate.certificateId, certificate.generatedHash,
    manifestReference, paytable.math_model_id, paytable.math_model_version, mathModel.content_hash,
    paytable.paytable_id, paytable.version, paytable.content_hash, ticketReference,
    JSON.stringify({ ticketId: ticket.ticketId, selections: [1, 2, 3], stakeMinor: 1 }),
    prizeFactsJson, prizeFactsHash, `csprng-1.1a-math:${runId}`,
  ]);
  await pool.query(`
insert into game_engine.math_evaluation_certificates (
  certificate_id,math_evaluation_id,outcome_certificate_id,outcome_certificate_hash,
  math_model_id,math_model_version,math_model_hash,paytable_id,paytable_version,
  paytable_hash,ticket_reference,canonical_prize_facts_hash,
  rtp_math_metadata_reference,signing_metadata,issued_at)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now());
`, [
    mathCertificateId, evaluationId, certificate.certificateId, certificate.generatedHash,
    paytable.math_model_id, paytable.math_model_version, mathModel.content_hash,
    paytable.paytable_id, paytable.version, paytable.content_hash, ticketReference,
    prizeFactsHash, `math-model:${paytable.math_model_id}:${paytable.math_model_version}`,
    JSON.stringify({ authority: "MathAuthority", qualification: "CSPRNG-1.1A" }),
  ]);
  const canonicalPayload = (await pool.query("select $1::jsonb::text value", [JSON.stringify({
    mathEvaluationCertificateHash: prizeFactsHash,
    prizeFactsHash,
    ticketReference,
  })])).rows[0].value;
  const canonicalPayloadHash = canonicalHash(canonicalPayload);
  await pool.query(`
insert into game_engine.settlement_input_records (
  settlement_input_id,math_evaluation_certificate_id,math_evaluation_certificate_hash,
  outcome_certificate_id,outcome_certificate_hash,ticket_reference,game_manifest_id,
  game_manifest_version,game_manifest_hash,math_model_id,math_model_version,math_model_hash,
  paytable_id,paytable_version,paytable_hash,evaluator_version,evaluation_outcome,prize_tier,
  prize_facts,prize_facts_hash,payout_units,multiplier,replay_hash,idempotency_key,
  issued_at,provenance,canonical_payload,canonical_payload_hash)
values ($1,$2,$3,$4,$5,$6,$7,'1.0.0',$8,$9,$10,$11,$12,$13,$14,$15,
  'Win','CSPRNG_1_1A',$16::jsonb,$3,1,2,$17,$18,now(),$19::jsonb,$20::jsonb,$21);
`, [
    settlementInputId, mathCertificateId, prizeFactsHash, certificate.certificateId,
    certificate.generatedHash, ticketReference, template.manifest_id,
    hash(`manifest:${template.manifest_id}`), paytable.math_model_id,
    paytable.math_model_version, mathModel.content_hash, paytable.paytable_id,
    paytable.version, paytable.content_hash, fixture.evaluatorVersion, prizeFactsJson,
    hash(`csprng-1.1a-replay:${runId}`), `csprng-1.1a-settlement-input:${runId}`,
    JSON.stringify({ authority: "MathAuthority", qualification: "CSPRNG-1.1A" }),
    canonicalPayload, canonicalPayloadHash,
  ]);
  return { settlementInputId, mathCertificateId, evaluationId, prizeFactsHash, canonicalPayloadHash };
}

async function waitForFinancialCompletion(settlementRequestId, ticketId) {
  return waitFor("CSPRNG draw reaches financial completion and compensation eligibility", async () => {
    const result = await pool.query(`
select record.settlement_id,
  (select attempt.attempt_id from settlement_service.financial_instruction_execution_attempts attempt
   where attempt.settlement_id=record.settlement_id and attempt.target_service='ledger-service'
     and attempt.status in ('Posted','Skipped') order by attempt.created_at limit 1) ledger_request_id,
  (select attempt.attempt_id from settlement_service.financial_instruction_execution_attempts attempt
   where attempt.settlement_id=record.settlement_id and attempt.target_service='credit-wallet-service'
     and attempt.status in ('Posted','Skipped') order by attempt.created_at limit 1) wallet_request_id,
  (select completion.completion_id from ticket_completion_authority.completion_evidence completion
   where completion.ticket_id=$2 order by completion.completed_at limit 1) completion_id,
  (select count(*)::int from ticket_authority.ticket_lifecycle_events event
   where event.ticket_id=$2 and event.command_type='MarkCommissionEligible') commission_events,
  (select count(*)::int from ticket_authority.ticket_lifecycle_events event
   where event.ticket_id=$2 and event.command_type='MarkRebateEligible') rebate_events,
  (select lifecycle_state from ticket_authority.tickets where ticket_id=$2) lifecycle_state
from settlement_service.authoritative_settlement_records record
where record.settlement_request_id=$1;
`, [settlementRequestId, ticketId]);
    const row = result.rows[0];
    return row?.ledger_request_id && row?.wallet_request_id && row?.completion_id &&
      row.commission_events === 1 && row.rebate_events === 1 && row.lifecycle_state === "REBATE_ELIGIBLE"
      ? row : null;
  }, 180_000);
}

async function persistProductionCertificate(fixture, generatedHash) {
  const evidence = (await pool.query(`
select provider_evidence_payload, result_hash
from game_engine.outcome_provider_execution_evidence
where execution_manifest_id=$1 and status='GENERATED';
`, [fixture.manifestId])).rows[0];
  if (!evidence) throw new Error("Generated CSPRNG evidence was not found.");
  const providerEvidence = evidence.provider_evidence_payload;
  const numbers = providerEvidence.generatedNumbers ?? providerEvidence.GeneratedNumbers;
  const payload = canonicalSourcePayload(fixture, numbers);
  check("generated payload hash binds exact CSPRNG values", canonicalHash(payload) === generatedHash, {
    generatedHash, numbers,
  });

  const strategyId = `csprng-strategy:${runId}`;
  const rngProviderId = `csprng-rng:${runId}`;
  const rngEvidenceHash = canonicalHash(`rng-evidence:${runId}`);
  const outcomeId = randomUUID();
  const certificateId = randomUUID();
  await pool.query(`
insert into game_engine.outcome_strategy_definitions (
  id,strategy_id,strategy_version,primitive_graph,input_schema,output_schema,
  constraints,jurisdiction_profile_references,lifecycle_state,content_hash,
  certification_binding_placeholder,signature_metadata)
values ($1,$2,'1.0.0',$3::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
  '[]'::jsonb,'GovernanceApproved',$4,null,'{}'::jsonb);
`, [randomUUID(), strategyId, JSON.stringify([{
    nodeId: "numbers",
    primitiveType: "UniqueNumberSet",
    dependsOn: [],
    minNumber: Math.min(...fixture.primaryUniverse),
    maxNumber: Math.max(...fixture.primaryUniverse),
    count: fixture.primary.length,
  }]), canonicalHash(`strategy:${runId}`)]);
  await pool.query(`
insert into game_engine.rng_provider_definitions (
  id,provider_id,provider_version,provider_type,production_eligible,
  certification_state,algorithm_references,entropy_source_metadata,
  health_test_capabilities,failure_mode,content_hash,signature_metadata)
values ($1,$2,'1.0.0','TEST_DETERMINISTIC',false,'InternalVerified',
  '["certificate-adapter-only"]'::jsonb,'{}'::jsonb,'["verified"]'::jsonb,
  'FailClosed',$3,'{}'::jsonb);
`, [randomUUID(), rngProviderId, canonicalHash(`rng:${runId}`)]);
  await pool.query(`
insert into game_engine.rng_provider_evidence (
  evidence_id,provider_id,provider_version,entropy_source_reference,
  health_test_result,known_answer_test_result,continuous_test_result,
  generated_at,canonical_evidence_hash,signing_metadata)
values ($1,$2,'1.0.0','canonical-internal-csprng','Passed','Passed','Passed',now(),$3,'{}'::jsonb);
`, [randomUUID(), rngProviderId, rngEvidenceHash]);
  await pool.query(`
insert into game_engine.outcome_events (
  outcome_id,request_id,draw_id,game_manifest_reference,strategy_id,strategy_version,
  rng_provider_id,rng_provider_version,rng_evidence_hash,idempotency_key,outcome_mode,
  outcome_payload,canonical_payload,canonical_outcome_hash,generated_at)
values ($1,$2,$3,$4,$5,'1.0.0',$6,'1.0.0',$7,$8,'DryRun',$9::jsonb,$10,$11,now());
`, [outcomeId, randomUUID(), fixture.drawId, `manifest:${fixture.manifestId}`, strategyId,
    rngProviderId, rngEvidenceHash, `csprng-outcome:${runId}`, payload, payload, generatedHash]);
  await pool.query(`
insert into game_engine.outcome_certificates (
  certificate_id,outcome_id,draw_id,strategy_id,strategy_version,rng_provider_id,
  rng_provider_version,canonical_outcome_hash,evidence_hash_reference,
  previous_certificates,signing_metadata,custody_state,issued_at)
values ($1,$2,$3,$4,'1.0.0',$5,'1.0.0',$6,$7,'[]'::jsonb,
  '{"custody":"external-test-key"}'::jsonb,'Certified',now());
`, [certificateId, outcomeId, fixture.drawId, strategyId, rngProviderId, generatedHash, rngEvidenceHash]);

  const signatureValue = sign("sha256", Buffer.from(generatedHash), {
    key: privateKey,
    padding: 1,
  }).toString("base64");
  await pool.query(`
insert into game_engine.certificate_signatures (
  signature_id,certificate_reference_type,certificate_id,provider_id,provider_version,
  algorithm,algorithm_version,canonical_payload_hash,signature_value,
  verification_status,signing_context,issued_at)
values ($1,'OutcomeCertificate',$2,'mosera-software-signing','1.0.0',
  'RSA_SHA256','1',$3,$4,'Verified','Production',now());
`, [randomUUID(), certificateId, generatedHash, signatureValue]);
  return { certificateId, generatedHash, numbers, payload };
}

let previousActiveVersionId = null;
try {
  console.error("[csprng-1.1a] stage fixture prerequisites");
  await ensureGameDefinitionFixture();
  run("npm", ["run", "qa:internal-csprng-provider"], { DATABASE_URL: databaseUrl });
  await ensureDisposablePlatformScopes();
  const template = await loadTicketTemplate();
  await reactivateDisposableTicketAvailability(template);
  await ensureTicketMathModel(template);
  previousActiveVersionId = (await pool.query(
    "select active_version_id from game_engine.game_definitions where id=$1",
    [template.product_id],
  )).rows[0].active_version_id;
  await pool.query("update game_engine.game_definitions set active_version_id=$1 where id=$2", [
    template.qualification_version_id,
    template.product_id,
  ]);
  const past = new Date(Date.now() - 120_000);
  const closeAt = new Date(Date.now() + 2_000);
  const executeAt = new Date(Date.now() + 3_000);
  const fixture = await createCanonicalOutcomeFixture(pool, {
    suffix: `csprng-1.1a:${runId}`,
    category: "INTERNAL_CSPRNG",
    gameDefinitionId: template.product_id,
    requireActiveVersion: true,
    drawStatus: "SalesOpen",
    scheduledAt: executeAt,
    salesCloseAt: closeAt,
    drawAt: executeAt,
  });
  const ticket = await acceptTicket(template, fixture);
  console.error(`[csprng-1.1a] accepted ticket ${ticket.ticketId} for draw ${fixture.drawId}`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, executeAt.getTime() - Date.now() + 250)));
  await pool.query("update game_engine.draw_schedules set status='AwaitingResult' where id=$1", [fixture.drawId]);
  await startService("generation");
  console.error("[csprng-1.1a] stage canonical generation");

  const competing = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    execute(fixture, { idempotencyKey: `competing:${fixture.drawId}:${index}` })));
  check("canonical endpoint invokes Internal CSPRNG", competing.every((item) =>
    item.status === 200 && item.body.data.status === "AwaitingCertification"), {
    statuses: competing.map((item) => item.status),
  });
  const hashes = new Set(competing.map((item) => item.body.data.generatedOutcomeHash));
  const executionIds = new Set(competing.map((item) => item.body.data.providerExecutionId));
  check("concurrent same-draw execution is exactly once", hashes.size === 1 && executionIds.size === 1, {
    hashes: [...hashes], executionIds: [...executionIds],
  });
  const counts = (await pool.query(`
select
  (select count(*)::int from game_engine.outcome_provider_executions where execution_manifest_id=$1) executions,
  (select count(*)::int from game_engine.outcome_provider_execution_evidence where execution_manifest_id=$1 and status='GENERATED') generated,
  (select count(*)::int from game_engine.canonical_outcome_versions where draw_id=$2) publications;
`, [fixture.manifestId, fixture.drawId])).rows[0];
  check("one durable generation exists before certification",
    counts.executions === 1 && counts.generated === 1 && counts.publications === 0, counts);

  const generatedHash = competing[0].body.data.generatedOutcomeHash;
  await stopService();
  const certificate = await persistProductionCertificate(fixture, generatedHash);
  const settlementInput = await createMathEvaluationAndSettlementInput(
    template,
    fixture,
    certificate,
    ticket,
  );
  await startService("resume");
  console.error("[csprng-1.1a] stage publication and settlement");
  const published = await execute(fixture, {
    outcomeCertificateId: certificate.certificateId,
    settlementInputId: settlementInput.settlementInputId,
  });
  check("restart resumes generated evidence and publishes", published.status === 200 &&
    published.body.data.status === "SettlementRequested" &&
    published.body.data.generatedOutcomeHash === generatedHash, published.body);
  const settlementRequestId = published.body.data.settlementRequest?.settlementRequestId;
  check("canonical execution emits settlement.requested", Boolean(settlementRequestId), published.body.data);
  const financialChain = await waitForFinancialCompletion(settlementRequestId, ticket.ticketId);
  console.error(`[csprng-1.1a] financial chain completed ${financialChain.settlement_id}`);
  const retry = await execute(fixture, {
    outcomeCertificateId: certificate.certificateId,
    settlementInputId: settlementInput.settlementInputId,
  });
  check("published draw retry reuses canonical outcome", retry.status === 200 &&
    retry.body.data.outcome.outcomeVersionId === published.body.data.outcome.outcomeVersionId &&
    retry.body.data.settlementRequest.settlementRequestId === settlementRequestId, retry.body);

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const duplicateCounts = (await pool.query(`
select
  (select count(*)::int from settlement_service.authoritative_settlement_records
   where settlement_request_id=$1) settlements,
  (select count(*)::int from settlement_service.financial_instruction_execution_attempts attempt
   join settlement_service.authoritative_settlement_records record on record.settlement_id=attempt.settlement_id
   where record.settlement_request_id=$1 and attempt.target_service='ledger-service'
     and attempt.status in ('Posted','Skipped')) ledger_effects,
  (select count(*)::int from settlement_service.financial_instruction_execution_attempts attempt
   join settlement_service.authoritative_settlement_records record on record.settlement_id=attempt.settlement_id
   where record.settlement_request_id=$1 and attempt.target_service='credit-wallet-service'
     and attempt.status in ('Posted','Skipped')) wallet_effects,
  (select count(*)::int from ticket_completion_authority.completion_evidence
   where ticket_id=$2) completions,
  (select count(*)::int from ticket_authority.ticket_lifecycle_events
   where ticket_id=$2 and command_type='MarkCommissionEligible') commission_events,
  (select count(*)::int from ticket_authority.ticket_lifecycle_events
   where ticket_id=$2 and command_type='MarkRebateEligible') rebate_events;
`, [settlementRequestId, ticket.ticketId])).rows[0];
  check("full-chain retry creates no duplicate financial or compensation effects",
    Object.values(duplicateCounts).every((value) => value === 1), duplicateCounts);

  const unresolved = Number((await pool.query(`
select count(*)::int count
from game_engine.canonical_settlement_event_processing_evidence evidence
where evidence.settlement_request_id=$1
  and evidence.classification in ('GOVERNED_RECOVERY_REQUIRED','TERMINAL_INVALID','LEGACY_UNPROCESSABLE');
`, [settlementRequestId])).rows[0].count);
  const rabbitCredentials = Buffer.from("guest:guest").toString("base64");
  const dlqResponse = await fetch("http://127.0.0.1:15672/api/queues/%2F/lottery.settlement.events.dlq", {
    headers: { authorization: `Basic ${rabbitCredentials}` },
  });
  const dlq = dlqResponse.ok ? await dlqResponse.json() : null;
  check("CSPRNG settlement chain leaves no unresolved processing or DLQ residue",
    unresolved === 0 && (dlq === null || Number(dlq.messages ?? 0) === 0), { unresolved, dlq });

  const finalCounts = (await pool.query(`
select
  (select count(*)::int from game_engine.outcome_provider_executions where execution_manifest_id=$1) executions,
  (select count(*)::int from game_engine.outcome_provider_execution_evidence where execution_manifest_id=$1 and status='GENERATED') generated,
  (select count(*)::int from game_engine.outcome_provider_execution_evidence where execution_manifest_id=$1 and status='AUTHORITATIVE') authoritative,
  (select count(*)::int from game_engine.canonical_outcome_versions where draw_id=$2) publications,
  (select count(*)::int from public.outbox_events where aggregate_id=$3 and event_type='outcome.published') publication_events;
`, [fixture.manifestId, fixture.drawId, published.body.data.outcome.outcomeVersionId.replaceAll("-", "")])).rows[0];
  check("generation, certificate binding, and publication remain singular",
    finalCounts.executions === 1 && finalCounts.generated === 1 &&
    finalCounts.authoritative === 1 && finalCounts.publications === 1, finalCounts);

  const futureFixture = await createCanonicalOutcomeFixture(pool, {
    suffix: `csprng-future:${runId}`,
    category: "INTERNAL_CSPRNG",
    drawStatus: "Scheduled",
    scheduledAt: new Date(Date.now() + 300_000),
  });
  const future = await execute(futureFixture);
  check("scheduled draw before close fence fails closed", future.status === 409, future.body);

  const cancelledFixture = await createCanonicalOutcomeFixture(pool, {
    suffix: `csprng-cancelled:${runId}`,
    category: "INTERNAL_CSPRNG",
    drawStatus: "Cancelled",
    scheduledAt: past,
  });
  const cancelled = await execute(cancelledFixture);
  check("cancelled draw fails closed", cancelled.status === 409, cancelled.body);

  const distinctFixtures = await Promise.all(Array.from({ length: 3 }, (_, index) =>
    createCanonicalOutcomeFixture(pool, {
      suffix: `csprng-distinct-${index}:${runId}`,
      category: "INTERNAL_CSPRNG",
      drawStatus: "AwaitingResult",
      scheduledAt: past,
    })));
  const distinctResults = await Promise.all(distinctFixtures.map((item) => execute(item)));
  check("concurrent distinct draws remain independently exactly once",
    distinctResults.every((item) => item.status === 200 && item.body.data.status === "AwaitingCertification") &&
    new Set(distinctResults.map((item) => item.body.data.providerExecutionId)).size === distinctResults.length,
    { statuses: distinctResults.map((item) => item.status) });
  const distinctCounts = await Promise.all(distinctFixtures.map(async (item) => Number((await pool.query(
    "select count(*)::int count from game_engine.outcome_provider_executions where execution_manifest_id=$1",
    [item.manifestId],
  )).rows[0].count)));
  check("each distinct draw has one durable provider execution",
    distinctCounts.every((count) => count === 1), { distinctCounts });

  for (const category of ["OFFICIAL_RESULTS", "MANUAL_CERTIFIED"]) {
    const external = await createCanonicalOutcomeFixture(pool, {
      suffix: `${category}:${runId}`,
      category,
      drawStatus: "AwaitingResult",
      scheduledAt: past,
    });
    const response = await execute(external);
    const executionCount = Number((await pool.query(
      "select count(*)::int count from game_engine.outcome_provider_executions where execution_manifest_id=$1",
      [external.manifestId],
    )).rows[0].count);
    check(`${category} never falls back to Internal CSPRNG`, response.status === 409 && executionCount === 0, {
      response: response.body, executionCount,
    });
  }

  console.error("[csprng-1.1a] stage evidence write");

  const report = {
    schemaVersion: "mosera.csprng.internal-full-chain.v1",
    status: "CSPRNG_INTERNAL_INTEGRATION_PASS",
    runId,
    invocationOwner: "CanonicalDrawExecutionAuthority",
    provider: fixture.providerId,
    drawId: fixture.drawId,
    executionManifestId: fixture.manifestId,
    generatedOutcomeHash: generatedHash,
    ticketId: ticket.ticketId,
    ticketItemId: ticket.ticket_item_id,
    outcomeVersionId: published.body.data.outcome.outcomeVersionId,
    outcomeCertificateId: certificate.certificateId,
    settlementInputId: settlementInput.settlementInputId,
    mathEvaluationCertificateId: settlementInput.mathCertificateId,
    settlementRequestId,
    settlementId: financialChain.settlement_id,
    ledgerRequestId: financialChain.ledger_request_id,
    walletRequestId: financialChain.wallet_request_id,
    completionId: financialChain.completion_id,
    correlationId: published.command.correlationId,
    causationId: published.command.causationId,
    checks,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(`${evidenceDirectory}/summary.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${evidenceDirectory}/summary.md`, [
    "# Canonical Internal CSPRNG Full Chain",
    "",
    `Status: ${report.status}`,
    `Draw: ${fixture.drawId}`,
    `Manifest: ${fixture.manifestId}`,
    `Outcome hash: ${generatedHash}`,
    `Ticket: ${ticket.ticketId}`,
    `Settlement: ${financialChain.settlement_id}`,
    `Completion: ${financialChain.completion_id}`,
    "",
    ...checks.map((item) => `- PASS: ${item.name}`),
    "",
  ].join("\n"));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stopService();
  if (previousActiveVersionId) {
    const templateProduct = await pool.query(`
select game_definition_id from game_engine.game_definition_versions where id=$1;
`, [previousActiveVersionId]);
    if (templateProduct.rows[0]) {
      await pool.query("update game_engine.game_definitions set active_version_id=$1 where id=$2", [
        previousActiveVersionId,
        templateProduct.rows[0].game_definition_id,
      ]);
    }
  }
  await pool.end();
}
