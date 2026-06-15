import { findBrandById } from "../brands/brand.repository";
import { listAccounts } from "../accounts/account.repository";
import type { Account } from "../accounts/account.types";
import { findMarketById } from "../markets/market.repository";
import { findPersistedWalletByAccountAndType } from "../wallets/wallet.repository";
import type {
  WeeklyAccountingPeriod,
  WeeklyAccountSummary,
} from "./weekly-accounting.types";
import {
  closeWeeklyAccountingPeriod as closeWeeklyAccountingPeriodRecord,
  closeWeeklyAccountSummary,
  createWeeklyAccountingPeriod,
  createWeeklyAccountSummary,
  findOpenPeriodByMarketAndBrand,
  findPeriodByMarketBrandWindow,
  findWeeklyAccountingPeriodById,
  findWeeklyAccountSummary,
  listWeeklyAccountingPeriods as listWeeklyAccountingPeriodRecords,
  listWeeklyAccountSummaries,
} from "./weekly-accounting.repository";

const WEEKLY_CLOSE_WEEKDAY = "Monday";
const WEEKLY_CLOSE_HOUR = 2;
const WEEKLY_CLOSE_MINUTE = 0;
const WEEKDAYS: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

export class WeeklyAccountingBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeeklyAccountingBusinessRuleError";
  }
}

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "0";

  return {
    year: Number(getPart("year")),
    month: Number(getPart("month")),
    day: Number(getPart("day")),
    hour: Number(getPart("hour")),
    minute: Number(getPart("minute")),
    second: Number(getPart("second")),
    weekday: getPart("weekday"),
  };
}

function getTimeZoneOffsetMs(date: Date, timezone: string) {
  const parts = getZonedDateParts(date, timezone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return zonedAsUtc - date.getTime();
}

function zonedDateTimeToUtc({
  year,
  month,
  day,
  hour,
  minute,
  timezone,
}: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const firstOffset = getTimeZoneOffsetMs(utcGuess, timezone);
  const firstPass = new Date(utcGuess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(firstPass, timezone);

  return new Date(utcGuess.getTime() - secondOffset);
}

function addDaysToLocalDate({
  year,
  month,
  day,
  days,
}: {
  year: number;
  month: number;
  day: number;
  days: number;
}) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function getCurrentWeeklyWindowForTimezone(
  timezone: string,
  now = new Date()
) {
  const localNow = getZonedDateParts(now, timezone);
  const weekdayIndex = WEEKDAYS[localNow.weekday] ?? 1;
  const mondayIndex = WEEKDAYS[WEEKLY_CLOSE_WEEKDAY] ?? 1;
  const daysSinceCloseDay = (weekdayIndex - mondayIndex + 7) % 7;
  const closeDate = addDaysToLocalDate({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
    days: -daysSinceCloseDay,
  });
  let periodStart = zonedDateTimeToUtc({
    ...closeDate,
    hour: WEEKLY_CLOSE_HOUR,
    minute: WEEKLY_CLOSE_MINUTE,
    timezone,
  });

  if (periodStart.getTime() > now.getTime()) {
    const previousCloseDate = addDaysToLocalDate({ ...closeDate, days: -7 });
    periodStart = zonedDateTimeToUtc({
      ...previousCloseDate,
      hour: WEEKLY_CLOSE_HOUR,
      minute: WEEKLY_CLOSE_MINUTE,
      timezone,
    });
  }

  const periodStartLocal = getZonedDateParts(periodStart, timezone);
  const periodEndLocalDate = addDaysToLocalDate({
    year: periodStartLocal.year,
    month: periodStartLocal.month,
    day: periodStartLocal.day,
    days: 7,
  });
  const periodEnd = zonedDateTimeToUtc({
    ...periodEndLocalDate,
    hour: WEEKLY_CLOSE_HOUR,
    minute: WEEKLY_CLOSE_MINUTE,
    timezone,
  });

  return {
    periodStartAt: periodStart.toISOString(),
    periodEndAt: periodEnd.toISOString(),
  };
}

export async function ensureOpenWeeklyPeriodForMarketBrand(
  marketId: string,
  brandId: string
): Promise<WeeklyAccountingPeriod> {
  const market = await findMarketById(marketId);

  if (!market) {
    throw new WeeklyAccountingBusinessRuleError("Market not found.");
  }

  const brand = await findBrandById(brandId);

  if (!brand) {
    throw new WeeklyAccountingBusinessRuleError("Brand not found.");
  }

  const openPeriod = await findOpenPeriodByMarketAndBrand(marketId, brandId);

  if (openPeriod) {
    return openPeriod;
  }

  const currentWindow = getCurrentWeeklyWindowForTimezone(market.timezone);
  const existingWindow = await findPeriodByMarketBrandWindow({
    marketId,
    brandId,
    ...currentWindow,
  });

  if (existingWindow) {
    return existingWindow;
  }

  return createWeeklyAccountingPeriod({
    marketId,
    brandId,
    ...currentWindow,
    status: "OPEN",
  });
}

function shouldCreateSummaryForAccount(account: Account) {
  return account.fundingModel === "CREDIT" || account.fundingModel === "HYBRID";
}

async function buildWeeklySummaryForAccount({
  periodId,
  account,
}: {
  periodId: string;
  account: Account;
}): Promise<WeeklyAccountSummary> {
  const existingSummary = await findWeeklyAccountSummary(periodId, account.id);

  if (existingSummary) {
    return existingSummary;
  }

  const creditWallet = await findPersistedWalletByAccountAndType(
    account.id,
    "CREDIT"
  );
  const openingBalance = Number(creditWallet?.balance ?? 0);
  const closingBalance = openingBalance;
  const pendingExposureAmount = 0;

  // ZERO_BALANCE_CREDIT / ZERO_BALANCE_DEBIT entries are intentionally not
  // posted in this foundation phase. Future close workflow should create
  // reversal-safe ledger entries and store zeroBalanceEntryId.
  return createWeeklyAccountSummary({
    periodId,
    accountId: account.id,
    accountType: account.accountType,
    parentAccountId: account.parentAccountId ?? null,
    fundingModel: account.fundingModel ?? null,
    operatingMode: account.operatingMode ?? null,
    weeklyAccountingMode: account.weeklyAccountingMode ?? "ZERO_BALANCE",
    settlementMode: account.settlementMode ?? "AUTO_SETTLEMENT",
    openingBalance,
    closingBalance,
    settledResultAmount: 0,
    pendingExposureAmount,
    ticketCount: 0,
    settledTicketCount: 0,
    pendingTicketCount: 0,
    activeThisWeek: false,
    hasCarryBalance: openingBalance !== 0,
    hasPendingExposure: pendingExposureAmount !== 0,
    zeroBalanceEntryId: null,
    status: "OPEN",
  });
}

export async function createWeeklySummariesForPeriod(
  periodId: string
): Promise<WeeklyAccountSummary[]> {
  const period = await findWeeklyAccountingPeriodById(periodId);

  if (!period) {
    throw new WeeklyAccountingBusinessRuleError("Weekly period not found.");
  }

  if (period.status === "CLOSED") {
    return listWeeklyAccountSummaries(period.id);
  }

  const accounts = await listAccounts();
  const eligibleAccounts = accounts.filter(
    (account) =>
      account.marketId === period.marketId &&
      account.brandId === period.brandId &&
      shouldCreateSummaryForAccount(account)
  );
  const summaries: WeeklyAccountSummary[] = [];

  for (const account of eligibleAccounts) {
    summaries.push(await buildWeeklySummaryForAccount({ periodId, account }));
  }

  return summaries;
}

export async function closeWeeklyPeriod(
  periodId: string
): Promise<WeeklyAccountingPeriod> {
  const period = await findWeeklyAccountingPeriodById(periodId);

  if (!period) {
    throw new WeeklyAccountingBusinessRuleError("Weekly period not found.");
  }

  if (period.status === "CLOSED") {
    return period;
  }

  const closedAt = new Date().toISOString();
  const summaries = await listWeeklyAccountSummaries(period.id);

  for (const summary of summaries) {
    if (summary.status === "OPEN") {
      await closeWeeklyAccountSummary(summary.id, closedAt);
    }
  }

  return closeWeeklyAccountingPeriodRecord(period.id, closedAt);
}

export async function listWeeklyAccountingPeriods(): Promise<
  WeeklyAccountingPeriod[]
> {
  return listWeeklyAccountingPeriodRecords();
}

export async function listSummariesForPeriod(
  periodId: string
): Promise<WeeklyAccountSummary[]> {
  return listWeeklyAccountSummaries(periodId);
}
