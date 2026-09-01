import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";

import {
  closePostgresOutboxPool,
  listDispatchablePostgresOutboxEvents,
  markPostgresOutboxEventsPublished,
} from "@/src/domains/outbox/outbox.postgres.repository";

type TierResult = {
  size: number;
  claimed: number;
  duplicateClaims: number;
  claimCalls: number;
  totalMs: number;
  claimP95Ms: number;
  claimMaxMs: number;
  published: number;
};

const databaseUrl = process.env.DATABASE_URL?.trim() ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const campaignId = `pr05m-${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z-${randomUUID().slice(0, 8)}`;
const aggregateType = `pr05m_tail_${campaignId}`;
const checks: Array<{ name: string; status: "PASS"; evidence: unknown }> = [];

function assert(condition: unknown, name: string, evidence: unknown = {}): asserts condition {
  if (!condition) {
    console.error(JSON.stringify({ status: "FAIL", campaignId, name, evidence, checks }, null, 2));
    process.exitCode = 1;
    throw new Error(name);
  }
  checks.push({ name, status: "PASS", evidence });
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

async function insertTier(size: number, correlationId: string) {
  const result = await pool.query(`
insert into public.outbox_events (
  event_type, aggregate_type, aggregate_id, payload, status, correlation_id, next_attempt_at
)
select
  case when sequence % 2 = 0 then 'settlement.requested' else 'pr05m.dispatch.probe' end,
  $1,
  $2 || ':' || sequence::text,
  jsonb_build_object('campaignId', $2::text, 'sequence', sequence),
  'PENDING',
  $3,
  clock_timestamp()
from generate_series(1, $4::int) sequence
returning id::text
`, [aggregateType, campaignId, correlationId, size]);
  assert(result.rowCount === size, `tier ${size} inserted`, { expected: size, actual: result.rowCount });
}

async function claimTier(size: number): Promise<TierResult> {
  const correlationId = `${campaignId}:tier:${size}`;
  await insertTier(size, correlationId);

  const seen = new Set<string>();
  const claimLatencies: number[] = [];
  let duplicateClaims = 0;
  let claimCalls = 0;
  const startedAt = performance.now();

  async function claimant() {
    while (seen.size < size) {
      const claimStartedAt = performance.now();
      const events = await listDispatchablePostgresOutboxEvents({
        limit: 250,
        now: new Date().toISOString(),
        claimLeaseMs: 30_000,
      });
      claimLatencies.push(performance.now() - claimStartedAt);
      claimCalls += 1;
      if (events.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      assert(events.every((event) => event.aggregateType === aggregateType),
        `tier ${size} isolated claim scope`, {
          aggregateTypes: [...new Set(events.map((event) => event.aggregateType))],
        });
      for (const event of events) {
        if (seen.has(event.id)) duplicateClaims += 1;
        seen.add(event.id);
      }
      const acknowledged = await markPostgresOutboxEventsPublished({
        ids: events.map((event) => event.id),
        publishedAt: new Date().toISOString(),
        claimUntil: events[0]?.nextAttemptAt,
      });
      assert(acknowledged === events.length, `tier ${size} set-based acknowledgement`, {
        expected: events.length,
        acknowledged,
      });
    }
  }

  await Promise.all([claimant(), claimant()]);
  const published = Number((await pool.query(`
select count(*)::int published
from public.outbox_events
where correlation_id=$1 and status='PUBLISHED'
`, [correlationId])).rows[0].published);
  const totalMs = performance.now() - startedAt;
  const result = {
    size,
    claimed: seen.size,
    duplicateClaims,
    claimCalls,
    totalMs: Number(totalMs.toFixed(2)),
    claimP95Ms: Number(percentile(claimLatencies, 0.95).toFixed(2)),
    claimMaxMs: Number(Math.max(...claimLatencies).toFixed(2)),
    published,
  };
  assert(seen.size === size && published === size && duplicateClaims === 0,
    `tier ${size} two-claimer correctness`, result);
  return result;
}

async function verifyLeaseRecovery() {
  const correlationId = `${campaignId}:lease-recovery`;
  await insertTier(1, correlationId);
  const first = await listDispatchablePostgresOutboxEvents({
    limit: 1,
    now: new Date().toISOString(),
    claimLeaseMs: 1_000,
  });
  assert(first.length === 1, "lease recovery first claim", { claimed: first.length });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await listDispatchablePostgresOutboxEvents({
    limit: 1,
    now: new Date().toISOString(),
    claimLeaseMs: 30_000,
  });
  assert(second.length === 1 && second[0]?.id === first[0]?.id,
    "expired claim is recoverable at least once", {
      first: first[0]?.id,
      second: second[0]?.id,
    });
  const staleAcknowledgement = await markPostgresOutboxEventsPublished({
    ids: [first[0]!.id],
    claimUntil: first[0]?.nextAttemptAt,
  });
  assert(staleAcknowledgement === 0, "stale claim cannot acknowledge a newer lease", {
    staleAcknowledgement,
  });
  const currentAcknowledgement = await markPostgresOutboxEventsPublished({
    ids: [second[0]!.id],
    claimUntil: second[0]?.nextAttemptAt,
  });
  assert(currentAcknowledgement === 1, "current lease acknowledgement succeeds", {
    currentAcknowledgement,
  });
}

async function completionLookupTier(size: number) {
  const available = await pool.query<{ ticket_item_id: string }>(`
select distinct item.ticket_item_id::text
from game_engine.ticket_draw_settlement_aggregate_items item
order by 1
limit $1
`, [size]);
  if (available.rows.length === 0) {
    return { requested: size, sampled: 0, lookupMs: null, rows: 0, practical: false };
  }
  const ticketItemIds = available.rows.map((row) => row.ticket_item_id);
  const startedAt = performance.now();
  const result = await pool.query(`
select item.ticket_item_id, item.settlement_input_id
from game_engine.ticket_draw_settlement_aggregate_items item
where item.ticket_item_id = any($1::uuid[])
order by item.ticket_item_id, item.settlement_input_id
`, [ticketItemIds]);
  const lookupMs = performance.now() - startedAt;
  assert((result.rowCount ?? 0) >= ticketItemIds.length,
    `completion lineage lookup ${size} preserves exact items`, {
      requested: size,
      sampled: ticketItemIds.length,
      rows: result.rowCount,
    });
  return {
    requested: size,
    sampled: ticketItemIds.length,
    lookupMs: Number(lookupMs.toFixed(2)),
    rows: result.rowCount,
    practical: ticketItemIds.length === size,
  };
}

async function assertNoUnrelatedDueEvents() {
  const result = await pool.query(`
select count(*)::int due
from public.outbox_events
where status in ('PENDING','FAILED')
  and (next_attempt_at is null or next_attempt_at <= clock_timestamp())
`);
  assert(Number(result.rows[0].due) === 0,
    "focused outbox test starts without unrelated due work", result.rows[0]);
}

async function main() {
  await assertNoUnrelatedDueEvents();
  const outboxTiers: TierResult[] = [];
  for (const size of [100, 500, 1_000, 2_500]) {
    outboxTiers.push(await claimTier(size));
  }
  await verifyLeaseRecovery();
  const completionTiers = [];
  for (const size of [100, 500, 1_000]) {
    completionTiers.push(await completionLookupTier(size));
  }
  const indexes = await pool.query(`
select schemaname, indexname
from pg_indexes
where indexname in (
  'idx_outbox_events_dispatch_claim',
  'idx_ticket_draw_settlement_items_ticket',
  'idx_authoritative_settlement_completion_ticket'
)
order by indexname
`);
  assert(indexes.rowCount === 3, "PR-05M indexes installed", indexes.rows);
  console.log(JSON.stringify({
    status: "PASS",
    campaignId,
    outboxTiers,
    completionTiers,
    indexes: indexes.rows,
    checks,
  }, null, 2));
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}).finally(async () => {
  await pool.query("delete from public.outbox_events where aggregate_type=$1", [aggregateType])
    .catch(() => undefined);
  await closePostgresOutboxPool().catch(() => undefined);
  await pool.end().catch(() => undefined);
});
