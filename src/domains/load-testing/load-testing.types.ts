export type LoadScenarioName =
  | "CONCURRENT_PLAYER_AUTHENTICATION"
  | "WALLET_RESERVATIONS"
  | "TICKET_PURCHASES"
  | "SETTLEMENT_PROCESSING"
  | "CREDIT_RESERVE_RELEASE_CYCLES"
  | "RABBITMQ"
  | "DATABASE";

export type LoadStepName =
  | "AUTH_SESSION_CONTEXT"
  | "WALLET_EVIDENCE"
  | "CREDIT_EVIDENCE"
  | "TICKET_EVIDENCE"
  | "SETTLEMENT_EVIDENCE"
  | "LEDGER_EVIDENCE"
  | "OUTBOX_EVIDENCE"
  | "WORKER_EVIDENCE"
  | "RABBITMQ_EVIDENCE"
  | "DATABASE_EVIDENCE"
  | "SERVICE_HEALTH_CALLS";

export type LoadStepMeasurement = {
  step: LoadStepName;
  label: string;
  averageLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  maxLatencyMs: number | null;
  sampleCount: number;
  throughputPerSecond: number;
  errorCount: number;
  resultCount: number;
};

export type LoadScenarioMeasurement = {
  scenario: LoadScenarioName;
  label: string;
  concurrency: number;
  measurementMode: "READ_ONLY_BASELINE";
  averageLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  maxLatencyMs: number | null;
  throughputPerSecond: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  retryCount: number;
  conflictCount: number;
  duplicateCount: number;
  queueGrowth: number | null;
  workerUtilization: number | null;
  cpu: {
    userMicroseconds: number;
    systemMicroseconds: number;
    loadAverage: number[];
  };
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  resultCount: number;
  errors: string[];
  stepMeasurements: LoadStepMeasurement[];
};

export type LoadInvariantSummary = {
  authorityUnchanged: boolean;
  settlementServiceCertified: boolean;
  ledgerServiceCertified: boolean;
  creditServiceCertified: boolean;
  comparisonEnabled: boolean;
  rollbackReady: boolean;
  financialTotalsUnchanged: boolean;
  noDoubleWalletReservation: boolean;
  noDuplicateTicket: boolean;
  noDuplicateSettlement: boolean;
  noDuplicateLedgerEntry: boolean;
  noDuplicateCreditReservation: boolean;
  ledgerBalancesReconcile: boolean;
  outboxOrderingPreserved: boolean;
  eventOrderingPreserved: boolean;
  idempotencyPreserved: boolean;
};

export type LoadBaselineReport = {
  generatedAt: string;
  measurementOnly: true;
  methodology: string;
  scenarios: LoadScenarioMeasurement[];
  invariants: LoadInvariantSummary;
  bottlenecks: string[];
  bottleneckBreakdown: {
    slowestScenario: LoadScenarioName | null;
    slowestScenarioLabel: string | null;
    slowestConcurrency: number | null;
    slowestStep: LoadStepName | null;
    slowestStepLabel: string | null;
    averageLatencyMs: number | null;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
    p99LatencyMs: number | null;
    maxLatencyMs: number | null;
    sampleCount: number;
    throughputPerSecond: number;
    errorCount: number;
    likelySource: string;
    recommendation: string;
  };
  warnings: string[];
  authority: {
    settlement: string;
    settlementCertification: string;
    ledger: string;
    ledgerCertification: string;
    credit: string;
    creditCertification: string;
  };
  queue: {
    depthBefore: number | null;
    depthAfter: number | null;
    pendingOutboxBefore: number;
    pendingOutboxAfter: number;
  };
  database: {
    connectionUsage: string;
    lockIndicators: string;
    transactionDuration: string;
  };
};

export type LoadTestStatus = {
  generatedAt: string;
  status: "READY" | "WARNING" | "ACTION_REQUIRED";
  measurementOnly: true;
  supportedScenarios: LoadScenarioName[];
  blockers: string[];
  warnings: string[];
};
