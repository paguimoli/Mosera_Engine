import type {
  DatabaseHotspot,
  DatabasePerformanceRecommendation,
  DatabaseQueryMeasurement,
  DatabaseTelemetryStatus,
} from "../database-performance/database-performance.types";

export type NativeDatabaseMetricSource =
  | "PG_STAT_ACTIVITY"
  | "PG_LOCKS"
  | "EXPLAIN"
  | "SUPABASE_REST_LIMITED"
  | "UNAVAILABLE";

export type NativeDatabaseStatus = {
  generatedAt: string;
  measurementOnly: true;
  status: DatabaseTelemetryStatus;
  source: NativeDatabaseMetricSource;
  sessions: {
    active: number | null;
    idle: number | null;
    waiting: number | null;
    total: number | null;
  };
  waitEvents: Array<{
    waitEventType: string | null;
    waitEvent: string | null;
    count: number;
  }>;
  transactionStates: Array<{
    state: string | null;
    count: number;
  }>;
  pool: {
    utilization: number | null;
    exhaustionEvents: number | null;
  };
  limitations: string[];
};

export type DatabaseLockAnalysis = {
  generatedAt: string;
  measurementOnly: true;
  status: DatabaseTelemetryStatus;
  source: NativeDatabaseMetricSource;
  lockWaits: number | null;
  blockedQueries: number | null;
  blockingSessions: number | null;
  locksByMode: Array<{
    mode: string | null;
    granted: boolean | null;
    count: number;
  }>;
  limitations: string[];
};

export type DatabaseSessionAnalysis = {
  generatedAt: string;
  measurementOnly: true;
  status: DatabaseTelemetryStatus;
  source: NativeDatabaseMetricSource;
  activeSessions: number | null;
  idleSessions: number | null;
  waitingSessions: number | null;
  longestRunningSession: {
    durationMs: number | null;
    state: string | null;
    waitEventType: string | null;
    waitEvent: string | null;
  };
  transactionStates: NativeDatabaseStatus["transactionStates"];
  waitEvents: NativeDatabaseStatus["waitEvents"];
  limitations: string[];
};

export type ExplainPlanSummary = {
  id: string;
  label: string;
  table: string;
  sourceMeasurement: DatabaseQueryMeasurement;
  status: DatabaseTelemetryStatus;
  source: NativeDatabaseMetricSource;
  planAvailable: boolean;
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  estimatedRows: number | null;
  estimatedCost: number | null;
  scanTypes: string[];
  joinStrategies: string[];
  sortOperations: string[];
  aggregateOperations: string[];
  sequentialScanIndicators: string[];
  indexUsageIndicators: string[];
  statementTemplate: string;
  limitations: string[];
};

export type DatabaseExplainPlanReport = {
  generatedAt: string;
  measurementOnly: true;
  status: DatabaseTelemetryStatus;
  source: NativeDatabaseMetricSource;
  plans: ExplainPlanSummary[];
  limitations: string[];
};

export type DatabaseTimingRanking = {
  generatedAt: string;
  measurementOnly: true;
  repositoryTiming: Array<
    DatabaseHotspot & {
      invocationCount: number;
      cumulativeDbTimeMs: number | null;
      averageDbTimeMs: number | null;
      medianDbTimeMs: number | null;
      p95DbTimeMs: number | null;
      p99DbTimeMs: number | null;
    }
  >;
  endpointTiming: Array<
    DatabaseHotspot & {
      invocationCount: number;
      dbTimeMs: number | null;
      applicationTimeMs: number | null;
      serializationTimeMs: number | null;
      totalRequestTimeMs: number | null;
    }
  >;
};

export type DatabaseObservabilityReport = {
  generatedAt: string;
  measurementOnly: true;
  nativeStatus: NativeDatabaseStatus;
  lockAnalysis: DatabaseLockAnalysis;
  sessionAnalysis: DatabaseSessionAnalysis;
  explainPlans: DatabaseExplainPlanReport;
  timing: DatabaseTimingRanking;
  recommendations: DatabasePerformanceRecommendation[];
  limitations: string[];
};
