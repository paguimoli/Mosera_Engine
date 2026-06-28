import type {
  AuthorityBaselineStatus,
  BaselineStatus,
} from "../authority-baseline/authority-baseline.types";
import type { DomainRollbackReadiness } from "../authority-control/authority-control.types";
import type { QueueHealthSummary } from "../operations/queue-health.types";
import type {
  OperationsMetricsSummary,
  OutboxObservabilitySummary,
  WorkerObservabilitySummary,
} from "../operations/worker-observability.types";

export type ResilienceScenarioStatus = "READY" | "WARNING" | "BLOCKED";

export type ResilienceScenario = {
  name: string;
  status: ResilienceScenarioStatus;
  simulatedOnly: boolean;
  destructiveTest: false;
  checks: string[];
  evidence: Record<string, unknown>;
};

export type ResilienceDuplicatePrevention = {
  duplicateTickets: number;
  duplicateSettlements: number;
  duplicateLedgerReferences: number;
  duplicateCreditReservations: number;
  sampledTickets: number;
  sampledSettlements: number;
  sampledLedgerEntries: number;
  sampledCreditReservations: number;
};

export type RetryIdempotencyStatus = {
  status: ResilienceScenarioStatus;
  generatedAt: string;
  correlationIdEvidenceCount: number;
  retryEvidenceCount: number;
  duplicatePrevention: ResilienceDuplicatePrevention;
  warnings: string[];
  recommendation: string;
};

export type ServiceRecoverySummary = {
  status: ResilienceScenarioStatus;
  generatedAt: string;
  settlement: DomainRollbackReadiness;
  ledger: DomainRollbackReadiness;
  credit: DomainRollbackReadiness;
  rabbitmq: QueueHealthSummary["rabbitmq"];
  redisHealth: {
    available: boolean;
    status: ResilienceScenarioStatus;
    checkedAt: string;
    error: string | null;
  };
  workers: WorkerObservabilitySummary;
  outbox: OutboxObservabilitySummary;
  warnings: string[];
};

export type FailureRecoveryBaseline = {
  status: ResilienceScenarioStatus;
  generatedAt: string;
  measurementOnly: true;
  destructiveTestsPerformed: false;
  scenarios: ResilienceScenario[];
  authorityBaseline: AuthorityBaselineStatus;
  operationsMetrics: OperationsMetricsSummary;
  retryIdempotency: RetryIdempotencyStatus;
  serviceRecovery: ServiceRecoverySummary;
  blockers: string[];
  warnings: string[];
  recommendation: string;
};

export type ResilienceStatus = {
  status: BaselineStatus;
  generatedAt: string;
  measurementOnly: true;
  destructiveTestsPerformed: false;
  authority: {
    settlement: string;
    ledger: string;
    credit: string;
  };
  certification: {
    settlement: string;
    ledger: string;
    credit: string;
  };
  comparison: {
    settlement: string;
    ledger: string;
    credit: string;
  };
  rollback: {
    settlement: string;
    ledger: string;
    credit: string;
    overall: string;
  };
  serviceHealth: {
    settlement: boolean;
    ledger: boolean;
    credit: boolean;
  };
  rabbitmqVisible: boolean;
  redisVisible: boolean;
  workersVisible: boolean;
  dispatcherVisible: boolean;
  blockers: string[];
  warnings: string[];
  recommendation: string;
};
