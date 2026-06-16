export type GenerateWeeklyCommissionsCommand = {
  periodId: string;
  actorUserId?: string | null;
  correlationId?: string | null;
};

export type WeeklyCommissionRecordCreatedEvent = {
  eventType: "commission.weekly_record.created";
  commissionRecordId: string;
  periodId: string;
  accountId: string;
  commissionPlanId: string;
  amount: number;
  currencyCode: string;
  correlationId?: string | null;
  occurredAt: string;
};
