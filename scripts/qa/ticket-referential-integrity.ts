import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) {
    console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
    process.exit(1);
  }
}
async function reject(name: string, operation: () => Promise<unknown>, pattern: RegExp) {
  try {
    await operation();
    assert(false, `${name} unexpectedly succeeded.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `${name} failed for the wrong reason.`, { message });
    pass(name);
  }
}

async function main() {
try {
  const ticketResult = await pool.query(`
    select ticket.*, item.ticket_item_id, item.item_index
    from ticket_authority.tickets ticket
    join lateral (
      select ticket_item_id, item_index
      from ticket_authority.ticket_items
      where ticket_id = ticket.ticket_id
      order by item_index limit 1
    ) item on true
    where ticket.lineage_model = 'CANONICAL_V1'
    order by ticket.accepted_at desc limit 1
  `);
  const ticket = ticketResult.rows[0];
  assert(ticket, "Canonical ticket fixture is required before BF-5.5 QA.");

  const readiness = await pool.query(
    "select * from ticket_authority.ticket_referential_integrity_readiness()"
  );
  assert(readiness.rows.every((row) => row.ready === true),
    "Ticket referential integrity readiness failed.", { readiness: readiness.rows });
  pass("canonical referential-integrity readiness passes", { checks: readiness.rows.length });

  const lineage = await pool.query(`
    select
      manifest.execution_manifest_id = ticket.execution_manifest_id manifest_exact,
      manifest.draw_id = ticket.draw_id manifest_draw_exact,
      manifest.game_definition_version_id = ticket.product_version_id manifest_product_exact,
      manifest.paytable_version = ticket.paytable_version manifest_paytable_exact,
      wallet.account_id = ticket.player_account_id wallet_owner_exact,
      wallet.wallet_type = ticket.funding_instrument wallet_funding_exact,
      reservation.ticket_id = ticket.ticket_id::text reservation_ticket_exact,
      reservation.wallet_id = ticket.wallet_id reservation_wallet_exact,
      reservation.player_id = ticket.player_account_id reservation_player_exact,
      decision.selected_availability_id = ticket.game_availability_id availability_exact
    from ticket_authority.tickets ticket
    join game_engine.draw_execution_manifests manifest
      on manifest.execution_manifest_id = ticket.execution_manifest_id
    join public.financial_wallets wallet on wallet.id = ticket.wallet_id
    join public.credit_reservations reservation on reservation.id = ticket.reservation_id
    join ticket_authority.availability_decisions decision
      on decision.ticket_id = ticket.ticket_id
    where ticket.ticket_id = $1
  `, [ticket.ticket_id]);
  assert(lineage.rows[0] && Object.values(lineage.rows[0]).every(Boolean),
    "Canonical ticket exact lineage is incomplete.", lineage.rows[0] ?? {});
  pass("ticket binds exact draw manifest, version, availability, wallet, and reservation evidence");

  const invalidDrawId = randomUUID();
  const invalidScheduleVersionId = randomUUID();
  await pool.query(`
    insert into game_engine.published_draw_schedule_versions(
      schedule_version_id, schedule_id, version_number, game_definition_id,
      draw_authority_assignment_id, schedule_kind, schedule_configuration,
      time_zone_id, schedule_hash, published_at
    ) select $1::uuid,$2::uuid,1,draw.game_definition_id,draw.draw_authority_assignment_id,
      'BF-5.5-QA','{}','UTC','sha256:' || repeat('5',64),now()
    from game_engine.draw_schedules draw where draw.id=$3::uuid
  `, [invalidScheduleVersionId, invalidDrawId, ticket.draw_id]);
  await pool.query(`
    insert into game_engine.draw_schedules(
      id, game_definition_id, draw_authority_assignment_id,
      sales_open_at, sales_close_at, draw_at, status,
      schedule_version_id, scheduled_execution_at, schedule_hash, draw_identity_hash
    ) select $2::uuid,draw.game_definition_id,draw.draw_authority_assignment_id,
      now()-interval '1 minute',now()+interval '1 hour',now()+interval '61 minutes',
      'SalesOpen',$1,now()+interval '61 minutes','sha256:' || repeat('5',64),
      'sha256:' || encode(digest(convert_to(($2::uuid)::text,'UTF8'),'sha256'),'hex')
    from game_engine.draw_schedules draw where draw.id=$3::uuid
  `, [invalidScheduleVersionId, invalidDrawId, ticket.draw_id]);

  await reject("ticket without exact execution manifest fails closed", () => pool.query(`
    insert into ticket_authority.tickets
    select (jsonb_populate_record(
      null::ticket_authority.tickets,
      to_jsonb(ticket) || jsonb_build_object(
        'ticket_id',$1::text,
        'draw_id',$2::text,
        'execution_manifest_id',null,
        'execution_manifest_hash',null,
        'idempotency_key',$3::text,
        'correlation_id',$4::text,
        'external_ticket_id',null
      )
    )).*
    from ticket_authority.tickets ticket where ticket.ticket_id=$5::uuid
  `, [randomUUID(), invalidDrawId, `bf-5.5-no-manifest:${randomUUID()}`,
      `bf-5.5:${randomUUID()}`, ticket.ticket_id]),
  /exact Draw Execution Manifest/);

  await reject("ticket item wager schema/version mismatch fails closed", () => pool.query(`
    insert into ticket_authority.ticket_items(
      ticket_item_id,ticket_id,item_index,wager_type,wager_version,
      normalized_selections,stake_minor,item_hash
    ) values ($1,$2,$3,'UNAUTHORIZED','999','{}',1,'sha256:' || repeat('9',64))
  `, [randomUUID(), ticket.ticket_id, Number(ticket.item_index) + 10_000]),
  /not authorized by the parent manifest/);

  await reject("reservation reassignment remains blocked", () => pool.query(
    "update public.credit_reservations set ticket_id=$1 where id=$2",
    [randomUUID(), ticket.reservation_id]
  ), /immutable|projection/i);

  await reject("canonical ticket deletion is restricted", () => pool.query(
    "delete from ticket_authority.tickets where ticket_id=$1", [ticket.ticket_id]
  ), /append-only|violates foreign key/i);

  await reject("wallet owner deletion is restrictive", () => pool.query(
    "delete from public.accounts where id=$1", [ticket.player_account_id]
  ), /violates foreign key|governance|delete/i);

  const legacyGuard = await pool.query<{ definition: string }>(`
    select pg_get_functiondef('ticket_authority.guard_ticket_lineage_update()'::regprocedure) definition
  `);
  assert(legacyGuard.rows[0].definition.includes("LEGACY_READ_ONLY") &&
    legacyGuard.rows[0].definition.includes("read-only"),
  "Legacy read-only enforcement is missing.");
  pass("pre-manifest history is explicitly classified and read-only");

  const migration = readFileSync(
    "scripts/migrations/local/105_add_ticket_referential_integrity.sql", "utf8"
  );
  for (const token of [
    "fk_ticket_execution_manifest_lineage",
    "fk_ticket_wallet_lineage",
    "fk_completion_evidence_lifecycle_ticket",
    "trg_validate_completion_source_lineage",
    "trg_validate_internal_lifecycle_source_lineage",
    "on delete restrict",
  ]) {
    assert(migration.toLowerCase().includes(token.toLowerCase()),
      `Migration is missing ${token}.`);
  }
  pass("migration preserves restrictive immutable lineage constraints");

  const sourceMismatchCount = await pool.query(`
    select count(*)::int count
    from ticket_completion_authority.completion_sources source
    join ticket_completion_authority.completion_requests request using(request_id)
    join ticket_authority.ticket_items item using(ticket_item_id)
    join settlement_service.authoritative_settlement_records settlement using(settlement_id)
    where item.ticket_id <> request.ticket_id
       or settlement.ticket_id <> request.ticket_id::text
       or settlement.ticket_line_id <> item.ticket_item_id::text
  `);
  assert(sourceMismatchCount.rows[0].count === 0,
    "Completion source lineage contains mismatches.", sourceMismatchCount.rows[0]);
  pass("Settlement and completion ticket/item lineage is exact");

  console.log(JSON.stringify({
    status: "PASS",
    message: "BF-5.5 Ticket Referential Integrity QA passed.",
    checkCount: checks.length,
    checks,
  }, null, 2));
} finally {
  await pool.end();
}
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "FAIL",
    message: error instanceof Error ? error.message : String(error),
    checks,
  }, null, 2));
  process.exit(1);
});
