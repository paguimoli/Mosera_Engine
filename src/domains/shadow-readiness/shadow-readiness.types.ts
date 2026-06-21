export type ShadowReadinessWindow = "24h" | "7d" | "30d" | "all";

export type DomainReadinessStatus = "READY" | "WARNING" | "BLOCKED";

export type ShadowReadinessDomain = "settlement" | "ledger" | "credit";

export type ExtractionRecommendation =
  | "SETTLEMENT_READY"
  | "LEDGER_READY"
  | "CREDIT_READY"
  | "ALL_READY"
  | "CONTINUE_SHADOWING"
  | "BLOCKED_BY_CRITICAL_MISMATCHES"
  | "BLOCKED_BY_FAILURE_RATE"
  | "SHADOW_DATA_UNAVAILABLE";

export type ShadowReadinessThresholds = {
  readyMismatchRate: number;
  readyFailureRate: number;
  blockedMismatchRate: number;
};

export type DomainReadinessMetrics = {
  domain: ShadowReadinessDomain;
  label: string;
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  matchRate: number;
  mismatchRate: number;
  failureRate: number;
  criticalMismatchCount: number;
  readinessStatus: DomainReadinessStatus;
  thresholds: ShadowReadinessThresholds;
  reasons: string[];
  unavailable: boolean;
  error?: string | null;
};

export type PlatformExtractionReadiness = {
  settlementStatus: DomainReadinessStatus;
  ledgerStatus: DomainReadinessStatus;
  creditStatus: DomainReadinessStatus;
  platformStatus: DomainReadinessStatus;
  evaluatedAt: string;
};

export type ShadowReadinessSummary = {
  window: ShadowReadinessWindow;
  domains: {
    settlement: DomainReadinessMetrics;
    ledger: DomainReadinessMetrics;
    credit: DomainReadinessMetrics;
  };
  platform: PlatformExtractionReadiness;
  evidenceReadiness?: {
    rawReadiness: {
      readiness: DomainReadinessStatus;
      mismatchRate: number;
      failureRate: number;
    };
    adjustedReadiness: {
      readiness: DomainReadinessStatus;
      mismatchRate: number;
      failureRate: number;
    };
    promotionReadiness: {
      readiness: DomainReadinessStatus;
      mismatchRate: number;
      failureRate: number;
    };
  };
  recommendations: ExtractionRecommendation[];
  extractionRecommendation: ExtractionRecommendation;
};

export type ShadowDomainTableConfig = {
  domain: ShadowReadinessDomain;
  label: string;
  runTable: string;
  mismatchTable: string;
  failureTable: string;
  thresholds: ShadowReadinessThresholds;
};

export type ShadowDomainRawMetrics = {
  runs: Array<{ comparison_status: "MATCH" | "MISMATCH" | "NOT_COMPARED" }>;
  failures: Array<{ id: string }>;
  mismatches: Array<{ severity: "INFO" | "WARNING" | "CRITICAL" }>;
};
