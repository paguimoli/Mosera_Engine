import type {
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  PersistedAccountType,
} from "../accounts/account.types";

export type WeeklyAccountingPeriodStatus = "OPEN" | "CLOSED";

export type WeeklyAccountSummaryStatus = "OPEN" | "CLOSED";

export type WeeklyAccountingPeriod = {
  id: string;
  marketId: string;
  brandId: string;
  periodStartAt: string;
  periodEndAt: string;
  status: WeeklyAccountingPeriodStatus;
  createdAt: string;
  closedAt?: string | null;
};

export type WeeklyAccountSummary = {
  id: string;
  periodId: string;
  accountId: string;
  accountType: PersistedAccountType;
  parentAccountId?: string | null;
  fundingModel?: AccountFundingModel | null;
  operatingMode?: AccountOperatingMode | null;
  weeklyAccountingMode?: AccountWeeklyAccountingMode | null;
  settlementMode?: AccountSettlementMode | null;
  openingBalance: number;
  closingBalance: number;
  settledResultAmount: number;
  pendingExposureAmount: number;
  ticketCount: number;
  settledTicketCount: number;
  pendingTicketCount: number;
  activeThisWeek: boolean;
  hasCarryBalance: boolean;
  hasPendingExposure: boolean;
  zeroBalanceEntryId?: string | null;
  status: WeeklyAccountSummaryStatus;
  createdAt: string;
  closedAt?: string | null;
};

export type CreateWeeklyAccountingPeriodInput = {
  marketId: string;
  brandId: string;
  periodStartAt: string;
  periodEndAt: string;
  status?: WeeklyAccountingPeriodStatus;
};

export type CreateWeeklyAccountSummaryInput = {
  periodId: string;
  accountId: string;
  accountType: PersistedAccountType;
  parentAccountId?: string | null;
  fundingModel?: AccountFundingModel | null;
  operatingMode?: AccountOperatingMode | null;
  weeklyAccountingMode?: AccountWeeklyAccountingMode | null;
  settlementMode?: AccountSettlementMode | null;
  openingBalance?: number;
  closingBalance?: number;
  settledResultAmount?: number;
  pendingExposureAmount?: number;
  ticketCount?: number;
  settledTicketCount?: number;
  pendingTicketCount?: number;
  activeThisWeek?: boolean;
  hasCarryBalance?: boolean;
  hasPendingExposure?: boolean;
  zeroBalanceEntryId?: string | null;
  status?: WeeklyAccountSummaryStatus;
};
