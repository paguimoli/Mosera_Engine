import type {
  AccountWeeklyAccountingMode,
  PersistedAccountType,
} from "../accounts/account.types";

export type WeeklyAccountingSnapshot = {
  id: string;
  accountId: string;
  accountType: PersistedAccountType;
  weekStart: string;
  weekEnd: string;
  currency: string;
  openingBalance: number;
  closingBalance: number;
  settledWins: number;
  settledLosses: number;
  netResult: number;
  ticketCount: number;
  pendingExposure: number;
  generatedAt: string;
  createdAt: string;
};

export type CloseWeeklyAccountingInput = {
  weekStart: string;
  weekEnd: string;
  accountScope?: string | null;
  currency: string;
  closeMode?: AccountWeeklyAccountingMode | string | null;
  correlationId?: string | null;
};

export type ListWeeklyAccountingSnapshotsInput = {
  weekStart?: string | null;
  weekEnd?: string | null;
  accountId?: string | null;
  currency?: string | null;
};
