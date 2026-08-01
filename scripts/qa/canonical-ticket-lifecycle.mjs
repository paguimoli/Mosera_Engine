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
    order by market.id
    limit 2
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
      $1,$2,'1.0.0','ticket-math','1.0.0',
      '[{"tier":"WIN","multiplier":2}]','[]','{}',
      'ProductionActive',$3,'{}','None'
    )`,
    [ids.paytable, `ticket-paytable-${suffix}`, paytableHash]
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
        { paytableId: `ticket-paytable-${suffix}`, version: "1.0.0" },
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
    /paytable|foreign key/
  );

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

  const outcomeHash = `sha256:${"a".repeat(64)}`;
  const settlementHash = `sha256:${"b".repeat(64)}`;
  const correlationSql = `select ticket_authority.record_correlation(
    $1,null,$2,$3,$4,$5,$6::jsonb,$7
  ) result`;
  await client.query(correlationSql, [
    ticketId,
    "OUTCOME",
    `outcome-${runId}`,
    outcomeHash,
    "PUBLISHED",
    JSON.stringify({ outcome: "WIN" }),
    `correlation:${runId}`,
  ]);
  await client.query(correlationSql, [
    ticketId,
    "SETTLEMENT",
    `settlement-${runId}`,
    settlementHash,
    "COMPLETED",
    JSON.stringify({ outcome: "WIN" }),
    `correlation:${runId}`,
  ]);
  const duplicateSettlement = await client.query(correlationSql, [
    ticketId,
    "SETTLEMENT",
    `settlement-${runId}`,
    settlementHash,
    "COMPLETED",
    JSON.stringify({ outcome: "WIN" }),
    `correlation:${runId}`,
  ]);
  check(
    "Outcome and Settlement delivery is correlated idempotently",
    duplicateSettlement.rows[0].result.duplicate === true
  );
  await client.query(correlationSql, [
    ticketId,
    "LEDGER_ENTRY",
    `ledger-${runId}`,
    `sha256:${"c".repeat(64)}`,
    "POSTED",
    "{}",
    `correlation:${runId}`,
  ]);
  await client.query(correlationSql, [
    ticketId,
    "WALLET_OPERATION",
    `wallet-${runId}`,
    `sha256:${"d".repeat(64)}`,
    "SETTLED",
    "{}",
    `correlation:${runId}`,
  ]);
  await client.query(correlationSql, [
    ticketId,
    "RESETTLEMENT",
    `resettlement-${runId}`,
    `sha256:${"e".repeat(64)}`,
    "CORRECTED",
    "{}",
    `correlation:${runId}`,
  ]);
  const settled = await client.query(
    `select status, acceptance_hash,
      (select count(*) from ticket_authority.ticket_correlations c
       where c.ticket_id=t.ticket_id) correlations,
      (select count(*) from ticket_authority.ticket_lifecycle_events e
       where e.ticket_id=t.ticket_id) lifecycle
     from ticket_authority.tickets t where ticket_id=$1`,
    [ticketId]
  );
  check(
    "settled ticket preserves immutable Outcome Settlement Ledger and Wallet chain",
    settled.rows[0].status === "SETTLED" &&
      Number(settled.rows[0].correlations) === 5 &&
      Number(settled.rows[0].lifecycle) >= 5
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
  await rejected(
    "effective wager limit intersects applicable parent and child scopes",
    () =>
      client.query(acceptSql, [
        ...baseArgs.slice(0, 10),
        `limit-${suffix}`,
        ...baseArgs.slice(11, 13),
        `limit:${runId}`,
        ...baseArgs.slice(14),
      ]),
    /effective maximum wager/
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
