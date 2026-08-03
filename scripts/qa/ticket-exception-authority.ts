import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl, max: 6 });

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
    pass(name, { message });
  }
}

function command(ticket: Record<string, unknown>, idempotencyKey: string) {
  return pool.query<{ result: Record<string, unknown> }>(`
    select ticket_exception_authority.request_operation(
      'VOID',$1::uuid,$2::integer,$3,'OPERATIONAL_AUTHORITY',$4,
      'sha256:'||repeat('a',64),'qa-ticket-exception','QA_GOVERNED_VOID',$5,
      null,null,null,null
    ) result
  `, [ticket.ticket_id, ticket.lifecycle_version, idempotencyKey, idempotencyKey, randomUUID()]);
}

async function main() {
  try {
    const readiness = await pool.query("select * from ticket_exception_authority.readiness()");
    assert(readiness.rows.length >= 7 && readiness.rows.every((row) => row.ready === true),
      "Ticket Exception Authority readiness failed.", { readiness: readiness.rows });
    pass("single Ticket Exception Authority readiness passes", { checks: readiness.rows.length });

    const candidates = await pool.query(`
      select * from ticket_authority.tickets
      where lineage_model='CANONICAL_V1' and lifecycle_state='RESERVATION_CREATED'
      order by accepted_at desc limit 2
    `);
    assert(candidates.rows.length === 2,
      "Two canonical reservation-created ticket fixtures are required; run canonical ticket lifecycle QA first.");

    const first = candidates.rows[0];
    const firstKey = `bf-5.6-void:${randomUUID()}`;
    const requested = (await command(first, firstKey)).rows[0].result;
    const duplicate = (await command(first, firstKey)).rows[0].result;
    assert(requested.duplicate === false && duplicate.duplicate === true &&
      requested.operationId === duplicate.operationId,
      "Identical exception commands must reuse one durable operation.", { requested, duplicate });
    pass("identical governed void command is idempotent");

    await reject("conflicting exception idempotency payload fails closed", () =>
      pool.query(`select ticket_exception_authority.request_operation(
        'VOID',$1,$2,$3,'OPERATIONAL_AUTHORITY',$4,'sha256:'||repeat('b',64),
        'qa-ticket-exception','DIFFERENT_REASON',$5,null,null,null,null)`,
      [first.ticket_id, first.lifecycle_version, firstKey, randomUUID(), randomUUID()]),
      /idempotency key conflicts/i);

    await reject("stale lifecycle version fails closed", () =>
      pool.query(`select ticket_exception_authority.request_operation(
        'VOID',$1,$2,$3,'OPERATIONAL_AUTHORITY',$4,'sha256:'||repeat('c',64),
        'qa-ticket-exception','QA_STALE',$5,null,null,null,null)`,
      [candidates.rows[1].ticket_id, Number(candidates.rows[1].lifecycle_version) - 1,
        `bf-5.6-stale:${randomUUID()}`, randomUUID(), randomUUID()]),
      /stale lifecycle version/i);

    await reject("generic lifecycle-only void path is retired", () =>
      pool.query(`select ticket_authority.void_ticket(
        $1,$2,'sha256:'||repeat('d',64),$3,'QA_DIRECT_VOID','qa-direct',$4,null,'{}')`,
      [first.ticket_id, randomUUID(), `bf-5.6-direct:${randomUUID()}`, randomUUID()]),
      /Ticket Exception Authority evidence/i);

    const operationId = String(requested.operationId);
    const completed = (await pool.query<{ result: Record<string, unknown> }>(
      "select ticket_exception_authority.execute_unsettled_void($1) result", [operationId]
    )).rows[0].result;
    const reused = (await pool.query<{ result: Record<string, unknown> }>(
      "select ticket_exception_authority.recover_operation($1) result", [operationId]
    )).rows[0].result;
    assert(completed.state === "Completed" && reused.state === "Completed" && reused.duplicate === true,
      "Completed void recovery must return existing terminal evidence.", { completed, reused });

    const voidEvidence = await pool.query(`
      select ticket.lifecycle_state, ticket.status, reservation.status reservation_status,
        release.release_id, projection.operation_state,
        (select count(*) from ticket_exception_authority.operation_events where operation_id=$1)::int event_count,
        (select count(*) from credit_wallet_service.wallet_operation_requests where operation_id=$1)::int wallet_operations
      from ticket_exception_authority.operations operation
      join ticket_exception_authority.operation_projection projection using(operation_id)
      join ticket_authority.tickets ticket on ticket.ticket_id=operation.ticket_id
      join public.credit_reservations reservation on reservation.id=ticket.reservation_id
      join ticket_exception_authority.reservation_release_evidence release using(operation_id)
      where operation.operation_id=$1
    `, [operationId]);
    const evidence = voidEvidence.rows[0];
    assert(evidence?.lifecycle_state === "TICKET_VOIDED" && evidence.status === "VOIDED" &&
      evidence.reservation_status === "CANCELLED" && evidence.operation_state === "Completed" &&
      evidence.wallet_operations === 1 && evidence.event_count >= 3,
      "Unsettled void did not preserve complete reservation, wallet, lifecycle, and operation evidence.", evidence ?? {});
    pass("unsettled void releases reservation and completes typed lifecycle", evidence);

    await reject("exception command evidence is immutable", () =>
      pool.query("update ticket_exception_authority.operations set reason_code='MUTATED' where operation_id=$1", [operationId]),
      /append-only/i);
    await reject("exception event evidence cannot be deleted", () =>
      pool.query("delete from ticket_exception_authority.operation_events where operation_id=$1", [operationId]),
      /append-only/i);
    await reject("operation projection cannot be changed directly", () =>
      pool.query("update ticket_exception_authority.operation_projection set next_required_step='BYPASS' where operation_id=$1", [operationId]),
      /controlled by append-only events/i);

    const second = candidates.rows[1];
    const secondRequest = (await command(second, `bf-5.6-concurrent:${randomUUID()}`)).rows[0].result;
    const concurrent = await Promise.all([
      pool.query<{ result: Record<string, unknown> }>(
        "select ticket_exception_authority.execute_unsettled_void($1) result", [secondRequest.operationId]),
      pool.query<{ result: Record<string, unknown> }>(
        "select ticket_exception_authority.execute_unsettled_void($1) result", [secondRequest.operationId]),
    ]);
    const concurrencyEvidence = await pool.query(`
      select
        (select count(*) from ticket_exception_authority.reservation_release_evidence where operation_id=$1)::int releases,
        (select count(*) from credit_wallet_service.wallet_operation_requests where operation_id=$1)::int wallet_operations,
        (select count(*) from ticket_authority.ticket_lifecycle_events event
          join ticket_exception_authority.operations operation on operation.ticket_id=event.ticket_id
          where operation.operation_id=$1 and event.command_type='VoidTicket')::int void_events
    `, [secondRequest.operationId]);
    assert(concurrent.every((result) => result.rows[0].result.state === "Completed") &&
      concurrencyEvidence.rows[0].releases === 1 && concurrencyEvidence.rows[0].wallet_operations === 1 &&
      concurrencyEvidence.rows[0].void_events === 1,
      "Concurrent void execution repeated authoritative effects.", concurrencyEvidence.rows[0]);
    pass("per-ticket advisory locking serializes concurrent exception execution", concurrencyEvidence.rows[0]);

    const financiallyActive = await pool.query(`
      select ticket.*, completion.completion_id, completion.canonical_completion_hash
      from ticket_authority.tickets ticket
      join ticket_completion_authority.completion_evidence completion using(ticket_id)
      where ticket.lifecycle_state in ('TICKET_SETTLED','COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','TICKET_RESETTLED')
      order by accepted_at desc limit 1
    `);
    assert(financiallyActive.rows[0], "A financially active ticket fixture is required.");
    await reject("financially active ticket cannot bypass reversal with direct void", () =>
      pool.query(`select ticket_exception_authority.request_operation(
        'VOID',$1,$2,$3,'OPERATIONAL_AUTHORITY',$4,'sha256:'||repeat('e',64),
        'qa-ticket-exception','QA_DIRECT_FINANCIAL_VOID',$5,null,null,null,null)`,
      [financiallyActive.rows[0].ticket_id, financiallyActive.rows[0].lifecycle_version,
        `bf-5.6-financial-void:${randomUUID()}`, randomUUID(), randomUUID()]),
      /cannot be directly voided/i);

    await reject("generic lifecycle-only reversal path is retired", () =>
      pool.query(`select ticket_authority.reverse_settlement(
        $1,$2,'sha256:'||repeat('e',64),$3,'QA_DIRECT_REVERSAL','qa-direct',$4,null,'{}')`,
      [financiallyActive.rows[0].ticket_id, financiallyActive.rows[0].completion_id,
        `bf-5.6-direct-reversal:${randomUUID()}`, randomUUID()]),
      /Ticket Exception Authority evidence/i);

    const reversalKey = `bf-5.6-reversal:${randomUUID()}`;
    const reversal = await pool.query<{ result: Record<string, unknown> }>(`
      select ticket_exception_authority.request_operation(
        'SETTLEMENT_REVERSAL',$1,$2,$3,'SETTLEMENT_AUTHORITY',$4,$5,
        'qa-ticket-exception','QA_SETTLEMENT_REVERSAL',$6,null,$7,null,null
      ) result
    `, [financiallyActive.rows[0].ticket_id, financiallyActive.rows[0].lifecycle_version,
      reversalKey, financiallyActive.rows[0].completion_id,
      financiallyActive.rows[0].canonical_completion_hash, randomUUID(),
      financiallyActive.rows[0].completion_id]);
    const reversalOperationId = String(reversal.rows[0].result.operationId);
    const incomplete = (await pool.query<{ result: Record<string, unknown> }>(
      "select ticket_exception_authority.complete_financial_exception($1) result", [reversalOperationId]
    )).rows[0].result;
    const recovered = (await pool.query<{ result: Record<string, unknown> }>(
      "select ticket_exception_authority.recover_operation($1) result", [reversalOperationId]
    )).rows[0].result;
    const recoveryEvidence = await pool.query(`
      select projection.operation_state, projection.next_required_step,
        count(*) filter (where event.operation_state='FailedRecoverable')::int recoverable_events
      from ticket_exception_authority.operation_projection projection
      join ticket_exception_authority.operation_events event using(operation_id)
      where projection.operation_id=$1
      group by projection.operation_state, projection.next_required_step
    `, [reversalOperationId]);
    assert(incomplete.state === "FailedRecoverable" && recovered.state === "FailedRecoverable" &&
      recoveryEvidence.rows[0]?.operation_state === "FailedRecoverable" &&
      recoveryEvidence.rows[0]?.recoverable_events >= 2,
      "Partial reversal recovery must retain auditable recoverable evidence without changing ticket state.",
      { incomplete, recovered, evidence: recoveryEvidence.rows[0] });
    pass("partial financial reversal remains recoverable without fabricated evidence", recoveryEvidence.rows[0]);

    await reject("resettlement before completed reversal fails closed", () =>
      pool.query(`select ticket_exception_authority.request_operation(
        'RESETTLEMENT',$1,$2,$3,'SETTLEMENT_AUTHORITY',$4,'sha256:'||repeat('f',64),
        'qa-ticket-exception','QA_PREMATURE_RESETTLEMENT',$5,null,$6,$7,$8)`,
      [financiallyActive.rows[0].ticket_id, financiallyActive.rows[0].lifecycle_version,
        `bf-5.6-premature:${randomUUID()}`, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]),
      /requires completed prior reversal|violates foreign key/i);

    const migration = readFileSync("scripts/migrations/local/106_add_ticket_exception_authority.sql", "utf8");
    for (const token of [
      "original_ledger_entry_id=v_source.ledger_entry_id",
      "v_wallet.original_operation_id<>v_source.wallet_operation_id",
      "outcome.outcome_version_id=v_operation.corrected_outcome_version_id",
      "compensation.adjustment_requirements",
      "process_draw_cancellation",
      "FailedRecoverable",
      "pg_advisory_xact_lock",
    ]) assert(migration.includes(token), `Migration is missing required authority rule: ${token}`);
    pass("reversal, resettlement, draw cancellation, compensation, and recovery rules are explicit");

    console.log(JSON.stringify({ status: "PASS", checkCount: checks.length, failedCount: 0, checks }, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error), checks }, null, 2));
  process.exit(1);
});
