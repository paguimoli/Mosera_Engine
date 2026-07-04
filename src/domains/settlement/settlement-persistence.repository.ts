import { Pool, type QueryResultRow } from "pg";
import type { SettlementRecord, SettlementRun } from "./settlement.types";

export type SettlementPersistenceMode = "postgres" | "in-memory";

export type SettlementPersistenceRepository = {
  readonly mode: SettlementPersistenceMode;
  saveRun(run: SettlementRun): Promise<SettlementRun>;
  updateRun(run: SettlementRun): Promise<SettlementRun>;
  findRunById(settlementRunId: string): Promise<SettlementRun | null>;
  listRunsByDrawingId(drawingId: string): Promise<SettlementRun[]>;
  listIncompleteRuns(): Promise<SettlementRun[]>;
  appendRecords(records: SettlementRecord[]): Promise<SettlementRecord[]>;
  listRecordsByRunId(settlementRunId: string): Promise<SettlementRecord[]>;
  listRecordsByTicketAndDraw(ticketId: string, drawingId: string): Promise<SettlementRecord[]>;
  close(): Promise<void>;
};

export class DuplicateCompletedSettlementError extends Error {
  constructor(message = "A completed settlement already exists for this draw/ticket scope.") {
    super(message);
    this.name = "DuplicateCompletedSettlementError";
  }
}

type SettlementRunRow = QueryResultRow & {
  id: string;
  drawing_id: string;
  game_id: string;
  status: SettlementRun["status"];
  expected_ticket_count: number;
  expected_line_count: number;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  execution_id: string | null;
  processed_ticket_count: number;
  processed_line_count: number;
  win_count: number;
  loss_count: number;
  push_count: number;
  failed_count: number;
  total_stake: string | number;
  total_payout: string | number;
  total_net: string | number;
  duration_ms: number;
  tickets_per_second: string | number;
  lines_per_second: string | number;
  draw_to_settlement_ms: number | null;
  peak_concurrent_settlements: number;
  notes: string | null;
  record_hash: string | null;
  previous_hash: string | null;
  hash_version: string | null;
  created_at: Date | string;
};

type SettlementRecordRow = QueryResultRow & {
  id: string;
  settlement_run_id: string;
  ticket_id: string;
  ticket_line_id: string;
  account_id: string;
  game_id: string;
  drawing_id: string;
  wager_type_id: string;
  wager_option_id: string | null;
  stake: string | number;
  payout: string | number;
  net_amount: string | number;
  outcome: SettlementRecord["outcome"];
  status: SettlementRecord["status"];
  version: number;
  previous_settlement_record_id: string | null;
  reversal_of_settlement_record_id: string | null;
  ledger_transaction_ids: string[] | string | null;
  record_hash: string | null;
  previous_hash: string | null;
  hash_version: string | null;
  created_at: Date | string;
};

const INCOMPLETE_STATUSES: SettlementRun["status"][] = [
  "running",
  "partially_completed",
  "recovering",
];

function toIso(value: Date | string | null | undefined) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function mapRun(row: SettlementRunRow): SettlementRun {
  return {
    id: row.id,
    drawingId: row.drawing_id,
    gameId: row.game_id,
    status: row.status,
    expectedTicketCount: Number(row.expected_ticket_count),
    expectedLineCount: Number(row.expected_line_count),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    executionId: row.execution_id,
    processedTicketCount: Number(row.processed_ticket_count),
    processedLineCount: Number(row.processed_line_count),
    winCount: Number(row.win_count),
    lossCount: Number(row.loss_count),
    pushCount: Number(row.push_count),
    failedCount: Number(row.failed_count),
    totalStake: toNumber(row.total_stake),
    totalPayout: toNumber(row.total_payout),
    totalNet: toNumber(row.total_net),
    durationMs: Number(row.duration_ms),
    ticketsPerSecond: toNumber(row.tickets_per_second),
    linesPerSecond: toNumber(row.lines_per_second),
    drawToSettlementMs: row.draw_to_settlement_ms,
    peakConcurrentSettlements: Number(row.peak_concurrent_settlements),
    notes: row.notes ?? undefined,
    recordHash: row.record_hash,
    previousHash: row.previous_hash,
    hashVersion: row.hash_version,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function mapRecord(row: SettlementRecordRow): SettlementRecord {
  const ledgerTransactionIds = Array.isArray(row.ledger_transaction_ids)
    ? row.ledger_transaction_ids
    : typeof row.ledger_transaction_ids === "string"
      ? JSON.parse(row.ledger_transaction_ids)
      : [];

  return {
    id: row.id,
    settlementRunId: row.settlement_run_id,
    ticketId: row.ticket_id,
    ticketLineId: row.ticket_line_id,
    accountId: row.account_id,
    gameId: row.game_id,
    drawingId: row.drawing_id,
    wagerTypeId: row.wager_type_id,
    wagerOptionId: row.wager_option_id,
    stake: toNumber(row.stake),
    payout: toNumber(row.payout),
    netAmount: toNumber(row.net_amount),
    outcome: row.outcome,
    status: row.status,
    version: Number(row.version),
    previousSettlementRecordId: row.previous_settlement_record_id,
    reversalOfSettlementRecordId: row.reversal_of_settlement_record_id,
    ledgerTransactionIds,
    recordHash: row.record_hash,
    previousHash: row.previous_hash,
    hashVersion: row.hash_version,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

class InMemorySettlementPersistenceRepository implements SettlementPersistenceRepository {
  readonly mode = "in-memory" as const;
  private runs = new Map<string, SettlementRun>();
  private records = new Map<string, SettlementRecord>();

  async saveRun(run: SettlementRun) {
    this.assertCompletedRunAllowed(run);
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(run: SettlementRun) {
    this.assertCompletedRunAllowed(run);
    this.runs.set(run.id, run);
    return run;
  }

  async findRunById(settlementRunId: string) {
    return this.runs.get(settlementRunId) ?? null;
  }

  async listRunsByDrawingId(drawingId: string) {
    return [...this.runs.values()]
      .filter((run) => run.drawingId === drawingId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listIncompleteRuns() {
    return [...this.runs.values()]
      .filter((run) => INCOMPLETE_STATUSES.includes(run.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async appendRecords(records: SettlementRecord[]) {
    for (const record of records) {
      this.assertRecordAllowed(record);
      if (!this.records.has(record.id)) {
        this.records.set(record.id, record);
      }
    }

    return records;
  }

  async listRecordsByRunId(settlementRunId: string) {
    return [...this.records.values()]
      .filter((record) => record.settlementRunId === settlementRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listRecordsByTicketAndDraw(ticketId: string, drawingId: string) {
    return [...this.records.values()]
      .filter((record) => record.ticketId === ticketId && record.drawingId === drawingId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async close() {
    return;
  }

  private assertCompletedRunAllowed(nextRun: SettlementRun) {
    if (nextRun.status !== "completed") return;

    const duplicate = [...this.runs.values()].find(
      (run) => run.id !== nextRun.id && run.drawingId === nextRun.drawingId && run.status === "completed"
    );

    if (duplicate) {
      throw new DuplicateCompletedSettlementError(
        `Completed settlement run already exists for drawing ${nextRun.drawingId}.`
      );
    }
  }

  private assertRecordAllowed(nextRecord: SettlementRecord) {
    if (nextRecord.status !== "settled" || nextRecord.reversalOfSettlementRecordId) return;

    const duplicate = [...this.records.values()].find(
      (record) =>
        record.id !== nextRecord.id &&
        record.status === "settled" &&
        !record.reversalOfSettlementRecordId &&
        record.drawingId === nextRecord.drawingId &&
        record.ticketId === nextRecord.ticketId &&
        record.ticketLineId === nextRecord.ticketLineId
    );

    if (duplicate) {
      throw new DuplicateCompletedSettlementError(
        `Completed settlement record already exists for ticket ${nextRecord.ticketId}, line ${nextRecord.ticketLineId}, drawing ${nextRecord.drawingId}.`
      );
    }
  }
}

class PostgresSettlementPersistenceRepository implements SettlementPersistenceRepository {
  readonly mode = "postgres" as const;

  constructor(private readonly pool: Pool) {}

  async saveRun(run: SettlementRun) {
    return this.upsertRun(run);
  }

  async updateRun(run: SettlementRun) {
    return this.upsertRun(run);
  }

  async findRunById(settlementRunId: string) {
    const result = await this.pool.query<SettlementRunRow>(
      "select * from settlement_service.settlement_runs where id = $1",
      [settlementRunId]
    );

    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listRunsByDrawingId(drawingId: string) {
    const result = await this.pool.query<SettlementRunRow>(
      `
select *
from settlement_service.settlement_runs
where drawing_id = $1
order by created_at asc, id asc
`,
      [drawingId]
    );

    return result.rows.map(mapRun);
  }

  async listIncompleteRuns() {
    const result = await this.pool.query<SettlementRunRow>(
      `
select *
from settlement_service.settlement_runs
where status = any($1::text[])
order by created_at asc, id asc
`,
      [INCOMPLETE_STATUSES]
    );

    return result.rows.map(mapRun);
  }

  async appendRecords(records: SettlementRecord[]) {
    for (const record of records) {
      try {
        await this.pool.query(
          `
insert into settlement_service.settlement_records (
  id,
  settlement_run_id,
  ticket_id,
  ticket_line_id,
  account_id,
  game_id,
  drawing_id,
  wager_type_id,
  wager_option_id,
  stake,
  payout,
  net_amount,
  outcome,
  status,
  version,
  previous_settlement_record_id,
  reversal_of_settlement_record_id,
  ledger_transaction_ids,
  record_hash,
  previous_hash,
  hash_version,
  created_at
)
values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22
)
on conflict (id) do nothing
`,
          [
            record.id,
            record.settlementRunId,
            record.ticketId,
            record.ticketLineId,
            record.accountId,
            record.gameId,
            record.drawingId,
            record.wagerTypeId,
            record.wagerOptionId ?? null,
            record.stake,
            record.payout,
            record.netAmount,
            record.outcome,
            record.status,
            record.version,
            record.previousSettlementRecordId ?? null,
            record.reversalOfSettlementRecordId ?? null,
            JSON.stringify(record.ledgerTransactionIds),
            record.recordHash ?? null,
            record.previousHash ?? null,
            record.hashVersion ?? null,
            record.createdAt,
          ]
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateCompletedSettlementError(
            `Completed settlement record already exists for ticket ${record.ticketId}, line ${record.ticketLineId}, drawing ${record.drawingId}.`
          );
        }

        throw error;
      }
    }

    return records;
  }

  async listRecordsByRunId(settlementRunId: string) {
    const result = await this.pool.query<SettlementRecordRow>(
      `
select *
from settlement_service.settlement_records
where settlement_run_id = $1
order by created_at asc, id asc
`,
      [settlementRunId]
    );

    return result.rows.map(mapRecord);
  }

  async listRecordsByTicketAndDraw(ticketId: string, drawingId: string) {
    const result = await this.pool.query<SettlementRecordRow>(
      `
select *
from settlement_service.settlement_records
where ticket_id = $1 and drawing_id = $2
order by created_at asc, id asc
`,
      [ticketId, drawingId]
    );

    return result.rows.map(mapRecord);
  }

  async close() {
    await this.pool.end();
  }

  private async upsertRun(run: SettlementRun) {
    try {
      const result = await this.pool.query<SettlementRunRow>(
        `
insert into settlement_service.settlement_runs (
  id,
  drawing_id,
  game_id,
  status,
  expected_ticket_count,
  expected_line_count,
  started_at,
  completed_at,
  execution_id,
  processed_ticket_count,
  processed_line_count,
  win_count,
  loss_count,
  push_count,
  failed_count,
  total_stake,
  total_payout,
  total_net,
  duration_ms,
  tickets_per_second,
  lines_per_second,
  draw_to_settlement_ms,
  peak_concurrent_settlements,
  notes,
  record_hash,
  previous_hash,
  hash_version,
  created_at
)
values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
  $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
  $27, $28
)
on conflict (id) do update
set status = excluded.status,
    expected_ticket_count = excluded.expected_ticket_count,
    expected_line_count = excluded.expected_line_count,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    execution_id = excluded.execution_id,
    processed_ticket_count = excluded.processed_ticket_count,
    processed_line_count = excluded.processed_line_count,
    win_count = excluded.win_count,
    loss_count = excluded.loss_count,
    push_count = excluded.push_count,
    failed_count = excluded.failed_count,
    total_stake = excluded.total_stake,
    total_payout = excluded.total_payout,
    total_net = excluded.total_net,
    duration_ms = excluded.duration_ms,
    tickets_per_second = excluded.tickets_per_second,
    lines_per_second = excluded.lines_per_second,
    draw_to_settlement_ms = excluded.draw_to_settlement_ms,
    peak_concurrent_settlements = excluded.peak_concurrent_settlements,
    notes = excluded.notes,
    record_hash = excluded.record_hash,
    previous_hash = excluded.previous_hash,
    hash_version = excluded.hash_version,
    updated_at = now()
returning *
`,
        [
          run.id,
          run.drawingId,
          run.gameId,
          run.status,
          run.expectedTicketCount,
          run.expectedLineCount,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.executionId ?? null,
          run.processedTicketCount,
          run.processedLineCount,
          run.winCount,
          run.lossCount,
          run.pushCount,
          run.failedCount,
          run.totalStake,
          run.totalPayout,
          run.totalNet,
          run.durationMs,
          run.ticketsPerSecond,
          run.linesPerSecond,
          run.drawToSettlementMs ?? null,
          run.peakConcurrentSettlements,
          run.notes ?? null,
          run.recordHash ?? null,
          run.previousHash ?? null,
          run.hashVersion ?? null,
          run.createdAt,
        ]
      );

      return mapRun(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateCompletedSettlementError(
          `Completed settlement run already exists for drawing ${run.drawingId}.`
        );
      }

      throw error;
    }
  }
}

export function createInMemorySettlementPersistenceRepository(): SettlementPersistenceRepository {
  return new InMemorySettlementPersistenceRepository();
}

export async function createSettlementPersistenceRepository({
  databaseUrl = process.env.DATABASE_URL,
}: {
  databaseUrl?: string | null;
} = {}): Promise<SettlementPersistenceRepository> {
  if (!databaseUrl) {
    return createInMemorySettlementPersistenceRepository();
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await pool.query("select 1");
    return new PostgresSettlementPersistenceRepository(pool);
  } catch {
    await pool.end();
    return createInMemorySettlementPersistenceRepository();
  }
}
