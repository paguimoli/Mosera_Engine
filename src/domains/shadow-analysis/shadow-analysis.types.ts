import type { DomainReadinessStatus } from "../shadow-readiness/shadow-readiness.types";

export type ShadowAnalysisDomain = "SETTLEMENT" | "LEDGER" | "CREDIT";

export type ShadowEvidenceClass =
  | "QA_INTENTIONAL_MISMATCH"
  | "QA_INTENTIONAL_FAILURE"
  | "EXPECTED_TEST_VARIATION"
  | "UNEXPLAINED_MISMATCH"
  | "UNEXPLAINED_FAILURE"
  | "PARITY_DEFECT"
  | "DATA_QUALITY_ISSUE"
  | "INSUFFICIENT_CONTEXT";

export type ShadowEvidenceKind = "MISMATCH" | "FAILURE";

export type ShadowEvidenceConfidence = "LOW" | "MEDIUM" | "HIGH";

export type ShadowEvidenceSeverity = "INFO" | "WARNING" | "CRITICAL";

export type ShadowAnalysisWindow = "24h" | "7d" | "30d" | "all";

export type ShadowReadinessMode = "RAW_READINESS" | "ADJUSTED_READINESS";

export type ClassifiedShadowEvidence = {
  id: string;
  domain: ShadowAnalysisDomain;
  kind: ShadowEvidenceKind;
  evidenceClass: ShadowEvidenceClass;
  confidence: ShadowEvidenceConfidence;
  explanation: string;
  severity?: ShadowEvidenceSeverity | null;
  route: string;
  authorityCandidate: ShadowAnalysisDomain;
  correlationId?: string | null;
  shadowRunId?: string | null;
  entityId?: string | null;
  evidenceType: string;
  fieldName?: string | null;
  failureReason?: string | null;
  createdAt: string;
};

export type ShadowCauseCounts = Record<ShadowEvidenceClass, number>;

export type ShadowAnalysisReadinessMetrics = {
  mode: ShadowReadinessMode;
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  matchRate: number;
  mismatchRate: number;
  failureRate: number;
  criticalMismatchCount: number;
  readinessStatus: DomainReadinessStatus;
  reasons: string[];
};

export type ShadowDomainAnalysis = {
  domain: ShadowAnalysisDomain;
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  classifiedCauses: ShadowCauseCounts;
  rawReadiness: ShadowAnalysisReadinessMetrics;
  adjustedReadiness: ShadowAnalysisReadinessMetrics;
  affectedRoutes: string[];
  authorityCandidate: ShadowAnalysisDomain;
};

export type ShadowPlatformAnalysis = {
  raw: {
    readiness: DomainReadinessStatus;
    mismatchRate: number;
    failureRate: number;
  };
  adjusted: {
    readiness: DomainReadinessStatus;
    mismatchRate: number;
    failureRate: number;
  };
};

export type ShadowAnalysisSummary = {
  window: ShadowAnalysisWindow;
  evaluatedAt: string;
  platform: ShadowPlatformAnalysis;
  domains: {
    settlement: ShadowDomainAnalysis;
    ledger: ShadowDomainAnalysis;
    credit: ShadowDomainAnalysis;
  };
  rootCause: {
    mismatchCountsByCategory: ShadowCauseCounts;
    failureCountsByCategory: ShadowCauseCounts;
    affectedDomains: ShadowAnalysisDomain[];
    affectedRoutes: string[];
    affectedAuthorityCandidates: ShadowAnalysisDomain[];
  };
  recommendation: string;
};
