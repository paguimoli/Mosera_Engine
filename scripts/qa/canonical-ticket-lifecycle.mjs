import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@localhost:55432/lottery_local";
const checks = [];

function check(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

async function rejected(name, operation, pattern) {
  try {
    await operation();
    check(name, false, { reason: "operation unexpectedly succeeded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), { message });
  }
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const runId = randomUUID();
  const suffix = runId.slice(0, 8);
  const scopeResult = await client.query(`
    select platform.id platform_id, organization.id organization_id,
      tenant.id tenant_id, brand.id brand_id, market.id market_id,
      market.currency
    from platform.markets market
    join platform.brands brand on brand.id = market.brand_id
    join platform.tenants tenant on tenant.id = brand.tenant_id
    join platform.organizations organization on organization.id = tenant.organization_id
    join platform.platforms platform on platform.id = organization.platform_id
    where market.status = 'Active' and brand.status = 'Active'
      and tenant.status = 'Active' and organization.status = 'Active'
      and platform.status = 'Active'
    order by exists (
      select 1 from platform.game_availability existing
      where existing.tenant_id = tenant.id
        and existing.brand_id = brand.id
        and existing.market_id = market.id
        and existing.status in ('Suspended', 'Retired')
    ), market.id
    limit 20
  `);
  const scope = scopeResult.rows[0];
  const otherScope = scopeResult.rows.find(
    (candidate) =>
      candidate.tenant_id !== scope?.tenant_id ||
      candidate.brand_id !== scope?.brand_id ||
      candidate.market_id !== scope?.market_id
  );
  if (!scope || !otherScope) {
    throw new Error("Two active canonical Platform scopes are required.");
  }

  const productResult = await client.query(`
    select definition.id product_id, definition.code game_code,
      definition.active_version_id product_version_id,
      version.paytable_version,
      assignment.id assignment_id
    from game_engine.game_definitions definition
    join game_engine.game_definition_versions version
      on version.id = definition.active_version_id
    cross join lateral (
      select id from game_engine.draw_authority_assignments order by id limit 1
    ) assignment
    order by definition.id
    limit 1
  `);
  const product = productResult.rows[0];
  if (!product) throw new Error("Canonical Game Engine product fixture is required.");

  const ids = {
    super: randomUUID(),
    master: randomUUID(),
    agent: randomUUID(),
    player: randomUUID(),
    player2: randomUUID(),
    profile: randomUUID(),
    wallet: randomUUID(),
    freePlayWallet: randomUUID(),
    manifest: randomUUID(),
    paytable: randomUUID(),
    availability: randomUUID(),
    otherAvailability: randomUUID(),
    draw: randomUUID(),
    drawScheduleVersion: randomUUID(),
    closedDraw: randomUUID(),
    closedDrawScheduleVersion: randomUUID(),
  };

  async function insertAccount(id, type, parentId = null, status = "ACTIVE") {
    await client.query(
      `insert into public.accounts (
        id, account_type, account_code, display_name, parent_account_id,
        canonical_tenant_id, canonical_brand_id, canonical_market_id,
        status, governance_managed, idempotency_key, canonical_request_hash
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)`,
      [
        id,
        type,
        `ticket-${suffix}-${type.toLowerCase()}-${id.slice(0, 4)}`,
        `${type} ${suffix}`,
        parentId,
        scope.tenant_id,
        scope.brand_id,
        scope.market_id,
        status,
        `ticket-account:${id}`,
        `sha256:${id.replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`,
      ]
    );
  }
  await insertAccount(ids.super, "SUPER_MASTER");
  await insertAccount(ids.master, "MASTER_AGENT", ids.super);
  await insertAccount(ids.agent, "AGENT", ids.master);
  await insertAccount(ids.player, "PLAYER", ids.agent);
  await insertAccount(ids.player2, "PLAYER", ids.agent);
  await client.query(
    `insert into public.player_profiles (
      id, account_id, display_name, status
    ) values ($1,$2,$3,'ACTIVE')`,
    [ids.profile, ids.player, `Ticket Player ${suffix}`]
  );
  await client.query(
    `insert into public.financial_wallets (
      id, account_id, wallet_type, currency_code, balance_authority,
      status, balance, credit_limit, funding_model
    ) values
      ($1,$2,'CREDIT',$4,'INTERNAL','ACTIVE',0,100000,'CREDIT'),
      ($3,$2,'FREE_PLAY',$4,'INTERNAL','ACTIVE',100000,0,'CREDIT')`,
    [ids.wallet, ids.player, ids.freePlayWallet, scope.currency]
  );
  await client.query(
    `insert into credit_wallet_service.wallet_scopes (
      wallet_id, tenant_id, brand_id, player_id, instrument_code,
      currency, authority
    ) values
      ($1,$3,$4,$5,'CREDIT',$6,'CREDIT_WALLET_SERVICE'),
      ($2,$3,$4,$5,'FREE_PLAY',$6,'CREDIT_WALLET_SERVICE')`,
    [
      ids.wallet,
      ids.freePlayWallet,
      scope.tenant_id,
      scope.brand_id,
      ids.player,
      scope.currency,
    ]
  );

  const paytableHash = `sha256:ticket-paytable:${runId}`;
  const manifestHash = `sha256:ticket-manifest:${runId}`;
  const manifestVersion = `1.0.${Date.now()}`;
  const availabilityVersion = `1.0.${Date.now()}`;
  await client.query(
    `insert into game_engine.paytable_definitions (
      id, paytable_id, version, math_model_id, math_model_version,
      prize_matrix_rows, bonus_side_bet_rows, caps, lifecycle_state,
      content_hash, signature_metadata, certification_binding_state
    ) values (
      $1,$2,$4,'ticket-math','1.0.0',
      '[{"tier":"WIN","multiplier":2}]','[]','{}',
      'ProductionActive',$3,'{}','None'
    )`,
    [
      ids.paytable,
      `ticket-paytable-${suffix}`,
      paytableHash,
      product.paytable_version,
    ]
  );
  await client.query(
    `insert into game_engine.game_manifests (
      id, game_id, game_code, game_name, game_family,
      jurisdiction_bindings, wager_schemas, outcome_strategy_references,
      math_model_references, paytable_references,
      settlement_policy_references, sales_rules,
      cancellation_correction_rules, replay_resettlement_policy,
      certification_pack_reference, regulator_profile,
      operator_approval_state, lifecycle_state, effective_from,
      semantic_version, content_hash, signature_metadata
    ) values (
      $1,$2,$3,$4,'Lottery','[]',$5,'[]','[]',$6,'[]','{}',
      '{"allowBeforeCutoff":true}','{}','','','Approved',
      'ProductionActive',now() - interval '1 minute',$7,$8,'{}'
    )`,
    [
      ids.manifest,
      product.product_id,
      product.game_code,
      `Ticket Manifest ${suffix}`,
      JSON.stringify([{ wagerType: "STRAIGHT", version: "1.0.0" }]),
      JSON.stringify([
        {
          paytableId: `ticket-paytable-${suffix}`,
          version: product.paytable_version,
        },
      ]),
      manifestVersion,
      manifestHash,
    ]
  );
  await client.query(
    `insert into platform.game_availability (
      id, tenant_id, brand_id, market_id, game_id, game_code,
      game_manifest_reference, status, effective_from, version,
      content_hash, audit_metadata
    ) values ($1,$2,$3,$4,$5,$6,$7,'Active',now() - interval '1 minute',
      $8,$9,'{}')`,
    [
      ids.availability,
      scope.tenant_id,
      scope.brand_id,
      scope.market_id,
      product.product_id,
      product.game_code,
      ids.manifest,
      availabilityVersion,
      `sha256:ticket-availability:${runId}`,
    ]
  );
  await client.query(
    `insert into platform.game_availability (
      id, tenant_id, brand_id, market_id, game_id, game_code,
      status, effective_from, version, content_hash, audit_metadata
    ) values ($1,$2,$3,$4,$5,$6,'Active',now() - interval '1 minute',
      $7,$8,'{}')`,
    [
      ids.otherAvailability,
      otherScope.tenant_id,
      otherScope.brand_id,
      otherScope.market_id,
      product.product_id,
      product.game_code,
      availabilityVersion,
      `sha256:ticket-other-availability:${runId}`,
    ]
  );
  await client.query(
    `insert into game_engine.published_draw_schedule_versions (
      schedule_version_id, schedule_id, version_number, game_definition_id,
      draw_authority_assignment_id, schedule_kind, schedule_configuration,
      time_zone_id, schedule_hash, published_at
    ) values
      ($1,$2,1,$3,$4,'QA','{}','UTC',$5,now() - interval '2 minutes'),
      ($6,$7,1,$3,$4,'QA','{}','UTC',$8,now() - interval '2 hours')`,
    [
      ids.drawScheduleVersion,
      ids.draw,
      product.product_id,
      product.assignment_id,
      `sha256:ticket-schedule:${runId}`,
      ids.closedDrawScheduleVersion,
      ids.closedDraw,
      `sha256:ticket-closed-schedule:${runId}`,
    ]
  );
  await client.query(
    `insert into game_engine.draw_schedules (
      id, game_definition_id, draw_authority_assignment_id,
      sales_open_at, sales_close_at, draw_at, status,
      schedule_version_id, scheduled_execution_at, schedule_hash, draw_identity_hash
    ) values
      ($1,$2,$3,now() - interval '1 minute',now() + interval '1 hour',
        now() + interval '61 minutes','SalesOpen',$5,now() + interval '61 minutes',$6,$7),
      ($4,$2,$3,now() - interval '2 hours',now() - interval '1 hour',
        now() - interval '59 minutes','SalesClosed',$8,now() - interval '59 minutes',$9,$10)`,
    [
      ids.draw,
      product.product_id,
      product.assignment_id,
      ids.closedDraw,
      ids.drawScheduleVersion,
      `sha256:ticket-schedule:${runId}`,
      `sha256:ticket-draw:${runId}`,
      ids.closedDrawScheduleVersion,
      `sha256:ticket-closed-schedule:${runId}`,
      `sha256:ticket-closed-draw:${runId}`,
    ]
  );

  const liabilityVersions = new Map();
  async function setLiabilityLimit(
    scopeType,
    scopeReference,
    {
      maximumWagerMinor = 100_000_000,
      maximumTheoreticalPayoutMinor = 100_000_000,
      maximumExposureMinor = 100_000_000,
    } = {}
  ) {
    const key = `${scopeType}:${scopeReference}`;
    let previous = liabilityVersions.get(key);
    if (!previous) {
      const existing = await client.query(
        `select configuration_id, version
           from ticket_authority.liability_limit_configurations
          where tenant_id=$1 and brand_id=$2 and scope_type=$3
            and scope_reference=$4
          order by version desc limit 1`,
        [scope.tenant_id, scope.brand_id, scopeType, String(scopeReference).toLowerCase()]
      );
      if (existing.rows[0]) {
        previous = {
          configurationId: existing.rows[0].configuration_id,
          version: Number(existing.rows[0].version),
        };
      }
    }
    const configurationId = randomUUID();
    const version = (previous?.version ?? 0) + 1;
    await client.query(
      `insert into ticket_authority.liability_limit_configurations (
        configuration_id, tenant_id, brand_id, scope_type, scope_reference,
        maximum_wager_minor, maximum_theoretical_payout_minor,
        maximum_exposure_minor, status, effective_from, version,
        supersedes_configuration_id, content_hash, audit_metadata
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,'Active',
        clock_timestamp() - interval '1 millisecond',$9,$10,$11,$12::jsonb)`,
      [
        configurationId,
        scope.tenant_id,
        scope.brand_id,
        scopeType,
        String(scopeReference).toLowerCase(),
        maximumWagerMinor,
        maximumTheoreticalPayoutMinor,
        maximumExposureMinor,
        version,
        previous?.configurationId ?? null,
        `sha256:liability-${runId}:${scopeType.toLowerCase()}:${version}`,
        JSON.stringify({ actor: "qa-operator", reason: "BF-5.2" }),
      ]
    );
    liabilityVersions.set(key, { configurationId, version });
    return configurationId;
  }

  const liabilityScopes = [
    ["TENANT", scope.tenant_id],
    ["MASTER_AGENT", ids.master],
    ["AGENT", ids.agent],
    ["PLAYER", ids.player],
    ["DRAW", ids.draw],
    ["PRODUCT", product.product_id],
    ["GAME", product.game_code],
    ["WAGER_TYPE", "straight"],
  ];
  for (const [scopeType, scopeReference] of liabilityScopes) {
    await setLiabilityLimit(scopeType, scopeReference);
  }

  const items = [
    {
      wagerType: "STRAIGHT",
      wagerVersion: "1.0.0",
      selections: [1, 2, 3],
      stakeMinor: 100,
    },
    {
      wagerType: "STRAIGHT",
      wagerVersion: "1.0.0",
      selections: [4, 5, 6],
      stakeMinor: 200,
    },
  ];
  const baseArgs = [
    ids.player,
    ids.profile,
    ids.wallet,
    ids.availability,
    product.product_id,
    ids.manifest,
    ids.paytable,
    ids.draw,
    null,
    null,
    `ticket-${suffix}`,
    scope.currency,
    JSON.stringify(items),
    `ticket-accept:${runId}`,
    `ticket-correlation:${runId}`,
    null,
    "qa-operator",
    "QA",
  ];
  const acceptSql = `select ticket_authority.accept_ticket(
    $1,$2,null,$3,$5,$6,$7,$8,null,$11,$12,$13::jsonb,$14,$15,$16,$17,$18
  ) result
  from (values ($4::uuid,$9::uuid,$10::uuid)) ignored(availability_id,website_id,domain_id)`;
  const fundingSql = `select * from funding_authority.resolve_funding_instrument(
    $1::uuid,$2,$3::uuid,$4,$5,$6,$7
  )`;
  const fundingKey = `funding-authority:${runId}`;
  const fundingArgs = [
    ids.player,
    "CREDIT",
    ids.wallet,
    scope.currency,
    "TICKET_ACCEPTANCE",
    fundingKey,
    `funding-correlation:${runId}`,
  ];
  const fundingFirst = await client.query(fundingSql, fundingArgs);
  const fundingDuplicate = await client.query(fundingSql, fundingArgs);
  check(
    "Funding Instrument Authority resolves CREDIT deterministically and idempotently",
    fundingFirst.rows[0].funding_instrument === "CREDIT" &&
      fundingFirst.rows[0].wallet_id === ids.wallet &&
      fundingFirst.rows[0].reservation_type === "CREDIT_EXPOSURE" &&
      fundingFirst.rows[0].reused === false &&
      fundingDuplicate.rows[0].resolution_id ===
        fundingFirst.rows[0].resolution_id &&
      fundingDuplicate.rows[0].reused === true
  );
  await rejected(
    "conflicting funding decision fails closed",
    () =>
      client.query(fundingSql, [
        ...fundingArgs.slice(0, 1),
        "FREE_PLAY",
        ids.freePlayWallet,
        ...fundingArgs.slice(3),
      ]),
    /conflict/
  );
  await rejected(
    "funding decision evidence is append-only",
    () =>
      client.query(
        `update funding_authority.resolution_events
            set correlation_id='tampered'
          where resolution_id=$1`,
        [fundingFirst.rows[0].resolution_id]
      ),
    /append-only/
  );

  const accepted = (await client.query(acceptSql, baseArgs)).rows[0].result;
  const ticketId = accepted.ticketId;
  check(
    "valid multi-item ticket acceptance is atomic",
    accepted.accepted === true &&
      accepted.duplicate === false &&
      Boolean(accepted.reservationId)
  );
  const atomic = await client.query(
    `select
      (select count(*) from ticket_authority.tickets where ticket_id=$1) tickets,
      (select count(*) from ticket_authority.ticket_items where ticket_id=$1) items,
      (select count(*) from public.credit_reservations where ticket_id=$1::text) reservations,
      (select count(*) from public.outbox_events
        where aggregate_id=$1::text and event_type='ticket.accepted') outbox`,
    [ticketId]
  );
  check(
    "ticket reservation and acceptance outbox are consistent",
    Number(atomic.rows[0].tickets) === 1 &&
      Number(atomic.rows[0].items) === 2 &&
      Number(atomic.rows[0].reservations) === 1 &&
      Number(atomic.rows[0].outbox) === 1,
    atomic.rows[0]
  );
  const liabilityEvidence = await client.query(
    `select decision.outcome, decision.reason_code,
            decision.total_wager_minor::text,
            decision.theoretical_payout_minor::text,
            decision.game_definition_version_id,
            decision.game_definition_hash,
            decision.paytable_definition_id,
            decision.paytable_hash,
            jsonb_array_length(decision.configuration_references) configuration_count
       from ticket_authority.liability_decisions decision
      where decision.ticket_id=$1`,
    [ticketId]
  );
  check(
    "Ticket Liability Authority derives and snapshots immutable theoretical liability",
    liabilityEvidence.rows.length === 1 &&
      liabilityEvidence.rows[0].outcome === "ALLOWED" &&
      liabilityEvidence.rows[0].reason_code === "LIABILITY_ALLOWED" &&
      Number(liabilityEvidence.rows[0].total_wager_minor) === 300 &&
      Number(liabilityEvidence.rows[0].theoretical_payout_minor) === 600 &&
      liabilityEvidence.rows[0].paytable_definition_id === ids.paytable &&
      Boolean(liabilityEvidence.rows[0].game_definition_version_id) &&
      String(liabilityEvidence.rows[0].game_definition_hash).length > 0 &&
      liabilityEvidence.rows[0].paytable_hash === paytableHash &&
      Number(liabilityEvidence.rows[0].configuration_count) === 8,
    liabilityEvidence.rows[0]
  );
  const creditSnapshot = await client.query(
    `select ticket.funding_instrument, ticket.wallet_id,
            ticket.reservation_type, ticket.funding_resolution_id,
            ticket.funding_snapshot_hash, reservation.instrument_code
       from ticket_authority.tickets ticket
       join public.credit_reservations reservation
         on reservation.id = ticket.reservation_id
      where ticket.ticket_id = $1`,
    [ticketId]
  );
  check(
    "CREDIT ticket permanently snapshots the authoritative funding decision",
    creditSnapshot.rows[0].funding_instrument === "CREDIT" &&
      creditSnapshot.rows[0].wallet_id === ids.wallet &&
      creditSnapshot.rows[0].reservation_type === "CREDIT_EXPOSURE" &&
      creditSnapshot.rows[0].instrument_code === "CREDIT" &&
      Boolean(creditSnapshot.rows[0].funding_resolution_id) &&
      Boolean(creditSnapshot.rows[0].funding_snapshot_hash),
    creditSnapshot.rows[0]
  );

  const freePlayArgs = [
    ...baseArgs.slice(0, 2),
    ids.freePlayWallet,
    ...baseArgs.slice(3, 10),
    `free-play-${suffix}`,
    ...baseArgs.slice(11, 13),
    `free-play:${runId}`,
    `free-play-correlation:${runId}`,
    ...baseArgs.slice(15),
  ];
  const freePlayAccepted = (
    await client.query(acceptSql, freePlayArgs)
  ).rows[0].result;
  const freePlaySnapshot = await client.query(
    `select ticket.funding_instrument, ticket.wallet_id,
            ticket.reservation_type, ticket.funding_resolution_id,
            ticket.funding_snapshot_hash, reservation.instrument_code,
            reservation.status
       from ticket_authority.tickets ticket
       join public.credit_reservations reservation
         on reservation.id = ticket.reservation_id
      where ticket.ticket_id = $1`,
    [freePlayAccepted.ticketId]
  );
  check(
    "FREE_PLAY acceptance uses the same atomic lifecycle with its own immutable classification",
    freePlayAccepted.accepted === true &&
      freePlaySnapshot.rows[0].funding_instrument === "FREE_PLAY" &&
      freePlaySnapshot.rows[0].wallet_id === ids.freePlayWallet &&
      freePlaySnapshot.rows[0].reservation_type === "FREE_PLAY_STAKE" &&
      freePlaySnapshot.rows[0].instrument_code === "FREE_PLAY" &&
      freePlaySnapshot.rows[0].status === "RESERVED" &&
      Boolean(freePlaySnapshot.rows[0].funding_resolution_id) &&
      Boolean(freePlaySnapshot.rows[0].funding_snapshot_hash),
    freePlaySnapshot.rows[0]
  );
  const freePlayDuplicate = (
    await client.query(acceptSql, freePlayArgs)
  ).rows[0].result;
  check(
    "FREE_PLAY acceptance is idempotent",
    freePlayDuplicate.duplicate === true &&
      freePlayDuplicate.ticketId === freePlayAccepted.ticketId
  );
  const fundingTotals = await client.query(
    `select funding_instrument, ticket_count::text, total_stake_minor::text
       from funding_authority.ticket_totals_by_instrument
      where tenant_id=$1 and brand_id=$2 and market_id=$3
        and funding_instrument in ('CREDIT', 'FREE_PLAY')`,
    [scope.tenant_id, scope.brand_id, scope.market_id]
  );
  check(
    "CREDIT and FREE_PLAY ticket reporting remains independently classified",
    fundingTotals.rows.some(
      (row) =>
        row.funding_instrument === "CREDIT" &&
        Number(row.ticket_count) >= 1 &&
        Number(row.total_stake_minor) >= 300
    ) &&
      fundingTotals.rows.some(
        (row) =>
          row.funding_instrument === "FREE_PLAY" &&
          Number(row.ticket_count) >= 1 &&
          Number(row.total_stake_minor) >= 300
      ),
    { fundingTotals: fundingTotals.rows }
  );

  const duplicate = (await client.query(acceptSql, baseArgs)).rows[0].result;
  check(
    "identical idempotency retry returns original ticket",
    duplicate.duplicate === true && duplicate.ticketId === ticketId
  );
  await rejected(
    "conflicting idempotency retry fails closed",
    () =>
      client.query(acceptSql, [
        ...baseArgs.slice(0, 12),
        JSON.stringify([{ ...items[0], stakeMinor: 101 }]),
        ...baseArgs.slice(13),
      ]),
    /conflicts/
  );
  const ignoredCallerAvailability = (
    await client.query(acceptSql, [
      ...baseArgs.slice(0, 3),
      ids.otherAvailability,
      ...baseArgs.slice(4, 10),
      `server-derived-${suffix}`,
      ...baseArgs.slice(11, 13),
      `server-derived:${runId}`,
      ...baseArgs.slice(14),
    ])
  ).rows[0].result;
  const derivedAvailability = await client.query(
    `select game_availability_id from ticket_authority.tickets where ticket_id=$1`,
    [ignoredCallerAvailability.ticketId]
  );
  check(
    "caller-supplied availability cannot override server-derived scope",
    ignoredCallerAvailability.accepted === true &&
      derivedAvailability.rows[0].game_availability_id === ids.availability
  );
  await rejected(
    "closed draw and passed cutoff reject acceptance",
    () =>
      client.query(acceptSql, [
        ...baseArgs.slice(0, 7),
        ids.closedDraw,
        ...baseArgs.slice(8, 13),
        `closed-draw:${runId}`,
        ...baseArgs.slice(14),
      ]),
    /draw does not permit/
  );
  await rejected(
    "invalid manifest or paytable binding is rejected",
    () =>
      client.query(acceptSql, [
        ...baseArgs.slice(0, 6),
        randomUUID(),
        ...baseArgs.slice(7, 13),
        `bad-paytable:${runId}`,
        ...baseArgs.slice(14),
      ]),
    /paytable|foreign key|exact immutable/i
  );

  await setLiabilityLimit("WAGER_TYPE", "straight", {
    maximumTheoreticalPayoutMinor: 599,
  });
  const payoutLimitKey = `liability-payout:${runId}`;
  const payoutLimitArgs = [
    ...baseArgs.slice(0, 10),
    `liability-payout-${suffix}`,
    ...baseArgs.slice(11, 13),
    payoutLimitKey,
    ...baseArgs.slice(14),
  ];
  const payoutRejected = (await client.query(acceptSql, payoutLimitArgs)).rows[0]
    .result;
  const payoutDuplicate = (await client.query(acceptSql, payoutLimitArgs)).rows[0]
    .result;
  const payoutPartials = await client.query(
    `select
      (select count(*) from ticket_authority.tickets where idempotency_key=$1) tickets,
      (select count(*) from public.credit_reservations
        where idempotency_key='ticket-reservation:' || $1) reservations,
      (select count(*) from ticket_authority.liability_decisions
        where idempotency_key=$1 and outcome='REJECTED') decisions`,
    [payoutLimitKey]
  );
  check(
    "maximum theoretical payout rejects before reservation and retries deterministically",
    payoutRejected.accepted === false &&
      payoutRejected.duplicate === false &&
      payoutRejected.reasonCode ===
        "MAXIMUM_THEORETICAL_PAYOUT_EXCEEDED:WAGER_TYPE" &&
      payoutDuplicate.accepted === false &&
      payoutDuplicate.duplicate === true &&
      payoutDuplicate.liabilityDecisionId === payoutRejected.liabilityDecisionId &&
      Number(payoutPartials.rows[0].tickets) === 0 &&
      Number(payoutPartials.rows[0].reservations) === 0 &&
      Number(payoutPartials.rows[0].decisions) === 1,
    { payoutRejected, payoutDuplicate, partials: payoutPartials.rows[0] }
  );
  await setLiabilityLimit("WAGER_TYPE", "straight");

  await setLiabilityLimit("PLAYER", ids.player, { maximumWagerMinor: 299 });
  const wagerRejected = (
    await client.query(acceptSql, [
      ...baseArgs.slice(0, 10),
      `liability-wager-${suffix}`,
      ...baseArgs.slice(11, 13),
      `liability-wager:${runId}`,
      ...baseArgs.slice(14),
    ])
  ).rows[0].result;
  check(
    "maximum wager is enforced from the canonical player scope",
    wagerRejected.accepted === false &&
      wagerRejected.reasonCode === "MAXIMUM_WAGER_EXCEEDED:PLAYER",
    wagerRejected
  );
  await setLiabilityLimit("PLAYER", ids.player);

  const exposureScopes = [
    ["TENANT", scope.tenant_id],
    ["MASTER_AGENT", ids.master],
    ["AGENT", ids.agent],
    ["PLAYER", ids.player],
    ["DRAW", ids.draw],
    ["PRODUCT", product.product_id],
    ["GAME", product.game_code],
    ["WAGER_TYPE", "straight"],
  ];
  for (const [scopeType, scopeReference] of exposureScopes) {
    await setLiabilityLimit(scopeType, scopeReference, {
      maximumExposureMinor: 1,
    });
    const exposureResult = (
      await client.query(acceptSql, [
        ...baseArgs.slice(0, 10),
        `exposure-${scopeType.toLowerCase()}-${suffix}`,
        ...baseArgs.slice(11, 13),
        `liability-exposure:${scopeType}:${runId}`,
        ...baseArgs.slice(14),
      ])
    ).rows[0].result;
    check(
      `${scopeType} exposure ceiling fails closed`,
      exposureResult.accepted === false &&
        exposureResult.reasonCode === `MAXIMUM_EXPOSURE_EXCEEDED:${scopeType}`,
      exposureResult
    );
    await setLiabilityLimit(scopeType, scopeReference);
  }

  const tenantExposure = await client.query(
    `select coalesce(sum(decision.theoretical_payout_minor), 0)::bigint exposure
       from ticket_authority.liability_decisions decision
       join ticket_authority.tickets ticket on ticket.ticket_id=decision.ticket_id
      where decision.outcome='ALLOWED'
        and ticket.status in ('ACCEPTED','AWAITING_DRAW','CLOSED','SETTLEMENT_PENDING')
        and ticket.tenant_id=$1`,
    [scope.tenant_id]
  );
  await setLiabilityLimit("TENANT", scope.tenant_id, {
    maximumExposureMinor: Number(tenantExposure.rows[0].exposure) + 600,
  });
  const liabilityConcurrentA = new Client({ connectionString: databaseUrl });
  const liabilityConcurrentB = new Client({ connectionString: databaseUrl });
  await Promise.all([liabilityConcurrentA.connect(), liabilityConcurrentB.connect()]);
  const concurrentLiabilityResults = await Promise.all([
    liabilityConcurrentA.query(acceptSql, [
      ...baseArgs.slice(0, 10),
      `liability-concurrent-a-${suffix}`,
      ...baseArgs.slice(11, 13),
      `liability-concurrent-a:${runId}`,
      ...baseArgs.slice(14),
    ]),
    liabilityConcurrentB.query(acceptSql, [
      ...baseArgs.slice(0, 10),
      `liability-concurrent-b-${suffix}`,
      ...baseArgs.slice(11, 13),
      `liability-concurrent-b:${runId}`,
      ...baseArgs.slice(14),
    ]),
  ]);
  await Promise.all([liabilityConcurrentA.end(), liabilityConcurrentB.end()]);
  const concurrentLiability = concurrentLiabilityResults.map(
    (result) => result.rows[0].result
  );
  check(
    "concurrent acceptance cannot exceed the authoritative tenant exposure ceiling",
    concurrentLiability.filter((result) => result.accepted === true).length === 1 &&
      concurrentLiability.filter(
        (result) =>
          result.accepted === false &&
          result.reasonCode === "MAXIMUM_EXPOSURE_EXCEEDED:TENANT"
      ).length === 1,
    { concurrentLiability }
  );
  await setLiabilityLimit("TENANT", scope.tenant_id);

  const beforeInsufficient = await client.query(
    "select count(*) count from ticket_authority.tickets"
  );
  await rejected(
    "insufficient credit rolls back ticket reservation and outbox",
    () =>
      client.query(acceptSql, [
        ...baseArgs.slice(0, 12),
        JSON.stringify([{ ...items[0], stakeMinor: 100001 }]),
        `insufficient:${runId}`,
        ...baseArgs.slice(14),
      ]),
    /Insufficient/
  );
  const afterInsufficient = await client.query(
    "select count(*) count from ticket_authority.tickets"
  );
  check(
    "failed acceptance leaves no partial ticket",
    beforeInsufficient.rows[0].count === afterInsufficient.rows[0].count
  );

  const concurrentArgs = [
    ...baseArgs.slice(0, 10),
    `concurrent-${suffix}`,
    ...baseArgs.slice(11, 13),
    `concurrent:${runId}`,
    `concurrent-correlation:${runId}`,
    ...baseArgs.slice(15),
  ];
  const concurrentA = new Client({ connectionString: databaseUrl });
  const concurrentB = new Client({ connectionString: databaseUrl });
  await Promise.all([concurrentA.connect(), concurrentB.connect()]);
  const concurrentResults = await Promise.all([
    concurrentA.query(acceptSql, concurrentArgs),
    concurrentB.query(acceptSql, concurrentArgs),
  ]);
  await Promise.all([concurrentA.end(), concurrentB.end()]);
  check(
    "concurrent first acceptance creates one ticket",
    new Set(concurrentResults.map((result) => result.rows[0].result.ticketId)).size === 1
  );

  const lifecycleSql = (command) =>
    `select ticket_authority.${command}(
      $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
    ) result`;
  const lifecycleArgs = (source, hash, key, reason, evidence = {}) => [
    ticketId,
    source,
    hash,
    key,
    reason,
    "qa-ticket-lifecycle",
    `correlation:${runId}`,
    `causation:${runId}`,
    JSON.stringify(evidence),
  ];
  const outcomeHash = `sha256:${"a".repeat(64)}`;
  const requestArgs = lifecycleArgs(
    `outcome-${runId}`,
    outcomeHash,
    `request-settlement:${runId}`,
    "CERTIFIED_OUTCOME_AVAILABLE",
    { outcome: "WIN" }
  );
  await client.query(lifecycleSql("request_settlement"), requestArgs);
  const duplicateRequest = await client.query(
    lifecycleSql("request_settlement"),
    requestArgs
  );
  check(
    "typed settlement request is idempotent",
    duplicateRequest.rows[0].result.duplicate === true
  );
  await rejected(
    "conflicting typed lifecycle command fails closed",
    () =>
      client.query(lifecycleSql("request_settlement"), [
        ...requestArgs.slice(0, 2),
        `sha256:${"f".repeat(64)}`,
        ...requestArgs.slice(3),
      ]),
    /conflicts/
  );
  const settled = await client.query(
    `select status, lifecycle_state, lifecycle_version, acceptance_hash,
      (select count(*) from ticket_authority.ticket_correlations c
       where c.ticket_id=t.ticket_id) correlations,
      (select count(*) from ticket_authority.ticket_lifecycle_events e
       where e.ticket_id=t.ticket_id and e.command_type is not null) lifecycle,
      (select count(distinct e.ticket_version)
       from ticket_authority.ticket_lifecycle_events e
       where e.ticket_id=t.ticket_id and e.command_type is not null) versions
     from ticket_authority.tickets t where ticket_id=$1`,
    [ticketId]
  );
  check(
    "typed lifecycle hands financial completion to the canonical Completion Authority",
    settled.rows[0].status === "SETTLEMENT_PENDING" &&
      settled.rows[0].lifecycle_state === "SETTLEMENT_REQUESTED" &&
      Number(settled.rows[0].correlations) === 1 &&
      Number(settled.rows[0].lifecycle) === 3 &&
      Number(settled.rows[0].versions) === 3 &&
      Number(settled.rows[0].lifecycle_version) === 3,
    settled.rows[0]
  );
  await rejected(
    "ticket lifecycle projection cannot be changed directly",
    () => client.query(
      "update ticket_authority.tickets set status='VOIDED' where ticket_id=$1",
      [ticketId]
    ),
    /controlled by typed/
  );
  await rejected(
    "typed lifecycle evidence is append-only",
    () => client.query(
      `update ticket_authority.ticket_lifecycle_events
          set reason_code='tampered'
        where ticket_id=$1 and command_type='RequestSettlement'`,
      [ticketId]
    ),
    /append-only/
  );
  const retiredGeneric = await client.query(
    `select to_regprocedure(
      'ticket_authority.record_correlation(uuid,uuid,text,text,text,text,jsonb,text)'
    ) is null retired`
  );
  check(
    "generic correlation-driven lifecycle mutation is retired",
    retiredGeneric.rows[0].retired === true
  );
  const retiredCompletionCommands = await client.query(
    `select count(*)::int remaining
       from pg_proc procedure
       join pg_namespace namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='ticket_authority'
        and procedure.proname = any($1::text[])`,
    [[
      "confirm_settlement",
      "post_ledger",
      "apply_wallet",
      "mark_settled",
      "mark_commission_eligible",
      "mark_rebate_eligible",
    ]]
  );
  check(
    "direct financial completion lifecycle commands are retired",
    retiredCompletionCommands.rows[0].remaining === 0
  );

  const concurrentLifecycleArgs = [
    freePlayAccepted.ticketId,
    `outcome-free-play-${runId}`,
    `sha256:${"9".repeat(64)}`,
    `request-settlement-free-play:${runId}`,
    "CERTIFIED_OUTCOME_AVAILABLE",
    "qa-ticket-lifecycle",
    `correlation-free-play:${runId}`,
    `causation-free-play:${runId}`,
    "{}",
  ];
  const lifecycleA = new Client({ connectionString: databaseUrl });
  const lifecycleB = new Client({ connectionString: databaseUrl });
  await Promise.all([lifecycleA.connect(), lifecycleB.connect()]);
  const concurrentLifecycle = await Promise.all([
    lifecycleA.query(lifecycleSql("request_settlement"), concurrentLifecycleArgs),
    lifecycleB.query(lifecycleSql("request_settlement"), concurrentLifecycleArgs),
  ]);
  await Promise.all([lifecycleA.end(), lifecycleB.end()]);
  check(
    "concurrent identical lifecycle commands create one version",
    new Set(concurrentLifecycle.map((result) => result.rows[0].result.eventId)).size === 1 &&
      concurrentLifecycle.some((result) => result.rows[0].result.duplicate === true)
  );

  const cancelArgs = [
    ...baseArgs.slice(0, 10),
    `cancel-${suffix}`,
    ...baseArgs.slice(11, 13),
    `cancel-ticket:${runId}`,
    `cancel-correlation:${runId}`,
    ...baseArgs.slice(15),
  ];
  const cancelTicket = (await client.query(acceptSql, cancelArgs)).rows[0].result;
  const cancel = await client.query(
    "select ticket_authority.cancel_ticket($1,$2,$3,$4,$5) result",
    [
      cancelTicket.ticketId,
      `cancel:${runId}`,
      "PLAYER_REQUEST_BEFORE_CUTOFF",
      "qa-operator",
      `cancel-correlation:${runId}`,
    ]
  );
  const cancelDuplicate = await client.query(
    "select ticket_authority.cancel_ticket($1,$2,$3,$4,$5) result",
    [
      cancelTicket.ticketId,
      `cancel:${runId}`,
      "PLAYER_REQUEST_BEFORE_CUTOFF",
      "qa-operator",
      `cancel-correlation:${runId}`,
    ]
  );
  const cancelledState = await client.query(
    `select ticket.status, reservation.status reservation_status,
      exists(select 1 from public.outbox_events e
        where e.aggregate_id=ticket.ticket_id::text
          and e.event_type='ticket.cancelled') cancelled_outbox
     from ticket_authority.tickets ticket
     join public.credit_reservations reservation
       on reservation.id=ticket.reservation_id
     where ticket.ticket_id=$1`,
    [cancelTicket.ticketId]
  );
  check(
    "policy cancellation is atomic and idempotent",
    cancel.rows[0].result.cancelled === true &&
      cancelDuplicate.rows[0].result.duplicate === true &&
      cancelledState.rows[0].status === "CANCELLED" &&
      cancelledState.rows[0].reservation_status === "CANCELLED" &&
      cancelledState.rows[0].cancelled_outbox === true
  );
  await rejected(
    "cancellation after settlement fails closed",
    () =>
      client.query(
        "select ticket_authority.cancel_ticket($1,$2,$3,$4,$5)",
        [ticketId, `late-cancel:${runId}`, "LATE", "qa-operator", runId]
      ),
    /does not permit/
  );

  await rejected(
    "ticket acceptance snapshot cannot be changed",
    () =>
      client.query(
        "update ticket_authority.tickets set total_stake_minor=1 where ticket_id=$1",
        [ticketId]
      ),
    /immutable/
  );
  await rejected(
    "ticket funding snapshot cannot be changed",
    () =>
      client.query(
        `update ticket_authority.tickets
            set funding_instrument='FREE_PLAY'
          where ticket_id=$1`,
        [ticketId]
      ),
    /immutable/
  );
  await rejected(
    "ticket lifecycle history cannot be changed",
    () =>
      client.query(
        "delete from ticket_authority.ticket_lifecycle_events where ticket_id=$1",
        [ticketId]
      ),
    /append-only/
  );

  const decisionEvidence = await client.query(
    `select request.canonical_intent_hash, decision.decision_hash,
            decision.applicable_availability_ids
       from ticket_authority.acceptance_requests request
       join ticket_authority.availability_decisions decision
         on decision.ticket_id = request.ticket_id
      where request.ticket_id = $1`,
    [ticketId]
  );
  check(
    "acceptance intent and effective availability evidence are immutable and linked",
    decisionEvidence.rows.length === 1 &&
      String(decisionEvidence.rows[0].canonical_intent_hash).startsWith("sha256:") &&
      String(decisionEvidence.rows[0].decision_hash).startsWith("sha256:") &&
      decisionEvidence.rows[0].applicable_availability_ids.includes(ids.availability)
  );
  await rejected(
    "effective availability evidence cannot be changed",
    () =>
      client.query(
        "delete from ticket_authority.availability_decisions where ticket_id=$1",
        [ticketId]
      ),
    /append-only/
  );

  const brandLimitId = randomUUID();
  await client.query(
    `insert into platform.game_availability (
      id, tenant_id, brand_id, game_id, game_code, status, effective_from,
      max_wager_override, version, content_hash, audit_metadata
    ) values ($1,$2,$3,$4,$5,'Active',now() - interval '1 minute',2.50,$6,$7,'{}')`,
    [
      brandLimitId,
      scope.tenant_id,
      scope.brand_id,
      product.product_id,
      product.game_code,
      `limit-${suffix}`,
      `sha256:ticket-brand-limit:${runId}`,
    ]
  );
  const effectiveLimitResult = (
    await client.query(acceptSql, [
      ...baseArgs.slice(0, 10),
      `limit-${suffix}`,
      ...baseArgs.slice(11, 13),
      `limit:${runId}`,
      ...baseArgs.slice(14),
    ])
  ).rows[0].result;
  check(
    "effective wager limit intersects applicable parent and child scopes",
    effectiveLimitResult.accepted === false &&
      effectiveLimitResult.reasonCode === "ABOVE_EFFECTIVE_MAXIMUM_WAGER",
    effectiveLimitResult
  );

  const closeClient = new Client({ connectionString: databaseUrl });
  const acceptAfterCloseClient = new Client({ connectionString: databaseUrl });
  await Promise.all([closeClient.connect(), acceptAfterCloseClient.connect()]);
  await closeClient.query("begin");
  await closeClient.query(
    "update game_engine.draw_schedules set status='SalesClosed' where id=$1",
    [ids.draw]
  );
  const fencedAcceptance = acceptAfterCloseClient.query(acceptSql, [
    ...baseArgs.slice(0, 10),
    `fenced-${suffix}`,
    ...baseArgs.slice(11, 13),
    `fenced:${runId}`,
    ...baseArgs.slice(14),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await closeClient.query("commit");
  await rejected(
    "concurrent draw close wins the fence before acceptance can reserve",
    () => fencedAcceptance,
    /draw does not permit/
  );
  await Promise.all([closeClient.end(), acceptAfterCloseClient.end()]);
  const fencedPartials = await client.query(
    `select
      (select count(*) from ticket_authority.acceptance_requests where idempotency_key=$1) requests,
      (select count(*) from public.credit_reservations where idempotency_key=$2) reservations`,
    [`fenced:${runId}`, `ticket-reservation:fenced:${runId}`]
  );
  check(
    "draw-close rejection creates no reservation or ticket acceptance evidence",
    Number(fencedPartials.rows[0].requests) === 0 &&
      Number(fencedPartials.rows[0].reservations) === 0,
    fencedPartials.rows[0]
  );

  const playerRestrictionId = randomUUID();
  await client.query(
    `insert into platform.game_availability (
      id, tenant_id, brand_id, market_id, player_account_id,
      game_id, game_code, status, effective_from, version, content_hash, audit_metadata
    ) values ($1,$2,$3,$4,$5,$6,$7,'Suspended',now() - interval '1 minute',$8,$9,'{}')`,
    [
      playerRestrictionId,
      scope.tenant_id,
      scope.brand_id,
      scope.market_id,
      ids.player,
      product.product_id,
      product.game_code,
      `player-deny-${suffix}`,
      `sha256:ticket-player-deny:${runId}`,
    ]
  );
  const availabilitySql = `select * from ticket_authority.resolve_effective_availability(
    $1,$2,$3,null,$4,$5,$6,$7,clock_timestamp()
  )`;
  const playerDenied = await client.query(availabilitySql, [
      scope.tenant_id, scope.brand_id, scope.market_id,
      ids.agent, ids.master, ids.player, product.game_code,
    ]);
  check(
    "player restriction narrows commercial availability",
    playerDenied.rows[0]?.is_available === false
  );
  const unrestrictedPlayer = await client.query(availabilitySql, [
    scope.tenant_id, scope.brand_id, scope.market_id,
    ids.agent, ids.master, ids.player2, product.game_code,
  ]);
  check(
    "missing player override inherits commercial availability",
    unrestrictedPlayer.rows.length === 1
  );

  await client.query(
    `insert into platform.game_availability (
      id, tenant_id, brand_id, game_id, game_code, status, effective_from,
      version, content_hash, audit_metadata
    ) values ($1,$2,$3,$4,$5,'Suspended',now() - interval '1 minute',$6,$7,'{}')`,
    [
      randomUUID(), scope.tenant_id, scope.brand_id, product.product_id,
      product.game_code, `parent-deny-${suffix}`,
      `sha256:ticket-parent-deny:${runId}`,
    ]
  );
  const parentDenied = await client.query(availabilitySql, [
      scope.tenant_id, scope.brand_id, scope.market_id,
      ids.agent, ids.master, ids.player2, product.game_code,
    ]);
  check(
    "restrictive parent cannot be overridden by active market availability",
    parentDenied.rows[0]?.is_available === false
  );

  const readiness = await client.query(
    "select * from ticket_authority.ticket_readiness()"
  );
  check(
    "Ticket readiness passes all canonical integrity checks",
    readiness.rows.every((row) => row.ready),
    { readiness: readiness.rows }
  );

  const route = readFileSync("app/api/tickets/route.ts", "utf8");
  const detailRoute = readFileSync("app/api/tickets/[ticketId]/route.ts", "utf8");
  const cancelRoute = readFileSync(
    "app/api/tickets/[ticketId]/cancel/route.ts",
    "utf8"
  );
  const acceptanceAuthority = await client.query(`
    select
      (select count(*)::int
         from pg_proc procedure
         join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'ticket_authority'
          and procedure.proname = 'accept_ticket') as public_acceptance_functions,
      has_function_privilege(
        'public',
        'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)',
        'EXECUTE'
      ) as persistence_publicly_executable,
      position(
        'draw does not permit ticket acceptance'
        in pg_get_functiondef(
          'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure
        )
      ) > 0 as persistence_repeats_draw_fence
  `);
  check(
    "one public acceptance authority owns the only draw-close decision",
    acceptanceAuthority.rows[0].public_acceptance_functions === 1 &&
      acceptanceAuthority.rows[0].persistence_publicly_executable === false &&
      acceptanceAuthority.rows[0].persistence_repeats_draw_fence === false,
    acceptanceAuthority.rows[0]
  );
  const liabilityAuthority = await client.query(`
    select
      (select count(*)::int
         from pg_proc procedure
         join pg_namespace namespace on namespace.oid=procedure.pronamespace
        where namespace.nspname='ticket_authority'
          and procedure.proname='evaluate_liability') liability_authorities,
      position(
        'evaluate_liability'
        in pg_get_functiondef(
          'ticket_authority.accept_ticket(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text)'::regprocedure
        )
      ) > 0 acceptance_uses_liability,
      position(
        'evaluate_liability'
        in pg_get_functiondef(
          'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure
        )
      ) > 0 persistence_duplicates_liability
  `);
  check(
    "one Ticket Liability Authority executes before Funding and Reservation",
    liabilityAuthority.rows[0].liability_authorities === 1 &&
      liabilityAuthority.rows[0].acceptance_uses_liability === true &&
      liabilityAuthority.rows[0].persistence_duplicates_liability === false,
    liabilityAuthority.rows[0]
  );
  await rejected(
    "liability decisions are append-only",
    () =>
      client.query(
        "update ticket_authority.liability_decisions set reason_code='TAMPERED' where ticket_id=$1",
        [ticketId]
      ),
    /append-only/
  );
  await rejected(
    "liability configurations are append-only",
    () =>
      client.query(
        "delete from ticket_authority.liability_limit_configurations where tenant_id=$1",
        [scope.tenant_id]
      ),
    /append-only/
  );
  check(
    "one canonical production Ticket mutation path is enforced",
    route.includes("acceptCanonicalTicket") &&
      route.includes("Legacy external-ID ticket intake is retired") &&
      !route.includes('requiredUuid(body, "gameAvailabilityId")') &&
      !route.includes('optionalUuid(body, "websiteId")') &&
      !route.includes('optionalUuid(body, "domainId")') &&
      !route.includes("supabase") &&
      !route.includes("place_ticket_with_wallet_debit")
  );
  check(
    "Ticket reads and cancellation require permission plus scope",
    route.includes('requirePermission(request, "tickets.read")') &&
      detailRoute.includes('requirePermission(request, "tickets.read")') &&
      detailRoute.includes("assertTicketScope") &&
      cancelRoute.includes('requirePermission(request, "tickets.cancel")') &&
      cancelRoute.includes("assertTicketScope")
  );
} finally {
  await client.end();
}

const failed = checks.filter((entry) => entry.status === "FAIL");
console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "PASS" : "FAIL",
      checkCount: checks.length,
      failedCount: failed.length,
      checks,
    },
    null,
    2
  )
);
if (failed.length > 0) process.exitCode = 1;
