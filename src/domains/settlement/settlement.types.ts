export type SettlementRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "reversed";

export type SettlementRecordStatus =
  | "pending"
  | "settled"
  | "reversed"
  | "failed"
  | "void";

export type SettlementOutcome = "win" | "loss" | "push" | "void" | "failed";

export type SettlementRun = {
  id: string;
  drawingId: string;
  gameId: string;
  status: SettlementRunStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  processedTicketCount: number;
  processedLineCount: number;
  totalStake: number;
  totalPayout: number;
  totalNet: number;
  notes?: string;
  createdAt: string;
};

export type SettlementRecord = {
  id: string;
  settlementRunId: string;
  ticketId: string;
  ticketLineId: string;
  accountId: string;
  gameId: string;
  drawingId: string;
  wagerTypeId: string;
  wagerOptionId?: string | null;
  stake: number;
  payout: number;
  netAmount: number;
  outcome: SettlementOutcome;
  status: SettlementRecordStatus;
  version: number;
  previousSettlementRecordId?: string | null;
  reversalOfSettlementRecordId?: string | null;
  ledgerTransactionIds: string[];
  createdAt: string;
};
