import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

import {
  appendCertifiedProviderResult,
  canonicalHash,
  createCanonicalOutcomeFixture,
} from "./lib/canonical-outcome-authority-fixture.mjs";

const databaseUrl = process.env.DATABASE_URL
  ?? "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const gameEngineUrl = process.env.QA_GAME_ENGINE_URL ?? "http://127.0.0.1:5500";
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const runId = randomUUID();
const checks = [];

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function check(name, condition, evidence = {}) {
  if (!condition) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  checks.push({ name, status: "PASS", evidence });
}

function command(name, args, environment = {}) {
  const result = spawnSync(name, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function post(path, body) {
  const response = await fetch(`${gameEngineUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(name, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) {
        checks.push({ name, status: "PASS", evidence: last });
        return last;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

async function loadTicketTemplate() {
  let result = await pool.query(`
select ticket.player_account_id, ticket.player_profile_id, ticket.product_id,
  ticket.manifest_id, ticket.paytable_definition_id, ticket.currency
from ticket_authority.tickets ticket
where ticket.status in ('ACCEPTED','AWAITING_DRAW')
  and exists (
    select 1 from public.financial_wallets wallet
    where wallet.account_id=ticket.player_account_id and wallet.status='ACTIVE'
      and wallet.wallet_type='CREDIT' and wallet.currency_code=ticket.currency)
  and exists (
    select 1 from public.financial_wallets wallet
    where wallet.account_id=ticket.player_account_id and wallet.status='ACTIVE'
      and wallet.wallet_type='FREE_PLAY' and wallet.currency_code=ticket.currency)
order by ticket.accepted_at desc
limit 1;
`);
  if (!result.rows[0]) {
    command("npm", ["run", "qa:canonical-ticket-lifecycle"]);
    result = await pool.query(`
select ticket.player_account_id, ticket.player_profile_id, ticket.product_id,
  ticket.manifest_id, ticket.paytable_definition_id, ticket.currency
from ticket_authority.tickets ticket
where exists (
    select 1 from public.financial_wallets wallet
    where wallet.account_id=ticket.player_account_id and wallet.status='ACTIVE'
      and wallet.wallet_type='CREDIT' and wallet.currency_code=ticket.currency)
  and exists (
    select 1 from public.financial_wallets wallet
    where wallet.account_id=ticket.player_account_id and wallet.status='ACTIVE'
      and wallet.wallet_type='FREE_PLAY' and wallet.currency_code=ticket.currency)
order by ticket.accepted_at desc
limit 1;
`);
  }
  if (!result.rows[0]) throw new Error("Canonical ticket template with CREDIT and FREE_PLAY wallets was not found.");
  const template = result.rows[0];
  const version = (await pool.query(`
select id, paytable_version, evaluator_version, draw_generator_version,
  outcome_generation_definition
from game_engine.game_definition_versions
where game_definition_id=$1 and outcome_generation_definition is not null
order by version_number desc limit 1;
`, [template.product_id])).rows[0];
  if (!version) throw new Error("Ticket product has no immutable outcome-capable version.");
  const paytable = (await pool.query(
    "select version from game_engine.paytable_definitions where id=$1",
    [template.paytable_definition_id],
  )).rows[0];
  if (!paytable) throw new Error("Canonical ticket paytable lineage was not found.");
  let qualificationVersionId = version.id;
  if (version.paytable_version !== paytable.version) {
    qualificationVersionId = randomUUID();
    await pool.query(`
insert into game_engine.game_definition_versions (
  id, game_definition_id, version_number, definition_hash, paytable_version,
  evaluator_version, draw_generator_version, effective_from,
  outcome_generation_definition)
select $1, $2, coalesce(max(version_number),0)+1, $3, $4, $5, $6,
  now()-interval '1 millisecond', $7::jsonb
from game_engine.game_definition_versions where game_definition_id=$2;
`, [
      qualificationVersionId,
      template.product_id,
      hash(`rc14-game-definition:${runId}`),
      paytable.version,
      version.evaluator_version,
      version.draw_generator_version,
      JSON.stringify(version.outcome_generation_definition),
    ]);
  }
  return {
    ...template,
    qualification_version_id: qualificationVersionId,
  };
}

async function ensureDisposablePlatformScopes() {
  command("npm", ["run", "qa:platform-foundation"], { DATABASE_URL: databaseUrl });
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
select market.brand_id, market.language, market.currency, market.timezone
from platform.markets market
join platform.brands brand on brand.id=market.brand_id
where market.status='Active' and brand.status='Active'
order by market.id limit 1;
`)).rows[0];
  if (!source) throw new Error("Disposable Platform fixture did not create an active market.");
  const suffix = runId.slice(0, 8);
  await pool.query(`
insert into platform.markets (
  id, brand_id, market_code, name, display_name, language, currency,
  timezone, status, version, content_hash, audit_metadata
) values ($1,$2,$3,$4,$4,$5,$6,$7,'Active','1.0.0',$8,$9::jsonb);
`, [
    randomUUID(), source.brand_id, `rc14-scope-${suffix}`, `RC-1.4 Scope ${suffix}`,
    source.language, source.currency, source.timezone,
    hash(`rc14-platform-scope:${runId}`), JSON.stringify({ runId, authority: "RC-1.4" }),
  ]);
}

async function ensureDisposableGameDefinition() {
  const definitionCount = Number((await pool.query(
    "select count(*)::int count from game_engine.game_definitions where active_version_id is not null",
  )).rows[0].count);
  if (definitionCount === 0) {
    command("npm", ["run", "qa:immutable-draw-authority"], { DATABASE_URL: databaseUrl });
  }
  const outcomeVersionCount = Number((await pool.query(`
select count(*)::int count
from game_engine.game_definition_versions
where outcome_generation_definition is not null;
`)).rows[0].count);
  if (outcomeVersionCount === 0) {
    command("npm", ["run", "qa:internal-csprng-provider"], { DATABASE_URL: databaseUrl });
  }
}

async function reactivateDisposableTicketAvailability(template) {
  const suspended = await pool.query(`
select availability.id, availability.version
from platform.game_availability availability
join public.accounts account on account.id=$1
join game_engine.game_definitions definition on definition.id=$2
left join lateral (
  select event.to_status
  from platform.platform_lifecycle_events event
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
  event_id,resource,record_id,entity_key,from_status,to_status,
  from_version,to_version,reason,operator,approval_metadata,event_hash)
values ($1,'game-availability',$2,$3::jsonb,'Suspended','Active',$4,$5,
  'RC_1_4_DISPOSABLE_QUALIFICATION','qa:canonical-outcome-settlement-invocation',
  $6::jsonb,$7);
`, [
      eventId, availability.id, JSON.stringify({ availabilityId: availability.id }),
      availability.version, `${availability.version}:rc14:${runId.slice(0, 8)}`,
      JSON.stringify({ runId, disposable: true }), hash(`availability-reactivation:${eventId}`),
    ]);
  }
}

async function acceptTicket(template, fixture, fundingInstrument, suffix) {
  const scope = (await pool.query(`
select canonical_tenant_id tenant_id, canonical_brand_id brand_id
from public.accounts where id=$1;
`, [template.player_account_id])).rows[0];
  await pool.query(`
insert into ticket_authority.liability_limit_configurations (
  configuration_id, tenant_id, brand_id, scope_type, scope_reference,
  maximum_wager_minor, maximum_theoretical_payout_minor,
  maximum_exposure_minor, status, effective_from, version,
  content_hash, audit_metadata)
values ($1,$2,$3,'DRAW',$4,1000000,100000000,100000000,'Active',
  clock_timestamp()-interval '1 millisecond',1,$5,$6::jsonb);
`, [
    randomUUID(), scope.tenant_id, scope.brand_id, fixture.drawId,
    hash(`liability:${suffix}`), JSON.stringify({ authority: "TicketLiabilityAuthority", qualification: "RC-1.4" }),
  ]);
  const wallet = (await pool.query(`
select id from public.financial_wallets
where account_id=$1 and wallet_type=$2 and currency_code=$3 and status='ACTIVE'
order by id limit 1;
`, [template.player_account_id, fundingInstrument, template.currency])).rows[0];
  if (!wallet) throw new Error(`${fundingInstrument} wallet was not found.`);

  const result = (await pool.query(`
select ticket_authority.accept_ticket(
  $1,$2,$3,$4,$5,$6,$7,$8,null,$9,$10,$11::jsonb,$12,$13,$14,$15,$16
) result;
`, [
    template.player_account_id,
    template.player_profile_id,
    fundingInstrument,
    wallet.id,
    template.product_id,
    template.manifest_id,
    template.paytable_definition_id,
    fixture.drawId,
    `rc14-${suffix}`,
    template.currency,
    JSON.stringify([{ wagerType: "STRAIGHT", wagerVersion: "1.0.0", selections: [1, 2, 3], stakeMinor: 1 }]),
    `rc14-ticket:${suffix}`,
    `rc14-correlation:${suffix}`,
    `rc14-draw:${fixture.drawId}`,
    "qa:rc-1.4",
    "RC_QUALIFICATION",
  ])).rows[0].result;
  const item = (await pool.query(`
select item.ticket_item_id, item.stake_minor, ticket.reservation_id,
  ticket.accepted_at, ticket.acceptance_hash
from ticket_authority.ticket_items item
join ticket_authority.tickets ticket on ticket.ticket_id=item.ticket_id
where item.ticket_id=$1;
`, [result.ticketId])).rows[0];
  if (!item) {
    throw new Error(`Canonical Ticket Authority produced no ticket item: ${JSON.stringify(result)}`);
  }
  return { ...result, ...item };
}

async function createSettlementInput(template, fixture, outcome, ticket, suffix) {
  const settlementInputId = randomUUID();
  const mathCertificateId = randomUUID();
  const mathHash = hash(`rc14-math:${suffix}`);
  const canonicalPayload = (await pool.query("select $1::jsonb::text value", [JSON.stringify({
    mathEvaluationCertificateHash: mathHash,
    prizeFactsHash: mathHash,
    ticketReference: ticket.ticket_item_id,
  })])).rows[0].value;
  await pool.query(`
insert into game_engine.settlement_input_records (
  settlement_input_id, math_evaluation_certificate_id,
  math_evaluation_certificate_hash, outcome_certificate_id,
  outcome_certificate_hash, ticket_reference, game_manifest_id,
  game_manifest_version, game_manifest_hash, math_model_id, math_model_version,
  math_model_hash, paytable_id, paytable_version, paytable_hash,
  evaluator_version, evaluation_outcome, prize_tier, prize_facts,
  prize_facts_hash, payout_units, multiplier, replay_hash, idempotency_key,
  issued_at, provenance, canonical_payload, canonical_payload_hash)
values ($1,$2,$3,$4,$5,$6,$7,'1.0.0',$8,'math:rc14','1.0.0',$9,
  'paytable:rc14','1.0.0',$10,$11,'Win','RC14',$12::jsonb,$3,1,2,$13,$14,
  now(),'{"authority":"MathAuthority","qualification":"RC-1.4"}'::jsonb,$15::jsonb,$16);
`, [
    settlementInputId, mathCertificateId, mathHash, outcome.certificateId,
    outcome.outcomeHash, ticket.ticket_item_id, template.manifest_id,
    hash(`manifest:${template.manifest_id}`), hash(`math-model:${suffix}`),
    hash(`paytable:${template.paytable_definition_id}`), fixture.evaluatorVersion,
    JSON.stringify({ outcome: "Win", prizeTier: "RC14", payoutUnits: 1, multiplier: 2 }),
    hash(`replay:${suffix}`), `rc14-settlement-input:${suffix}`,
    canonicalPayload, canonicalHash(canonicalPayload),
  ]);
  return { settlementInputId, settlementInputHash: canonicalHash(canonicalPayload) };
}

async function qualifyCombination(template, category, fundingInstrument, { recoverRequest = false } = {}) {
  const suffix = `${runId}:${category.toLowerCase()}:${fundingInstrument.toLowerCase()}`;
  const fixture = await createCanonicalOutcomeFixture(pool, {
    suffix,
    category,
    gameDefinitionId: template.product_id,
    requireActiveVersion: true,
    drawStatus: "SalesOpen",
    scheduledAt: new Date(Date.now() + 11 * 60_000),
  });
  const ticket = await acceptTicket(template, fixture, fundingInstrument, suffix);
  await pool.query("update game_engine.draw_schedules set status='Certified' where id=$1", [fixture.drawId]);
  const outcome = await appendCertifiedProviderResult(pool, fixture);
  const settlementInput = await createSettlementInput(template, fixture, outcome, ticket, suffix);

  const publication = await post("/api/game-engine/outcome-publications", {
    idempotencyKey: `rc14-publication:${suffix}`,
    drawId: fixture.drawId,
    productReference: `rc14:${template.product_id}`,
    engineName: fixture.engineName,
    engineVersion: fixture.engineVersion,
    outcomeCertificateId: outcome.certificateId,
    outcomeCertificateHash: outcome.outcomeHash,
    versionKind: "Published",
    authoritativeSource: "OutcomeCertificate",
    correlationId: `rc14:${suffix}`,
    causationId: `rc14-provider:${outcome.certificateId}`,
    auditReference: `audit:rc14:${suffix}`,
    actorReference: "qa:rc-1.4",
    reasonCode: "RC_QUALIFICATION",
    lifecycleEvidenceHash: hash(`lifecycle:${suffix}`),
  });
  check(`${category}/${fundingInstrument} outcome publication succeeds`, publication.status === 200, publication);

  const outcomeVersionId = publication.body?.data?.outcomeVersionId;
  const before = Number((await pool.query(`
select count(*)::int count from settlement_service.authoritative_settlement_records
where settlement_input_id=$1;
`, [settlementInput.settlementInputId])).rows[0].count);
  check(`${category}/${fundingInstrument} has no pre-created settlement`, before === 0, { before });

  let settlementRequestId;
  if (recoverRequest) {
    const recovered = await waitFor(`${category}/${fundingInstrument} missing request is recovered`, async () => {
      const result = await pool.query(`
select request.settlement_request_id
from game_engine.outcome_settlement_requests request
join game_engine.canonical_outcome_recovery_events recovery
  on recovery.settlement_request_id=request.settlement_request_id
where request.outcome_version_id=$1 and recovery.recovery_action='REQUEST_CREATED';
`, [outcomeVersionId]);
      return result.rows[0] ?? null;
    });
    settlementRequestId = recovered.settlement_request_id;
  } else {
    const request = await post("/api/game-engine/outcome-settlement-requests", {
      idempotencyKey: `rc14-settlement:${suffix}`,
      outcomeVersionId,
      settlementInputId: settlementInput.settlementInputId,
      correlationId: `rc14:${suffix}`,
      causationId: `rc14-publication:${outcomeVersionId}`,
      auditReference: `audit:rc14:settlement:${suffix}`,
    });
    check(`${category}/${fundingInstrument} settlement request succeeds`, request.status === 200, request);
    settlementRequestId = request.body?.data?.settlementRequestId;
  }

  const chain = await waitFor(`${category}/${fundingInstrument} financial chain completes`, async () => {
    const result = await pool.query(`
select record.settlement_id,
  (select count(*)::int from settlement_service.financial_instruction_execution_attempts attempt
    where attempt.settlement_id=record.settlement_id and attempt.target_service='ledger-service'
      and attempt.status in ('Posted','Skipped')) ledger_attempts,
  (select count(*)::int from settlement_service.financial_instruction_execution_attempts attempt
    where attempt.settlement_id=record.settlement_id and attempt.target_service='credit-wallet-service'
      and attempt.status in ('Posted','Skipped')) wallet_attempts,
  exists(select 1 from ticket_completion_authority.completion_evidence completion
    where completion.ticket_id=$2) completion_exists,
  (select count(*)::int from ticket_authority.ticket_lifecycle_events event
    where event.ticket_id=$2 and event.command_type='MarkCommissionEligible') commission_events,
  (select count(*)::int from ticket_authority.ticket_lifecycle_events event
    where event.ticket_id=$2 and event.command_type='MarkRebateEligible') rebate_events,
  (select lifecycle_state from ticket_authority.tickets where ticket_id=$2) lifecycle_state,
  exists(select 1 from game_engine.canonical_draw_completion_evidence completion
    where completion.settlement_request_id=$1) draw_completion_exists
from settlement_service.authoritative_settlement_records record
where record.settlement_request_id=$1;
`, [settlementRequestId, ticket.ticketId]);
    const row = result.rows[0];
    return row && row.ledger_attempts === 1 && row.wallet_attempts === 1
      && row.completion_exists && row.commission_events === 1 && row.rebate_events === 1
      && row.lifecycle_state === "REBATE_ELIGIBLE"
      && row.draw_completion_exists ? row : null;
  });

  if (recoverRequest) {
    const recoveredCount = Number((await pool.query(`
select count(*)::int count from game_engine.outcome_settlement_requests
where outcome_version_id=$1;
`, [outcomeVersionId])).rows[0].count);
    check(`${category}/${fundingInstrument} recovery retry remains singular`, recoveredCount === 1,
      { recoveredCount, settlementRequestId });
  } else {
    const duplicate = await post("/api/game-engine/outcome-settlement-requests", {
      idempotencyKey: `rc14-settlement:${suffix}`,
      outcomeVersionId,
      settlementInputId: settlementInput.settlementInputId,
      correlationId: `rc14:${suffix}`,
      causationId: `rc14-publication:${outcomeVersionId}`,
      auditReference: `audit:rc14:settlement:${suffix}`,
    });
    check(`${category}/${fundingInstrument} retry is idempotent`,
      duplicate.status === 200 && duplicate.body?.data?.settlementRequestId === settlementRequestId,
      duplicate);
  }
  check(`${category}/${fundingInstrument} reaches Settlement, Ledger, Wallet, Completion and Compensation`, true, chain);
  return {
    category,
    fundingInstrument,
    ticketId: ticket.ticketId,
    settlementRequestId,
    outcomeVersionId,
    fixture,
    outcome,
    ticket,
    settlementInput,
    ...chain,
  };
}

async function qualifyCorrectionAndCancellation(template, original) {
  const suffix = `${runId}:corrected`;
  const replacement = original.fixture.primaryUniverse.find((value) =>
    !original.fixture.primary.includes(value) && !original.fixture.bonus.includes(value));
  if (replacement === undefined) throw new Error("Correction fixture lacks an alternate primary number.");
  const primary = [...original.fixture.primary];
  primary[0] = replacement;
  if (original.fixture.primaryOrdering === "Ascending") primary.sort((left, right) => left - right);
  const correctedOutcome = await appendCertifiedProviderResult(pool, original.fixture, {
    primary,
    outcomePayload: { numbers: primary, bonusNumbers: original.fixture.bonus },
    previousCertificateId: original.outcome.certificateId,
    previousCertificateHash: original.outcome.outcomeHash,
  });
  const correctedInput = await createSettlementInput(
    template,
    original.fixture,
    correctedOutcome,
    original.ticket,
    suffix,
  );
  const publication = await post("/api/game-engine/outcome-publications", {
    idempotencyKey: `rc14-publication:${suffix}`,
    drawId: original.fixture.drawId,
    productReference: `rc14:${template.product_id}`,
    engineName: original.fixture.engineName,
    engineVersion: original.fixture.engineVersion,
    outcomeCertificateId: correctedOutcome.certificateId,
    outcomeCertificateHash: correctedOutcome.outcomeHash,
    versionKind: "Corrected",
    previousOutcomeVersionId: original.outcomeVersionId,
    authoritativeSource: "OutcomeCertificate",
    correlationId: `rc14:${suffix}`,
    causationId: `rc14-provider:${correctedOutcome.certificateId}`,
    auditReference: `audit:rc14:${suffix}`,
    actorReference: "qa:rc-1.4",
    reasonCode: "RESULT_CORRECTION",
    lifecycleEvidenceHash: hash(`lifecycle:${suffix}`),
  });
  check("corrected outcome publication succeeds", publication.status === 200, publication);
  const correctedVersionId = publication.body?.data?.outcomeVersionId;
  const request = await post("/api/game-engine/outcome-settlement-requests", {
    idempotencyKey: `rc14-settlement:${suffix}`,
    outcomeVersionId: correctedVersionId,
    settlementInputId: correctedInput.settlementInputId,
    correlationId: `rc14:${suffix}`,
    causationId: `rc14-publication:${correctedVersionId}`,
    auditReference: `audit:rc14:settlement:${suffix}`,
  });
  check("corrected outcome emits one canonical Settlement intent", request.status === 200, request);
  const correctedRequestId = request.body?.data?.settlementRequestId;
  await waitFor("corrected outcome completes governed resettlement", async () => {
    const result = await pool.query(`
select chain.resettlement_request_id, chain.reversal_settlement_id,
  chain.corrected_settlement_id, completion.completion_id
from game_engine.outcome_settlement_acknowledgements acknowledgement
join settlement_service.resettlement_records chain
  on chain.corrected_settlement_id=acknowledgement.authoritative_settlement_id
join game_engine.canonical_draw_completion_evidence completion
  on completion.settlement_request_id=acknowledgement.settlement_request_id
where acknowledgement.settlement_request_id=$1;
`, [correctedRequestId]);
    return result.rows[0] ?? null;
  });
  check("correction preserves the original immutable Settlement", Number((await pool.query(`
select count(*)::int count from settlement_service.authoritative_settlement_records
where settlement_request_id=$1;
`, [original.settlementRequestId])).rows[0].count) === 1);

  const cancellationSuffix = `${runId}:cancelled`;
  const cancellation = await post("/api/game-engine/outcome-publications", {
    idempotencyKey: `rc14-publication:${cancellationSuffix}`,
    drawId: original.fixture.drawId,
    productReference: `rc14:${template.product_id}`,
    engineName: original.fixture.engineName,
    engineVersion: original.fixture.engineVersion,
    outcomeCertificateId: correctedOutcome.certificateId,
    outcomeCertificateHash: correctedOutcome.outcomeHash,
    versionKind: "Cancelled",
    previousOutcomeVersionId: correctedVersionId,
    authoritativeSource: "OutcomeCertificate",
    correlationId: `rc14:${cancellationSuffix}`,
    causationId: `rc14-correction:${correctedVersionId}`,
    auditReference: `audit:rc14:${cancellationSuffix}`,
    actorReference: "qa:rc-1.4",
    reasonCode: "GOVERNED_DRAW_CANCELLATION",
    lifecycleEvidenceHash: hash(`lifecycle:${cancellationSuffix}`),
  });
  check("cancelled outcome publication succeeds", cancellation.status === 200, cancellation);
  const cancelledVersionId = cancellation.body?.data?.outcomeVersionId;
  const cancellationRequest = await post("/api/game-engine/outcome-settlement-requests", {
    idempotencyKey: `rc14-settlement:${cancellationSuffix}`,
    outcomeVersionId: cancelledVersionId,
    settlementInputId: null,
    correlationId: `rc14:${cancellationSuffix}`,
    causationId: `rc14-publication:${cancelledVersionId}`,
    auditReference: `audit:rc14:settlement:${cancellationSuffix}`,
  });
  check("cancelled outcome emits non-financial lifecycle intent", cancellationRequest.status === 200,
    cancellationRequest);
  const cancellationRequestId = cancellationRequest.body?.data?.settlementRequestId;
  await waitFor("cancelled outcome completes without financial Settlement", async () => {
    const result = await pool.query(`
select completion_id, settlement_acknowledgement_id
from game_engine.canonical_draw_completion_evidence
where settlement_request_id=$1 and completion_kind='Cancelled';
`, [cancellationRequestId]);
    return result.rows[0] && result.rows[0].settlement_acknowledgement_id === null
      ? result.rows[0]
      : null;
  });
}

let failed = false;
let template = null;
let previousActiveVersionId = null;
try {
  await waitFor("Game Engine is ready", async () => (await fetch(`${gameEngineUrl}/health/ready`)).ok);
  await ensureDisposablePlatformScopes();
  await ensureDisposableGameDefinition();
  template = await loadTicketTemplate();
  await reactivateDisposableTicketAvailability(template);
  previousActiveVersionId = (await pool.query(
    "select active_version_id from game_engine.game_definitions where id=$1",
    [template.product_id],
  )).rows[0].active_version_id;
  await pool.query("update game_engine.game_definitions set active_version_id=$1 where id=$2", [
    template.qualification_version_id,
    template.product_id,
  ]);
  const matrix = [];
  for (const category of ["INTERNAL_CSPRNG", "OFFICIAL_RESULTS", "MANUAL_CERTIFIED"]) {
    for (const fundingInstrument of ["CREDIT", "FREE_PLAY"]) {
      matrix.push(await qualifyCombination(template, category, fundingInstrument, {
        recoverRequest: category === "INTERNAL_CSPRNG" && fundingInstrument === "CREDIT",
      }));
    }
  }
  check("continuous provider/funding matrix contains exactly six successful paths", matrix.length === 6, { matrix });
  await qualifyCorrectionAndCancellation(template, matrix[0]);
  console.log(JSON.stringify({ qa: "canonical-outcome-settlement-invocation", runId, status: "PASS", checks, matrix }, null, 2));
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ qa: "canonical-outcome-settlement-invocation", runId, status: "FAIL", checks,
    error: error instanceof Error ? error.message : String(error) }, null, 2));
} finally {
  if (template && previousActiveVersionId) {
    await pool.query("update game_engine.game_definitions set active_version_id=$1 where id=$2", [
      previousActiveVersionId,
      template.product_id,
    ]);
  }
  await pool.end();
}

if (failed) process.exitCode = 1;
