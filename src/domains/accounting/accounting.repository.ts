import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type { PersistedAccountType } from "../accounts/account.types";
import type {
  CloseWeeklyAccountingInput,
  ListWeeklyAccountingSnapshotsInput,
  WeeklyAccountingSnapshot,
} from "./accounting.types";

type WeeklyAccountingSnapshotRow = {
  id: string;
  account_id: string;
  account_type: PersistedAccountType;
  week_start: string;
  week_end: string;
  currency: string;
  opening_balance: string | number;
  closing_balance: string | number;
  settled_wins: string | number;
  settled_losses: string | number;
  net_result: string | number;
  ticket_count: number;
  pending_exposure: string | number;
  generated_at: string;
  created_at: string;
};

const SNAPSHOT_SELECT =
  "id, account_id, account_type, week_start, week_end, currency, opening_balance, closing_balance, settled_wins, settled_losses, net_result, ticket_count, pending_exposure, generated_at, created_at";

export class AccountingRepositoryError extends Error {
  constructor(message = "Accounting persistence operation failed.") {
    super(message);
    this.name = "AccountingRepositoryError";
  }
}

function mapSnapshotRow(
  row: WeeklyAccountingSnapshotRow | null
): WeeklyAccountingSnapshot | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    accountId: row.account_id,
    accountType: row.account_type,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    currency: row.currency,
    openingBalance: Number(row.opening_balance),
    closingBalance: Number(row.closing_balance),
    settledWins: Number(row.settled_wins),
    settledLosses: Number(row.settled_losses),
    netResult: Number(row.net_result),
    ticketCount: row.ticket_count,
    pendingExposure: Number(row.pending_exposure),
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

export async function generateWeeklyAccountingSnapshots(
  input: CloseWeeklyAccountingInput
): Promise<WeeklyAccountingSnapshot[]> {
  const { data, error } = await supabaseServerAdmin.rpc(
    "generate_weekly_accounting_snapshots",
    {
      p_week_start: input.weekStart,
      p_week_end: input.weekEnd,
      p_account_scope: input.accountScope ?? null,
      p_currency: input.currency,
      p_close_mode: input.closeMode ?? null,
      p_correlation_id: input.correlationId ?? null,
    }
  );

  if (error) {
    throw new AccountingRepositoryError(error.message);
  }

  return ((data ?? []) as WeeklyAccountingSnapshotRow[])
    .map(mapSnapshotRow)
    .filter(
      (snapshot): snapshot is WeeklyAccountingSnapshot => Boolean(snapshot)
    );
}

export async function listWeeklyAccountingSnapshots(
  input: ListWeeklyAccountingSnapshotsInput
): Promise<WeeklyAccountingSnapshot[]> {
  let query = supabaseServerAdmin
    .from("weekly_accounting_snapshots")
    .select(SNAPSHOT_SELECT)
    .order("week_start", { ascending: false })
    .order("account_type", { ascending: true });

  if (input.accountId) {
    query = query.eq("account_id", input.accountId);
  }

  if (input.weekStart) {
    query = query.eq("week_start", input.weekStart);
  }

  if (input.weekEnd) {
    query = query.eq("week_end", input.weekEnd);
  }

  if (input.currency) {
    query = query.eq("currency", input.currency);
  }

  const { data, error } = await query;

  if (error) {
    throw new AccountingRepositoryError(error.message);
  }

  return ((data ?? []) as WeeklyAccountingSnapshotRow[])
    .map(mapSnapshotRow)
    .filter(
      (snapshot): snapshot is WeeklyAccountingSnapshot => Boolean(snapshot)
    );
}
