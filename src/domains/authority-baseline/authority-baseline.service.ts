import { validateRollbackReadiness } from "../authority-control/authority-control.service";
import type {
  DomainRollbackReadiness,
  ServiceHealthStatus,
} from "../authority-control/authority-control.types";
import { getCreditStabilizationStatus } from "../credit-authority/credit-authority.service";
import { getLedgerStabilizationStatus } from "../ledger-authority/ledger-authority.service";
import { listRecentOutboxEvents } from "../outbox/outbox.service";
import { getQueueHealthSummary } from "../operations/queue-health.service";
import {
  getOperationsMetricsSummary,
  getOutboxObservabilitySummary,
} from "../operations/worker-observability.service";
import { getSettlementStabilizationStatus } from "../settlement-stabilization/settlement-stabilization.service";
import { pingRedis } from "@/src/lib/redis/redis.client";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  AuthorityBaselineDomainStatus,
  AuthorityBaselineStatus,
  BaselineCheck,
  BaselineStatus,
  EventAuditSummary,
  FinancialInvariantReport,
  RollbackDrillSummary,
  ServiceWorkerObservabilitySummary,
} from "./authority-baseline.types";

type CountResult = {
  count: number;
  error: string | null;
};

type CreditReservationRow = {
  id: string;
  player_id: string;
  ticket_id: string;
  status: string;
  reserved_amount: string | number;
  released_amount: string | number;
  settled_amount: string | number;
  remaining_exposure: string | number;
};

type CreditSettlementApplicationRow = {
  id: string;
  reservation_id: string;
  ticket_id: string;
  settlement_id: string;
};

type CreditWalletRow = {
  id: string;
  account_id: string;
  balance: string | number;
  credit_limit: string | number | null;
};

type LedgerReferenceRow = {
  id: string;
  reference_type: string | null;
  reference_id: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function statusMax(statuses: BaselineStatus[]): BaselineStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function serviceHealthOk(): ServiceHealthStatus {
  return {
    available: true,
    statusCode: 200,
    error: null,
    checkedAt: nowIso(),
  };
}

function serviceHealthError(error: unknown): ServiceHealthStatus {
  return {
    available: false,
    statusCode: null,
    error: error instanceof Error ? error.message : "Unknown health error.",
    checkedAt: nowIso(),
  };
}

async function checkAppHealth(): Promise<ServiceHealthStatus> {
  return serviceHealthOk();
}

async function checkDatabaseHealth(): Promise<ServiceHealthStatus> {
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .select("id", { count: "exact", head: true })
    .limit(1);

  if (error) {
    return {
      ...serviceHealthError(error.message),
      error: error.message,
    };
  }

  return serviceHealthOk();
}

async function checkRedisHealth(): Promise<ServiceHealthStatus> {
  try {
    await pingRedis();

    return serviceHealthOk();
  } catch (error) {
    return serviceHealthError(error);
  }
}

function checkResult(
  name: string,
  status: BaselineStatus,
  message: string,
  metrics: Record<string, unknown>
): BaselineCheck {
  return {
    name,
    status,
    message,
    metrics,
  };
}

async function countRows(table: string): Promise<CountResult> {
  const { count, error } = await supabaseServerAdmin
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) {
    return { count: 0, error: error.message };
  }

  return { count: count ?? 0, error: null };
}

async function listRecentReservations() {
  const { data, error } = await supabaseServerAdmin
    .from("credit_reservations")
    .select(
      "id, player_id, ticket_id, status, reserved_amount, released_amount, settled_amount, remaining_exposure"
    )
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(error.message);

  return (data ?? []) as CreditReservationRow[];
}

async function listRecentSettlementApplications() {
  const { data, error } = await supabaseServerAdmin
    .from("credit_settlement_applications")
    .select("id, reservation_id, ticket_id, settlement_id")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(error.message);

  return (data ?? []) as CreditSettlementApplicationRow[];
}

async function listCreditWallets() {
  const { data, error } = await supabaseServerAdmin
    .from("financial_wallets")
    .select("id, account_id, balance, credit_limit")
    .eq("wallet_type", "CREDIT")
    .eq("status", "ACTIVE")
    .limit(1000);

  if (error) throw new Error(error.message);

  return (data ?? []) as CreditWalletRow[];
}

async function listRecentLedgerReferences() {
  const { data, error } = await supabaseServerAdmin
    .from("financial_ledger_entries")
    .select("id, reference_type, reference_id")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) throw new Error(error.message);

  return (data ?? []) as LedgerReferenceRow[];
}

async function getFinancialInvariantReport(): Promise<FinancialInvariantReport> {
  const generatedAt = nowIso();

  try {
    const [
      settlementApplications,
      ledgerEntries,
      reservations,
      applications,
      wallets,
      ledgerReferences,
    ] = await Promise.all([
      countRows("credit_settlement_applications"),
      countRows("financial_ledger_entries"),
      listRecentReservations(),
      listRecentSettlementApplications(),
      listCreditWallets(),
      listRecentLedgerReferences(),
    ]);
    const applicationsByReservation = new Set(
      applications.map((application) => application.reservation_id)
    );
    const applicationReferenceIds = new Set(
      applications.flatMap((application) => [
        application.id,
        application.settlement_id,
        application.reservation_id,
        application.ticket_id,
      ])
    );
    const ledgerReferencesForSettlement = ledgerReferences.filter(
      (entry) => entry.reference_id && applicationReferenceIds.has(entry.reference_id)
    );
    const orphanSettledReservations = reservations.filter(
      (reservation) =>
        reservation.status === "SETTLED" &&
        !applicationsByReservation.has(reservation.id)
    );
    const inconsistentReservations = reservations.filter((reservation) => {
      const reserved = Number(reservation.reserved_amount);
      const released = Number(reservation.released_amount);
      const remaining = Number(reservation.remaining_exposure);

      return remaining < 0 || released + remaining > reserved;
    });
    const pendingExposureByAccount = new Map<string, number>();

    for (const reservation of reservations) {
      if (
        reservation.status === "RESERVED" ||
        reservation.status === "PARTIALLY_RELEASED"
      ) {
        pendingExposureByAccount.set(
          reservation.player_id,
          (pendingExposureByAccount.get(reservation.player_id) ?? 0) +
            Number(reservation.remaining_exposure)
        );
      }
    }

    const negativeAvailableCreditWallets = wallets.filter((wallet) => {
      const creditLimit = Number(wallet.credit_limit ?? 0);
      const balance = Number(wallet.balance);
      const pendingExposure = pendingExposureByAccount.get(wallet.account_id) ?? 0;

      return creditLimit + balance - pendingExposure < 0;
    });
    const checks = [
      checkResult(
        "SETTLEMENT_RESULT_PERSISTED",
        settlementApplications.error
          ? "WARNING"
          : settlementApplications.count > 0
            ? "READY"
            : "WARNING",
        settlementApplications.count > 0
          ? "Credit settlement applications are persisted."
          : "No credit settlement applications were found.",
        settlementApplications
      ),
      checkResult(
        "LEDGER_POSTING_EXISTS_FOR_SETTLEMENT",
        ledgerEntries.error
          ? "WARNING"
          : ledgerReferencesForSettlement.length > 0
            ? "READY"
            : "WARNING",
        ledgerReferencesForSettlement.length > 0
          ? "Ledger entries reference recent settlement evidence."
          : "No recent ledger entry directly references credit settlement evidence.",
        {
          ledgerEntryCount: ledgerEntries.count,
          ledgerEntryCountError: ledgerEntries.error,
          matchedSettlementLedgerReferences:
            ledgerReferencesForSettlement.length,
        }
      ),
      checkResult(
        "CREDIT_EXPOSURE_RESERVATION_CONSISTENT",
        inconsistentReservations.length === 0 ? "READY" : "BLOCKED",
        inconsistentReservations.length === 0
          ? "Recent reservation exposure fields are internally consistent."
          : "Recent reservations contain inconsistent exposure fields.",
        {
          sampledReservations: reservations.length,
          inconsistentReservationCount: inconsistentReservations.length,
        }
      ),
      checkResult(
        "NO_NEGATIVE_AVAILABLE_CREDIT",
        negativeAvailableCreditWallets.length === 0 ? "READY" : "BLOCKED",
        negativeAvailableCreditWallets.length === 0
          ? "Sampled active credit wallets do not have negative available credit."
          : "Sampled active credit wallets include negative available credit.",
        {
          sampledCreditWallets: wallets.length,
          negativeAvailableCreditWalletCount:
            negativeAvailableCreditWallets.length,
        }
      ),
      checkResult(
        "NO_ORPHAN_RESERVATION_AFTER_SETTLEMENT",
        orphanSettledReservations.length === 0 ? "READY" : "BLOCKED",
        orphanSettledReservations.length === 0
          ? "Recent settled reservations have settlement applications."
          : "Recent settled reservations are missing settlement applications.",
        {
          sampledReservations: reservations.length,
          orphanSettledReservationCount: orphanSettledReservations.length,
        }
      ),
      checkResult(
        "NO_MISSING_LEDGER_REFERENCE_FOR_CREDIT_BACKED_SETTLEMENT",
        ledgerReferencesForSettlement.length > 0 ? "READY" : "WARNING",
        ledgerReferencesForSettlement.length > 0
          ? "Recent credit-backed settlements have ledger references."
          : "Ledger reference coverage for recent credit-backed settlements is not complete.",
        {
          sampledSettlementApplications: applications.length,
          matchedSettlementLedgerReferences:
            ledgerReferencesForSettlement.length,
        }
      ),
      checkResult(
        "LEDGER_APPEND_ONLY_IMMUTABILITY",
        "WARNING",
        "Financial ledger entries are append-only by service convention; no table-level update/delete trigger was detected in this baseline.",
        {
          ledgerEntryCount: ledgerEntries.count,
          ledgerEntryCountError: ledgerEntries.error,
          advisoryOnly: true,
        }
      ),
    ];

    return {
      status: statusMax(checks.map((check) => check.status)),
      checks,
      generatedAt,
    };
  } catch (error) {
    return {
      status: "WARNING",
      checks: [
        checkResult(
          "FINANCIAL_INVARIANT_REPORT",
          "WARNING",
          "Financial invariant report could not be fully generated.",
          {
            error: error instanceof Error ? error.message : "Unknown error.",
          }
        ),
      ],
      generatedAt,
    };
  }
}

function domainStatus({
  authority,
  certificationStatus,
  rollback,
}: {
  authority: AuthorityBaselineDomainStatus["authority"];
  certificationStatus: string;
  rollback: DomainRollbackReadiness;
}): AuthorityBaselineDomainStatus {
  return {
    authority,
    certificationStatus,
    comparisonMode: rollback.comparisonMode,
    rollbackReadiness: rollback.rollbackStatus,
    rollbackReady: rollback.rollbackStatus === "READY",
    serviceHealth: rollback.serviceHealth,
  };
}

function drillDomain(rollback: DomainRollbackReadiness) {
  return {
    authority: rollback.authority,
    comparisonMode: rollback.comparisonMode,
    rollbackStatus: rollback.rollbackStatus,
    serviceHealth: rollback.serviceHealth,
    reasons: rollback.reasons,
  };
}

async function getEventAuditSummary(): Promise<EventAuditSummary> {
  const [outbox, recentEvents] = await Promise.all([
    getOutboxObservabilitySummary(),
    listRecentOutboxEvents({ limit: 100 }),
  ]);
  const recentAuthorityEvents = recentEvents.filter((event) =>
    event.eventType.startsWith("authority.")
  );
  const recentCertificationEvents = recentAuthorityEvents.filter((event) =>
    event.eventType.endsWith(".certified")
  );
  const warnings: string[] = [];

  if (outbox.failedCount > 0) {
    warnings.push("Failed outbox events are present.");
  }
  if (outbox.deadLetterCount > 0) {
    warnings.push("Dead-letter outbox events are present.");
  }
  if (recentCertificationEvents.length < 3) {
    warnings.push("Fewer than three recent certification events are visible.");
  }

  return {
    status:
      outbox.failedCount > 0 || outbox.deadLetterCount > 0
        ? "WARNING"
        : "READY",
    pendingOutboxCount: outbox.pendingCount,
    failedOutboxCount: outbox.failedCount,
    deadLetterOutboxCount: outbox.deadLetterCount,
    recentAuthorityEvents: recentAuthorityEvents.slice(0, 20),
    recentCertificationEvents: recentCertificationEvents.slice(0, 10),
    warnings,
    generatedAt: nowIso(),
  };
}

async function getServiceWorkerObservability({
  rollbackReadiness,
}: {
  rollbackReadiness: Awaited<ReturnType<typeof validateRollbackReadiness>>;
}): Promise<ServiceWorkerObservabilitySummary> {
  const [appHealth, databaseHealth, redisHealth, queueHealth, metrics] =
    await Promise.all([
      checkAppHealth(),
      checkDatabaseHealth(),
      checkRedisHealth(),
      getQueueHealthSummary(),
      getOperationsMetricsSummary(),
    ]);
  const warnings: string[] = [];

  if (!redisHealth.available) warnings.push("Redis health is unavailable.");
  if (!databaseHealth.available) warnings.push("Database health is unavailable.");
  if (metrics.lag.severity !== "HEALTHY") {
    warnings.push(...metrics.lag.reasons);
  }
  if (metrics.workers.heartbeats.length === 0) {
    warnings.push("No worker heartbeat or derived activity was observed.");
  }

  return {
    status: warnings.length > 0 ? "WARNING" : "READY",
    appHealth,
    databaseHealth,
    redisHealth,
    settlementServiceHealth: rollbackReadiness.settlement.serviceHealth,
    ledgerServiceHealth: rollbackReadiness.ledger.serviceHealth,
    creditWalletServiceHealth: rollbackReadiness.credit.serviceHealth,
    rabbitmqHealth: queueHealth.rabbitmq,
    workerHeartbeatCount: metrics.workers.heartbeats.length,
    staleWorkerCount: metrics.workers.staleWorkers.length,
    queueLag: metrics.lag,
    outboxLag: {
      oldestUnpublishedAgeSeconds:
        metrics.outbox.oldestUnpublishedAgeSeconds,
      pendingCount: metrics.outbox.pendingCount,
      failedCount: metrics.outbox.failedCount,
      deadLetterCount: metrics.outbox.deadLetterCount,
    },
    warnings,
    generatedAt: nowIso(),
  };
}

export async function getAuthorityBaselineStatus(): Promise<AuthorityBaselineStatus> {
  const [
    settlementStatus,
    ledgerStatus,
    creditStatus,
    rollbackReadiness,
    financialInvariants,
    eventAudit,
  ] = await Promise.all([
    getSettlementStabilizationStatus({ window: "7d" }),
    getLedgerStabilizationStatus(),
    getCreditStabilizationStatus(),
    validateRollbackReadiness(),
    getFinancialInvariantReport(),
    getEventAuditSummary(),
  ]);
  const serviceWorkerObservability = await getServiceWorkerObservability({
    rollbackReadiness,
  });
  const settlement = domainStatus({
    authority: rollbackReadiness.settlement.authority,
    certificationStatus: settlementStatus.certificationStatus,
    rollback: rollbackReadiness.settlement,
  });
  const ledger = domainStatus({
    authority: rollbackReadiness.ledger.authority,
    certificationStatus: ledgerStatus.certificationStatus,
    rollback: rollbackReadiness.ledger,
  });
  const credit = domainStatus({
    authority: rollbackReadiness.credit.authority,
    certificationStatus: creditStatus.certificationStatus,
    rollback: rollbackReadiness.credit,
  });
  const blockers: string[] = [];
  const warnings: string[] = [];
  const domains = [
    ["Settlement", settlement],
    ["Ledger", ledger],
    ["Credit", credit],
  ] as const;

  for (const [name, domain] of domains) {
    if (domain.authority !== "SERVICE") {
      blockers.push(`${name} authority must be SERVICE.`);
    }
    if (domain.certificationStatus !== "CERTIFIED") {
      blockers.push(`${name} certification must be CERTIFIED.`);
    }
    if (domain.comparisonMode !== "ENABLED") {
      blockers.push(`${name} comparison mode must be ENABLED.`);
    }
    if (domain.rollbackReadiness !== "READY") {
      blockers.push(`${name} rollback readiness must be READY.`);
    }
    if (!domain.serviceHealth.available) {
      blockers.push(`${name} service health is unavailable.`);
    }
  }

  for (const check of financialInvariants.checks) {
    if (check.status === "BLOCKED") blockers.push(check.message);
    if (check.status === "WARNING") warnings.push(check.message);
  }

  warnings.push(...eventAudit.warnings);
  warnings.push(...serviceWorkerObservability.warnings);

  const rollbackDrillSummary: RollbackDrillSummary = {
    settlement: drillDomain(rollbackReadiness.settlement),
    ledger: drillDomain(rollbackReadiness.ledger),
    credit: drillDomain(rollbackReadiness.credit),
    overallStatus: rollbackReadiness.overallStatus,
    evaluatedAt: rollbackReadiness.evaluatedAt,
  };
  const overallBaselineStatus =
    blockers.length > 0
      ? "BLOCKED"
      : statusMax([
          financialInvariants.status,
          eventAudit.status,
          serviceWorkerObservability.status,
        ]);

  return {
    settlement,
    ledger,
    credit,
    overallBaselineStatus,
    blockers,
    warnings: [...new Set(warnings)],
    financialInvariants,
    rollbackDrillSummary,
    eventAudit,
    serviceWorkerObservability,
    generatedAt: nowIso(),
  };
}
