import { Pool, type QueryResultRow } from "pg";
import type { SettlementLedgerEffect } from "./settlement-financial-effects.service";

export type SettlementLedgerEffectRepository = {
  readonly mode: "postgres" | "in-memory";
  appendEffects(effects: SettlementLedgerEffect[]): Promise<SettlementLedgerEffect[]>;
  listEffectsByRunId(settlementRunId: string): Promise<SettlementLedgerEffect[]>;
  findEffectByIdempotencyKey(idempotencyKey: string): Promise<SettlementLedgerEffect | null>;
  close(): Promise<void>;
};

type SettlementLedgerEffectRow = QueryResultRow & {
  id: string;
  settlement_run_id: string;
  settlement_record_id: string;
  ticket_id: string;
  ticket_line_id: string;
  drawing_id: string;
  account_id: string;
  effect_type: SettlementLedgerEffect["effectType"];
  transaction_type: SettlementLedgerEffect["transactionType"];
  direction: SettlementLedgerEffect["direction"];
  amount: string | number;
  idempotency_key: string;
  posting_status: SettlementLedgerEffect["postingStatus"];
  reference_type: string;
  reference_id: string;
  reversal_of_ledger_effect_id: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: Date | string;
};

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapEffect(row: SettlementLedgerEffectRow): SettlementLedgerEffect {
  return {
    id: row.id,
    settlementRunId: row.settlement_run_id,
    settlementRecordId: row.settlement_record_id,
    ticketId: row.ticket_id,
    ticketLineId: row.ticket_line_id,
    drawingId: row.drawing_id,
    accountId: row.account_id,
    effectType: row.effect_type,
    transactionType: row.transaction_type,
    direction: row.direction,
    amount: Number(row.amount),
    idempotencyKey: row.idempotency_key,
    postingStatus: row.posting_status,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    reversalOfLedgerEffectId: row.reversal_of_ledger_effect_id,
    metadata:
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata ?? {},
    createdAt: toIso(row.created_at),
  };
}

class InMemorySettlementLedgerEffectRepository implements SettlementLedgerEffectRepository {
  readonly mode = "in-memory" as const;
  private readonly effectsByIdempotencyKey = new Map<string, SettlementLedgerEffect>();

  async appendEffects(effects: SettlementLedgerEffect[]) {
    for (const effect of effects) {
      if (!this.effectsByIdempotencyKey.has(effect.idempotencyKey)) {
        this.effectsByIdempotencyKey.set(effect.idempotencyKey, effect);
      }
    }

    return effects.map(
      (effect) => this.effectsByIdempotencyKey.get(effect.idempotencyKey) ?? effect
    );
  }

  async listEffectsByRunId(settlementRunId: string) {
    return [...this.effectsByIdempotencyKey.values()]
      .filter((effect) => effect.settlementRunId === settlementRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async findEffectByIdempotencyKey(idempotencyKey: string) {
    return this.effectsByIdempotencyKey.get(idempotencyKey) ?? null;
  }

  async close() {
    return;
  }
}

class PostgresSettlementLedgerEffectRepository implements SettlementLedgerEffectRepository {
  readonly mode = "postgres" as const;

  constructor(private readonly pool: Pool) {}

  async appendEffects(effects: SettlementLedgerEffect[]) {
    const persisted: SettlementLedgerEffect[] = [];

    for (const effect of effects) {
      const result = await this.pool.query<SettlementLedgerEffectRow>(
        `
insert into settlement_service.settlement_ledger_effects (
  id,
  settlement_run_id,
  settlement_record_id,
  ticket_id,
  ticket_line_id,
  drawing_id,
  account_id,
  effect_type,
  transaction_type,
  direction,
  amount,
  idempotency_key,
  posting_status,
  reference_type,
  reference_id,
  reversal_of_ledger_effect_id,
  metadata,
  created_at
)
values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15, $16, $17::jsonb, $18
)
on conflict (idempotency_key) do nothing
returning *
`,
        [
          effect.id,
          effect.settlementRunId,
          effect.settlementRecordId,
          effect.ticketId,
          effect.ticketLineId,
          effect.drawingId,
          effect.accountId,
          effect.effectType,
          effect.transactionType,
          effect.direction,
          effect.amount,
          effect.idempotencyKey,
          effect.postingStatus,
          effect.referenceType,
          effect.referenceId,
          effect.reversalOfLedgerEffectId ?? null,
          JSON.stringify(effect.metadata),
          effect.createdAt,
        ]
      );

      if (result.rows[0]) {
        persisted.push(mapEffect(result.rows[0]));
        continue;
      }

      const existing = await this.findEffectByIdempotencyKey(effect.idempotencyKey);
      if (existing) {
        persisted.push(existing);
        continue;
      }

      throw new Error("Unable to persist settlement ledger effect.");
    }

    return persisted;
  }

  async listEffectsByRunId(settlementRunId: string) {
    const result = await this.pool.query<SettlementLedgerEffectRow>(
      `
select *
from settlement_service.settlement_ledger_effects
where settlement_run_id = $1
order by created_at asc, id asc
`,
      [settlementRunId]
    );

    return result.rows.map(mapEffect);
  }

  async findEffectByIdempotencyKey(idempotencyKey: string) {
    const result = await this.pool.query<SettlementLedgerEffectRow>(
      `
select *
from settlement_service.settlement_ledger_effects
where idempotency_key = $1
`,
      [idempotencyKey]
    );

    return result.rows[0] ? mapEffect(result.rows[0]) : null;
  }

  async close() {
    await this.pool.end();
  }
}

export function createInMemorySettlementLedgerEffectRepository(): SettlementLedgerEffectRepository {
  return new InMemorySettlementLedgerEffectRepository();
}

export async function createSettlementLedgerEffectRepository({
  databaseUrl = process.env.DATABASE_URL,
}: {
  databaseUrl?: string | null;
} = {}): Promise<SettlementLedgerEffectRepository> {
  if (!databaseUrl) {
    return createInMemorySettlementLedgerEffectRepository();
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await pool.query("select 1");
    return new PostgresSettlementLedgerEffectRepository(pool);
  } catch {
    await pool.end();
    return createInMemorySettlementLedgerEffectRepository();
  }
}
