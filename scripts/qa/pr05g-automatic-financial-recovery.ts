import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import {
  seedSettlementFixture,
  type SettlementFixture,
} from "./lib/credit-wallet-settlement-fixture";

type TicketFixture = {
  ticket_id: string;
  tenant_id: string;
  brand_id: string;
  player_account_id: string;
  reservation_id: string;
  currency: string;
  total_stake_minor: string;
  items: Array<{ ticketItemId: string; stakeMinor: number }>;
};

type RecoveryFixture = SettlementFixture & {
  ticketId: string;
  ticketItemId: string;
};

const databaseUrl = process.env.DATABASE_URL?.trim();
const settlementUrl = (process.env.SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:5400")
  .replace(/\/$/, "");
const checks: Array<{ name: string; status: "PASS"; metadata?: unknown }> = [];

function fail(message: string, metadata: unknown = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}

function assert(value: unknown, message: string, metadata: unknown = {}): asserts value {
  if (!value) fail(message, metadata);
}

function pass(name: string, metadata: unknown = {}) {
  checks.push({ name, status: "PASS", metadata });
}

function command(commandName: string, args: string[], environment: Record<string, string> = {}) {
  const result = spawnSync(commandName, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.status !== 0) {
    fail(`${commandName} ${args.join(" ")} failed.`, {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

async function waitFor<T>(
  name: string,
  operation: () => Promise<T | null | false>,
  timeoutMs = 240_000,
  intervalMs = 500,
) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(`${name} did not converge before timeout.`, { lastError: String(lastError ?? "") });
}

async function waitForSettlementHealth() {
  return waitFor("Settlement automatic recovery health", async () => {
    const response = await fetch(`${settlementUrl}/health/automatic-financial-recovery`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.status === "ok" ? body : null;
  });
}

async function waitForSettlementLive() {
  return waitFor("Settlement Service liveness", async () => {
    const response = await fetch(`${settlementUrl}/health/live`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? true : null;
  });
}

async function postInstruction(instructionId: string) {
  const response = await fetch(
    `${settlementUrl}/v1/settlement/financial-instructions/${instructionId}/execute`,
    {
      method: "POST",
      headers: { "x-correlation-id": `pr05g-stage-${randomUUID()}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* retain text */ }
  assert(response.ok, "Focused recovery setup instruction failed.", {
    instructionId,
    status: response.status,
    body,
  });
  return body;
}

async function loadTickets(pool: Pool) {
  const result = await pool.query<TicketFixture>(`
select
  ticket.ticket_id::text,
  ticket.tenant_id::text,
  ticket.brand_id::text,
  ticket.player_account_id::text,
  ticket.reservation_id::text,
  ticket.currency,
  ticket.total_stake_minor::text,
  jsonb_agg(jsonb_build_object(
    'ticketItemId', item.ticket_item_id,
    'stakeMinor', item.stake_minor
  ) order by item.item_index) items
from ticket_authority.tickets ticket
join ticket_authority.ticket_items item using(ticket_id)
where ticket.lifecycle_state='SETTLEMENT_REQUESTED'
  and ticket.funding_instrument='CREDIT'
  and not exists (
    select 1 from ticket_completion_authority.completion_evidence evidence
    where evidence.ticket_id=ticket.ticket_id
  )
  and not exists (
    select 1 from settlement_service.authoritative_settlement_records settlement
    where settlement.ticket_id=ticket.ticket_id::text
  )
group by ticket.ticket_id
having count(*) >= 2
order by ticket.accepted_at desc
limit 2`);
  assert(result.rows.length === 2,
    "Focused recovery QA requires two untouched canonical CREDIT tickets with at least two items.",
    { available: result.rows.length });
  return result.rows;
}

async function seedTicketSettlements(pool: Pool, ticket: TicketFixture) {
  const fixtures: RecoveryFixture[] = [];
  for (const item of ticket.items) {
    const fixture = await seedSettlementFixture(pool, {
      tenantId: ticket.tenant_id,
      brandId: ticket.brand_id,
      reservationId: ticket.reservation_id,
      ticketId: ticket.ticket_id,
      ticketLineId: item.ticketItemId,
      playerAccountReference: ticket.player_account_id,
      amountMinor: item.stakeMinor,
      balanceImpactMinor: 25,
      currency: ticket.currency,
      ledgerRequired: true,
      provenance: { qa: "pr05g-automatic-financial-recovery" },
    });
    fixtures.push({ ...fixture, ticketId: ticket.ticket_id, ticketItemId: item.ticketItemId });
  }
  return fixtures;
}

async function futureHotSpotHash(pool: Pool) {
  const result = await pool.query(`
select coalesce(jsonb_agg(jsonb_build_object(
  'participationId', participation.participation_id,
  'ticketItemId', participation.ticket_item_id,
  'drawId', participation.draw_id,
  'drawSequence', participation.draw_sequence,
  'stakeMinor', participation.allocated_stake_minor
) order by participation.participation_id), '[]'::jsonb) evidence
from game_engine.hot_spot_multi_draw_participations participation
join game_engine.durable_scheduler_draws draw on draw.draw_id=participation.draw_id
where draw.scheduled_execution_at > clock_timestamp() + interval '10 minutes'
  and not exists (
    select 1 from game_engine.hot_spot_multi_draw_participation_events event
    where event.participation_id=participation.participation_id
      and event.event_type='CANCELLED'
  )`);
  return createHash("sha256").update(JSON.stringify(result.rows[0].evidence)).digest("hex");
}

async function incompleteInstructionBacklog(pool: Pool) {
  const result = await pool.query(`
select count(*)::int backlog
from settlement_service.financial_instructions instruction
where not exists (
  select 1
  from settlement_service.financial_instruction_execution_attempts attempt
  where attempt.instruction_id=instruction.instruction_id
    and attempt.status in ('Posted','Skipped')
)`);
  return Number(result.rows[0].backlog);
}

async function automaticFailedClosedEventCount(pool: Pool) {
  const result = await pool.query(`
select count(*)::int events
from settlement_service.recovery_events
where decision='automatic-recovery-failed-closed'`);
  return Number(result.rows[0].events);
}

async function verifyConvergence(pool: Pool, tickets: TicketFixture[], fixtures: RecoveryFixture[]) {
  const settlementIds = fixtures.map((fixture) => fixture.settlementId);
  return waitFor("automatic Settlement to Completion convergence", async () => {
    const result = await pool.query(`
select
  (select count(*)::int
   from settlement_service.financial_instructions instruction
   where instruction.settlement_id=any($1::uuid[])) instruction_count,
  (select count(*)::int
   from settlement_service.financial_instruction_execution_attempts attempt
   where attempt.settlement_id=any($1::uuid[])
     and attempt.status in ('Posted','Skipped')) terminal_attempts,
  (select count(*)::int
   from ticket_completion_authority.completion_evidence completion
   where completion.ticket_id=any($2::uuid[])) completion_count,
  (select count(*)::int
   from settlement_service.financial_instructions instruction
   where instruction.settlement_id=any($1::uuid[])
     and not exists (
       select 1 from settlement_service.financial_instruction_execution_attempts attempt
       where attempt.instruction_id=instruction.instruction_id
         and attempt.status in ('Posted','Skipped')
     )) unresolved_instructions`, [settlementIds, tickets.map((ticket) => ticket.ticket_id)]);
    const row = result.rows[0];
    return Number(row.instruction_count) === fixtures.length * 2 &&
      Number(row.terminal_attempts) === fixtures.length * 2 &&
      Number(row.completion_count) === tickets.length &&
      Number(row.unresolved_instructions) === 0 ? row : null;
  });
}

async function verifyIntegrity(pool: Pool, tickets: TicketFixture[], fixtures: RecoveryFixture[]) {
  const settlementIds = fixtures.map((fixture) => fixture.settlementId);
  const result = await pool.query(`
select
  (select count(*)::int from (
    select instruction_id
    from settlement_service.financial_instruction_execution_attempts
    where settlement_id=any($1::uuid[]) and status in ('Posted','Skipped')
    group by instruction_id having count(*) > 1
  ) duplicate) duplicate_terminal_attempts,
  (select count(*)::int from (
    select settlement_record_id
    from ledger_service.ledger_posting_requests
    where settlement_record_id=any($1::uuid[])
    group by settlement_record_id having count(*) > 1
  ) duplicate) duplicate_ledger_effects,
  (select count(*)::int from (
    select settlement_id
    from credit_wallet_service.wallet_operation_requests
    where settlement_id=any($1::uuid[])
    group by settlement_id having count(*) > 1
  ) duplicate) duplicate_wallet_effects,
  (select count(*)::int
   from settlement_service.recovery_events
   where settlement_id=any($1::uuid[])
     and decision in ('automatic-missing-stage-resumed','automatic-completion-converged')) recovery_events,
  (select count(*)::int
   from ticket_authority.tickets
   where ticket_id=any($2::uuid[]) and status='SETTLED') settled_tickets,
  (select count(*)::int
   from public.credit_reservations reservation
   where reservation.id=any($3::uuid[])
     and reservation.released_amount + reservation.captured_amount +
       reservation.remaining_exposure = reservation.reserved_amount) reconciled_reservations,
  (select count(*)::int
   from ticket_completion_authority.completion_sources source
   join ticket_completion_authority.completion_requests request
     on request.request_id=source.request_id
   where request.ticket_id=any($2::uuid[])) completion_sources,
  (select count(*)::int
   from ticket_completion_authority.completion_sources source
   join ticket_completion_authority.completion_requests request
     on request.request_id=source.request_id
   join settlement_service.authoritative_settlement_records settlement
     on settlement.settlement_id=source.settlement_id
   join settlement_service.financial_instruction_execution_attempts ledger_attempt
     on ledger_attempt.attempt_id=source.ledger_execution_attempt_id
   join settlement_service.financial_instruction_execution_attempts wallet_attempt
     on wallet_attempt.attempt_id=source.wallet_execution_attempt_id
   where request.ticket_id=any($2::uuid[])
     and (settlement.ticket_id<>request.ticket_id::text
       or ledger_attempt.settlement_id<>settlement.settlement_id
       or ledger_attempt.target_service<>'ledger-service'
       or wallet_attempt.settlement_id<>settlement.settlement_id
       or wallet_attempt.target_service<>'credit-wallet-service')) invalid_completion_lineage`, [
    settlementIds,
    tickets.map((ticket) => ticket.ticket_id),
    tickets.map((ticket) => ticket.reservation_id),
  ]);
  const row = result.rows[0];
  assert(Number(row.duplicate_terminal_attempts) === 0,
    "Automatic recovery created duplicate terminal attempts.", row);
  assert(Number(row.duplicate_ledger_effects) === 0,
    "Automatic recovery created duplicate Ledger effects.", row);
  assert(Number(row.duplicate_wallet_effects) === 0,
    "Automatic recovery created duplicate Wallet effects.", row);
  assert(Number(row.recovery_events) >= fixtures.length,
    "Automatic recovery evidence was not appended.", row);
  assert(Number(row.settled_tickets) === tickets.length,
    "Recovered tickets did not reach the canonical terminal state.", row);
  assert(Number(row.reconciled_reservations) === tickets.length,
    "Recovered reservation exposure does not reconcile.", row);
  assert(Number(row.completion_sources) === tickets.reduce((sum, ticket) => sum + ticket.items.length, 0),
    "Recovery did not persist one exact Completion source per ticket item.", row);
  assert(Number(row.invalid_completion_lineage) === 0,
    "Recovery Completion evidence does not preserve exact Settlement/Ledger/Wallet lineage.", row);
  return row;
}

async function main() {
  assert(databaseUrl, "DATABASE_URL is required for PR-05G recovery QA.");
  assert(/127\.0\.0\.1|localhost/.test(databaseUrl),
    "PR-05G infrastructure failure injection is restricted to a local disposable database.");

  command("docker", ["compose", "up", "-d", "--force-recreate", "settlement-service"], {
    SETTLEMENT_AUTOMATIC_RECOVERY_ENABLED: "false",
  });
  await waitForSettlementLive();

  let pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const baselineBacklog = await incompleteInstructionBacklog(pool);
  const tickets = await loadTickets(pool);
  const futureBefore = await futureHotSpotHash(pool);
  const first = await seedTicketSettlements(pool, tickets[0]);
  const second = await seedTicketSettlements(pool, tickets[1]);
  const fixtures = [...first, ...second];

  await postInstruction(first[0].ledgerInstructionId);
  await postInstruction(first[0].creditInstructionId);
  pass("Wallet-complete item remains pending until sibling financial evidence exists");
  await postInstruction(second[0].ledgerInstructionId);
  pass("Ledger-complete item remains pending for automatic Wallet recovery");
  pass("Settlement-only items remain durable for automatic Ledger recovery", {
    count: fixtures.length - 2,
  });

  command("docker", ["compose", "restart", "rabbitmq"]);
  command("docker", ["compose", "restart", "worker-settlement"]);
  command("docker", ["compose", "up", "-d", "--force-recreate", "settlement-service"], {
    SETTLEMENT_AUTOMATIC_RECOVERY_ENABLED: "true",
    SETTLEMENT_AUTOMATIC_RECOVERY_GRACE_MS: "30000",
  });
  await pool.end();
  command("docker", ["compose", "restart", "local-postgres"]);

  await waitForSettlementHealth();
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const converged = await verifyConvergence(pool, tickets, fixtures);
  pass("worker, RabbitMQ, and PostgreSQL restarts converge automatically", converged);
  const integrity = await verifyIntegrity(pool, tickets, fixtures);
  pass("recovery accounting, idempotency, and terminal evidence are exact", integrity);
  const futureAfter = await futureHotSpotHash(pool);
  assert(futureAfter === futureBefore,
    "Automatic recovery changed future Hot Spot multi-draw exposure.", {
      futureBefore,
      futureAfter,
    });
  pass("future Hot Spot multi-draw exposure remains untouched");

  const health = await waitForSettlementHealth();
  const failedClosedEvents = await automaticFailedClosedEventCount(pool);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const failedClosedEventsAfter = await automaticFailedClosedEventCount(pool);
  assert(failedClosedEventsAfter === failedClosedEvents,
    "Terminal fail-closed recovery evidence was appended repeatedly.", {
      failedClosedEvents,
      failedClosedEventsAfter,
    });
  pass("terminal fail-closed units are not reselected", { failedClosedEvents });
  const finalBacklog = await incompleteInstructionBacklog(pool);
  assert(finalBacklog <= baselineBacklog,
    "Automatic recovery introduced unresolved financial instruction backlog.", {
      baselineBacklog,
      finalBacklog,
      health,
    });
  pass("PR-05G fixture backlog drains without increasing historical backlog", {
    baselineBacklog,
    finalBacklog,
    health: health.recovery,
  });
  await pool.end();

  console.log(JSON.stringify({
    status: "PR_05G_AUTOMATIC_FINANCIAL_RECOVERY_PASS",
    checks,
    tickets: tickets.map((ticket) => ticket.ticket_id),
    settlementIds: fixtures.map((fixture) => fixture.settlementId),
  }, null, 2));
}

const keepAlive = setInterval(() => undefined, 1_000);
main()
  .then(() => clearInterval(keepAlive))
  .catch((error) => fail(
    error instanceof Error ? error.message : "PR-05G automatic recovery QA failed.",
    { error: String(error) },
  ));
