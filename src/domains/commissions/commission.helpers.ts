import type { PlayerAccount } from "../accounts/account.types";
import { calculateWeeklyFigure } from "../ledger/ledger.helpers";
import type { LedgerTransaction } from "../ledger/ledger.types";
import type {
  CommissionModel,
  CommissionPlan,
  CommissionRollup,
} from "./commission.types";

export function generateCommissionRunId() {
  return `COMMISSION-RUN-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function generateCommissionRecordId({
  commissionRunId,
  accountId,
}: {
  commissionRunId: string;
  accountId: string;
}) {
  return `COMMISSION-RECORD-${commissionRunId}-${accountId}`;
}

export function getDownlineAccounts(
  accounts: PlayerAccount[],
  accountId: string
) {
  const downline: PlayerAccount[] = [];
  const collect = (parentId: string) => {
    accounts
      .filter((account) => account.parentId === parentId)
      .forEach((account) => {
        downline.push(account);
        collect(account.id);
      });
  };

  collect(accountId);
  return downline;
}

function isWithinPeriod(
  transaction: LedgerTransaction,
  periodStart?: string | null,
  periodEnd?: string | null
) {
  const createdAt = new Date(transaction.createdAt).getTime();
  const startsAt = periodStart ? new Date(periodStart).getTime() : null;
  const endsAt = periodEnd ? new Date(periodEnd).getTime() : null;

  if (Number.isNaN(createdAt)) {
    return false;
  }

  if (startsAt !== null && createdAt < startsAt) {
    return false;
  }

  if (endsAt !== null && createdAt > endsAt) {
    return false;
  }

  return true;
}

export function filterLedgerTransactionsByPeriod({
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}) {
  return ledgerTransactions.filter((transaction) =>
    isWithinPeriod(transaction, periodStart, periodEnd)
  );
}

export function getAccountWeeklyFigure({
  accountId,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  accountId: string;
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}) {
  return calculateWeeklyFigure(
    filterLedgerTransactionsByPeriod({
      ledgerTransactions,
      periodStart,
      periodEnd,
    }),
    accountId
  );
}

export function getDirectPlayerWeeklyFigure({
  account,
  accounts,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  account: PlayerAccount;
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}) {
  if (account.accountType === "player") {
    return getAccountWeeklyFigure({
      accountId: account.id,
      ledgerTransactions,
      periodStart,
      periodEnd,
    });
  }

  return accounts
    .filter(
      (candidate) =>
        candidate.parentId === account.id && candidate.accountType === "player"
    )
    .reduce(
      (total, player) =>
        total +
        getAccountWeeklyFigure({
          accountId: player.id,
          ledgerTransactions,
          periodStart,
          periodEnd,
        }),
      0
    );
}

function getPlayerDownline(accounts: PlayerAccount[], accountId: string) {
  return getDownlineAccounts(accounts, accountId).filter(
    (account) => account.accountType === "player"
  );
}

export function getAgentRollup({
  account,
  accounts,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  account: PlayerAccount;
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}): CommissionRollup {
  const directWeeklyFigure = getDirectPlayerWeeklyFigure({
    account,
    accounts,
    ledgerTransactions,
    periodStart,
    periodEnd,
  });
  const directPlayers = accounts.filter(
    (candidate) =>
      candidate.parentId === account.id && candidate.accountType === "player"
  );

  return {
    accountId: account.id,
    directWeeklyFigure,
    downlineWeeklyFigure: 0,
    totalWeeklyFigure: directWeeklyFigure,
    pendingExposure: directPlayers.reduce(
      (total, player) => total + Number(player.currentExposure || 0),
      0
    ),
  };
}

export function getMasterRollup({
  account,
  accounts,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  account: PlayerAccount;
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}): CommissionRollup {
  const directWeeklyFigure = getDirectPlayerWeeklyFigure({
    account,
    accounts,
    ledgerTransactions,
    periodStart,
    periodEnd,
  });
  const playerDownline = getPlayerDownline(accounts, account.id);
  const totalWeeklyFigure = playerDownline.reduce(
    (total, player) =>
      total +
      getAccountWeeklyFigure({
        accountId: player.id,
        ledgerTransactions,
        periodStart,
        periodEnd,
      }),
    0
  );

  return {
    accountId: account.id,
    directWeeklyFigure,
    downlineWeeklyFigure: totalWeeklyFigure - directWeeklyFigure,
    totalWeeklyFigure,
    pendingExposure: playerDownline.reduce(
      (total, player) => total + Number(player.currentExposure || 0),
      0
    ),
  };
}

export function getSuperMasterRollup({
  account,
  accounts,
  ledgerTransactions,
  periodStart,
  periodEnd,
}: {
  account: PlayerAccount;
  accounts: PlayerAccount[];
  ledgerTransactions: LedgerTransaction[];
  periodStart?: string | null;
  periodEnd?: string | null;
}) {
  return getMasterRollup({
    account,
    accounts,
    ledgerTransactions,
    periodStart,
    periodEnd,
  });
}

export function calculateCommissionAmount({
  plan,
  commissionBase,
}: {
  plan: CommissionPlan;
  commissionBase: number;
}) {
  if (
    plan.model === "weekly_figure_percentage" ||
    plan.model === "revenue_share"
  ) {
    return commissionBase * (Number(plan.percentage || 0) / 100);
  }

  if (plan.model === "flat_weekly_fee") {
    return Number(plan.flatAmount || 0);
  }

  if (["tiered_percentage", "hybrid"].includes(plan.model as CommissionModel)) {
    // TODO Phase 5.x: implement tier and hybrid rule structures once operator
    // commission policies are finalized.
    return 0;
  }

  return 0;
}
