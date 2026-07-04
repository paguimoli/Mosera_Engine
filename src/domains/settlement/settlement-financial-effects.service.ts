import type {
  CreateLedgerEntryInput,
  LedgerDirection,
  LedgerEntry,
  LedgerTransactionType,
} from "../ledger/ledger.types";
import type { SettlementRecord } from "./settlement.types";

export type SettlementLedgerEffectCommand = CreateLedgerEntryInput;

export type SettlementLedgerEffectType =
  | "WIN_PAYOUT"
  | "LOSS_RECOGNITION_NOOP"
  | "PUSH_REFUND"
  | "VOID_REFUND"
  | "SETTLEMENT_REVERSAL"
  | "SETTLEMENT_CORRECTION";

export type SettlementLedgerEffectPostingStatus =
  | "READY"
  | "NO_OP"
  | "POSTED"
  | "SKIPPED";

export type SettlementLedgerEffect = {
  id: string;
  settlementRunId: string;
  settlementRecordId: string;
  ticketId: string;
  ticketLineId: string;
  drawingId: string;
  accountId: string;
  effectType: SettlementLedgerEffectType;
  transactionType: LedgerTransactionType;
  direction: LedgerDirection | "NOOP";
  amount: number;
  idempotencyKey: string;
  postingStatus: SettlementLedgerEffectPostingStatus;
  referenceType: string;
  referenceId: string;
  reversalOfLedgerEffectId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SettlementLedgerEffectResult = {
  settlementRecords: SettlementRecord[];
  ledgerEntries: LedgerEntry[];
  ledgerEffects: SettlementLedgerEffect[];
  legacyLedgerTransactions: never[];
};

function effectId(record: SettlementRecord, effectType: SettlementLedgerEffectType) {
  return `SETTLEMENT-LEDGER-${record.settlementRunId}-${record.id}-${effectType}`;
}

function idempotencyKey(record: SettlementRecord, effectType: SettlementLedgerEffectType) {
  return [
    "settlement-ledger",
    record.settlementRunId,
    record.drawingId,
    record.ticketId,
    record.ticketLineId,
    record.id,
    effectType,
    record.version,
  ].join(":");
}

function baseEffect(
  record: SettlementRecord,
  effectType: SettlementLedgerEffectType,
  transactionType: LedgerTransactionType,
  direction: LedgerDirection | "NOOP",
  amount: number,
  postingStatus: SettlementLedgerEffectPostingStatus,
  metadata: Record<string, unknown> = {}
): SettlementLedgerEffect {
  return {
    id: effectId(record, effectType),
    settlementRunId: record.settlementRunId,
    settlementRecordId: record.id,
    ticketId: record.ticketId,
    ticketLineId: record.ticketLineId,
    drawingId: record.drawingId,
    accountId: record.accountId,
    effectType,
    transactionType,
    direction,
    amount,
    idempotencyKey: idempotencyKey(record, effectType),
    postingStatus,
    referenceType: "settlement_record",
    referenceId: record.id,
    reversalOfLedgerEffectId: record.reversalOfSettlementRecordId
      ? effectId(
          {
            ...record,
            id: record.reversalOfSettlementRecordId,
            version: Math.max(1, record.version - 1),
          },
          record.outcome === "void" ? "VOID_REFUND" : "WIN_PAYOUT"
        )
      : null,
    metadata: {
      settlementRunId: record.settlementRunId,
      drawingId: record.drawingId,
      ticketId: record.ticketId,
      ticketLineId: record.ticketLineId,
      outcome: record.outcome,
      settlementRecordStatus: record.status,
      settlementRecordVersion: record.version,
      ...metadata,
    },
    createdAt: new Date().toISOString(),
  };
}

export function generateSettlementLedgerEffects(
  settlementRecords: SettlementRecord[]
): SettlementLedgerEffect[] {
  const effects: SettlementLedgerEffect[] = [];

  for (const record of settlementRecords) {
    if (record.status === "reversed" || record.reversalOfSettlementRecordId) {
      const amount = Math.abs(Number(record.payout || record.netAmount || 0));

      if (amount > 0) {
        effects.push(
          baseEffect(
            record,
            "SETTLEMENT_REVERSAL",
            "REVERSAL",
            record.netAmount <= 0 ? "DEBIT" : "CREDIT",
            amount,
            "READY"
          )
        );
      }

      continue;
    }

    if (record.outcome === "win" && record.payout > 0) {
      effects.push(
        baseEffect(record, "WIN_PAYOUT", "SETTLEMENT_CREDIT", "CREDIT", record.payout, "READY")
      );
      continue;
    }

    if (record.outcome === "push") {
      effects.push(
        baseEffect(record, "PUSH_REFUND", "TICKET_REFUND", "CREDIT", record.stake, "READY")
      );
      continue;
    }

    if (record.outcome === "void" || record.status === "void") {
      effects.push(
        baseEffect(record, "VOID_REFUND", "TICKET_VOID", "CREDIT", record.stake, "READY")
      );
      continue;
    }

    if (record.outcome === "loss") {
      effects.push(
        baseEffect(
          record,
          "LOSS_RECOGNITION_NOOP",
          "SETTLEMENT_DEBIT",
          "NOOP",
          0,
          "NO_OP",
          {
            reason: "Stake/loss recognition is assumed to have occurred at ticket acceptance.",
          }
        )
      );
    }
  }

  return effects;
}

function toLedgerEntry(effect: SettlementLedgerEffect): LedgerEntry {
  return {
    id: effect.id,
    walletId: `settlement:${effect.accountId}`,
    accountId: effect.accountId,
    transactionType: effect.transactionType,
    direction: effect.direction === "NOOP" ? "DEBIT" : effect.direction,
    amount: effect.amount,
    balanceAfter: 0,
    currencyCode: "LOCAL",
    referenceType: effect.referenceType,
    referenceId: effect.referenceId,
    idempotencyKey: effect.idempotencyKey,
    reversalOfLedgerEntryId: effect.reversalOfLedgerEffectId ?? null,
    metadata: effect.metadata,
    createdAt: effect.createdAt,
  };
}

function attachLedgerEffectIds({
  settlementRecords,
  ledgerEffects,
}: {
  settlementRecords: SettlementRecord[];
  ledgerEffects: SettlementLedgerEffect[];
}) {
  const effectIdsByRecord = new Map<string, string[]>();

  for (const effect of ledgerEffects) {
    if (effect.postingStatus === "NO_OP") continue;

    const ids = effectIdsByRecord.get(effect.settlementRecordId) ?? [];
    ids.push(effect.id);
    effectIdsByRecord.set(effect.settlementRecordId, ids);
  }

  return settlementRecords.map((record) => ({
    ...record,
    ledgerTransactionIds: [
      ...record.ledgerTransactionIds,
      ...(effectIdsByRecord.get(record.id) ?? []),
    ].filter((id, index, ids) => ids.indexOf(id) === index),
  }));
}

export async function applySettlementLedgerEffects({
  settlementRecords,
  ledgerEntryCommands = [],
}: {
  settlementRecords: SettlementRecord[];
  ledgerEntryCommands?: SettlementLedgerEffectCommand[];
}): Promise<SettlementLedgerEffectResult> {
  const ledgerEntries: LedgerEntry[] = [];
  const ledgerEffects = generateSettlementLedgerEffects(settlementRecords);

  if (ledgerEntryCommands.length > 0) {
    const { postLedgerEntry } = await import("../ledger/ledger.entrypoints");

    for (const command of ledgerEntryCommands) {
      ledgerEntries.push(await postLedgerEntry(command));
    }
  }

  ledgerEntries.push(
    ...ledgerEffects
      .filter((effect) => effect.postingStatus !== "NO_OP")
      .map(toLedgerEntry)
  );

  return {
    settlementRecords: attachLedgerEffectIds({ settlementRecords, ledgerEffects }),
    ledgerEntries,
    ledgerEffects,
    legacyLedgerTransactions: [],
  };
}
