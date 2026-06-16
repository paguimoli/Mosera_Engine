export type CloseWeeklyPeriodCommand = {
  periodId: string;
  actorUserId?: string | null;
  correlationId?: string | null;
};

export type WeeklyPeriodClosedEvent = {
  eventType: "accounting.weekly_period.closed";
  periodId: string;
  closedAt: string;
  correlationId?: string | null;
};

export type WeeklyAccountSummaryCreatedEvent = {
  eventType: "accounting.weekly_account_summary.created";
  summaryId: string;
  periodId: string;
  accountId: string;
  openingBalance: number;
  closingBalance: number;
  correlationId?: string | null;
  occurredAt: string;
};
