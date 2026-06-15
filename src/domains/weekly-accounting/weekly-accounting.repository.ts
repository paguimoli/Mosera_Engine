import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  PersistedAccountType,
} from "../accounts/account.types";
import type {
  CreateWeeklyAccountingPeriodInput,
  CreateWeeklyAccountSummaryInput,
  WeeklyAccountingPeriod,
  WeeklyAccountingPeriodStatus,
  WeeklyAccountSummary,
  WeeklyAccountSummaryStatus,
} from "./weekly-accounting.types";

type WeeklyAccountingPeriodRow = {
  id: string;
  market_id: string;
  brand_id: string;
  period_start_at: string;
  period_end_at: string;
  status: WeeklyAccountingPeriodStatus;
  created_at: string;
  closed_at?: string | null;
};

type WeeklyAccountSummaryRow = {
  id: string;
  period_id: string;
  account_id: string;
  account_type: PersistedAccountType;
  parent_account_id?: string | null;
  funding_model?: AccountFundingModel | null;
  operating_mode?: AccountOperatingMode | null;
  weekly_accounting_mode?: AccountWeeklyAccountingMode | null;
  settlement_mode?: AccountSettlementMode | null;
  opening_balance: string | number;
  closing_balance: string | number;
  settled_result_amount: string | number;
  pending_exposure_amount: string | number;
  ticket_count: number;
  settled_ticket_count: number;
  pending_ticket_count: number;
  active_this_week: boolean;
  has_carry_balance: boolean;
  has_pending_exposure: boolean;
  zero_balance_entry_id?: string | null;
  status: WeeklyAccountSummaryStatus;
  created_at: string;
  closed_at?: string | null;
};

const PERIOD_SELECT =
  "id, market_id, brand_id, period_start_at, period_end_at, status, created_at, closed_at";
const SUMMARY_SELECT =
  "id, period_id, account_id, account_type, parent_account_id, funding_model, operating_mode, weekly_accounting_mode, settlement_mode, opening_balance, closing_balance, settled_result_amount, pending_exposure_amount, ticket_count, settled_ticket_count, pending_ticket_count, active_this_week, has_carry_balance, has_pending_exposure, zero_balance_entry_id, status, created_at, closed_at";

export class WeeklyAccountingRepositoryError extends Error {
  constructor(message = "Weekly accounting persistence operation failed.") {
    super(message);
    this.name = "WeeklyAccountingRepositoryError";
  }
}

function mapPeriodRow(
  row: WeeklyAccountingPeriodRow | null
): WeeklyAccountingPeriod | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    marketId: row.market_id,
    brandId: row.brand_id,
    periodStartAt: row.period_start_at,
    periodEndAt: row.period_end_at,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null,
  };
}

function mapSummaryRow(
  row: WeeklyAccountSummaryRow | null
): WeeklyAccountSummary | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    periodId: row.period_id,
    accountId: row.account_id,
    accountType: row.account_type,
    parentAccountId: row.parent_account_id ?? null,
    fundingModel: row.funding_model ?? null,
    operatingMode: row.operating_mode ?? null,
    weeklyAccountingMode: row.weekly_accounting_mode ?? null,
    settlementMode: row.settlement_mode ?? null,
    openingBalance: Number(row.opening_balance),
    closingBalance: Number(row.closing_balance),
    settledResultAmount: Number(row.settled_result_amount),
    pendingExposureAmount: Number(row.pending_exposure_amount),
    ticketCount: row.ticket_count,
    settledTicketCount: row.settled_ticket_count,
    pendingTicketCount: row.pending_ticket_count,
    activeThisWeek: row.active_this_week,
    hasCarryBalance: row.has_carry_balance,
    hasPendingExposure: row.has_pending_exposure,
    zeroBalanceEntryId: row.zero_balance_entry_id ?? null,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null,
  };
}

export async function createWeeklyAccountingPeriod(
  input: CreateWeeklyAccountingPeriodInput
): Promise<WeeklyAccountingPeriod> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_periods")
    .insert({
      market_id: input.marketId,
      brand_id: input.brandId,
      period_start_at: input.periodStartAt,
      period_end_at: input.periodEndAt,
      status: input.status ?? "OPEN",
    })
    .select(PERIOD_SELECT)
    .single();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  const period = mapPeriodRow(data as WeeklyAccountingPeriodRow | null);

  if (!period) {
    throw new WeeklyAccountingRepositoryError();
  }

  return period;
}

export async function findWeeklyAccountingPeriodById(
  id: string
): Promise<WeeklyAccountingPeriod | null> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_periods")
    .select(PERIOD_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  return mapPeriodRow(data as WeeklyAccountingPeriodRow | null);
}

export async function findOpenPeriodByMarketAndBrand(
  marketId: string,
  brandId: string
): Promise<WeeklyAccountingPeriod | null> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_periods")
    .select(PERIOD_SELECT)
    .eq("market_id", marketId)
    .eq("brand_id", brandId)
    .eq("status", "OPEN")
    .maybeSingle();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  return mapPeriodRow(data as WeeklyAccountingPeriodRow | null);
}

export async function findPeriodByMarketBrandWindow({
  marketId,
  brandId,
  periodStartAt,
  periodEndAt,
}: CreateWeeklyAccountingPeriodInput): Promise<WeeklyAccountingPeriod | null> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_periods")
    .select(PERIOD_SELECT)
    .eq("market_id", marketId)
    .eq("brand_id", brandId)
    .eq("period_start_at", periodStartAt)
    .eq("period_end_at", periodEndAt)
    .maybeSingle();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  return mapPeriodRow(data as WeeklyAccountingPeriodRow | null);
}

export async function listWeeklyAccountingPeriods(): Promise<
  WeeklyAccountingPeriod[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_periods")
    .select(PERIOD_SELECT)
    .order("period_start_at", { ascending: false });

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  return ((data ?? []) as WeeklyAccountingPeriodRow[])
    .map(mapPeriodRow)
    .filter((period): period is WeeklyAccountingPeriod => Boolean(period));
}

export async function closeWeeklyAccountingPeriod(
  periodId: string,
  closedAt: string
): Promise<WeeklyAccountingPeriod> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_periods")
    .update({ status: "CLOSED", closed_at: closedAt })
    .eq("id", periodId)
    .eq("status", "OPEN")
    .select(PERIOD_SELECT)
    .single();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  const period = mapPeriodRow(data as WeeklyAccountingPeriodRow | null);

  if (!period) {
    throw new WeeklyAccountingRepositoryError();
  }

  return period;
}

export async function createWeeklyAccountSummary(
  input: CreateWeeklyAccountSummaryInput
): Promise<WeeklyAccountSummary> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_account_summaries")
    .insert({
      period_id: input.periodId,
      account_id: input.accountId,
      account_type: input.accountType,
      parent_account_id: input.parentAccountId ?? null,
      funding_model: input.fundingModel ?? null,
      operating_mode: input.operatingMode ?? null,
      weekly_accounting_mode: input.weeklyAccountingMode ?? null,
      settlement_mode: input.settlementMode ?? null,
      opening_balance: input.openingBalance ?? 0,
      closing_balance: input.closingBalance ?? 0,
      settled_result_amount: input.settledResultAmount ?? 0,
      pending_exposure_amount: input.pendingExposureAmount ?? 0,
      ticket_count: input.ticketCount ?? 0,
      settled_ticket_count: input.settledTicketCount ?? 0,
      pending_ticket_count: input.pendingTicketCount ?? 0,
      active_this_week: input.activeThisWeek ?? false,
      has_carry_balance: input.hasCarryBalance ?? false,
      has_pending_exposure: input.hasPendingExposure ?? false,
      zero_balance_entry_id: input.zeroBalanceEntryId ?? null,
      status: input.status ?? "OPEN",
    })
    .select(SUMMARY_SELECT)
    .single();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  const summary = mapSummaryRow(data as WeeklyAccountSummaryRow | null);

  if (!summary) {
    throw new WeeklyAccountingRepositoryError();
  }

  return summary;
}

export async function findWeeklyAccountSummary(
  periodId: string,
  accountId: string
): Promise<WeeklyAccountSummary | null> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_account_summaries")
    .select(SUMMARY_SELECT)
    .eq("period_id", periodId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  return mapSummaryRow(data as WeeklyAccountSummaryRow | null);
}

export async function listWeeklyAccountSummaries(
  periodId: string
): Promise<WeeklyAccountSummary[]> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_account_summaries")
    .select(SUMMARY_SELECT)
    .eq("period_id", periodId)
    .order("account_type", { ascending: true });

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  return ((data ?? []) as WeeklyAccountSummaryRow[])
    .map(mapSummaryRow)
    .filter((summary): summary is WeeklyAccountSummary => Boolean(summary));
}

export async function closeWeeklyAccountSummary(
  summaryId: string,
  closedAt: string
): Promise<WeeklyAccountSummary> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_account_summaries")
    .update({ status: "CLOSED", closed_at: closedAt })
    .eq("id", summaryId)
    .eq("status", "OPEN")
    .select(SUMMARY_SELECT)
    .single();

  if (error) {
    throw new WeeklyAccountingRepositoryError();
  }

  const summary = mapSummaryRow(data as WeeklyAccountSummaryRow | null);

  if (!summary) {
    throw new WeeklyAccountingRepositoryError();
  }

  return summary;
}
