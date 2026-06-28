import type { AuthorityBaselineStatus } from "../authority-baseline/authority-baseline.types";

export type SecuritySeverity =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "INFORMATIONAL";

export type SecurityFindingStatus =
  | "IMPLEMENTED"
  | "OPEN"
  | "DEFERRED"
  | "ACCEPTED";

export type SecurityCategory =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "SESSION_MANAGEMENT"
  | "HTTP_SECURITY"
  | "SECRETS_MANAGEMENT"
  | "CONTAINER_SECURITY"
  | "DEPENDENCY_SECURITY"
  | "INPUT_VALIDATION"
  | "AUDIT_INTEGRITY"
  | "INFRASTRUCTURE_SECURITY";

export type SecurityPostureStatus =
  | "READY"
  | "WARNING"
  | "ACTION_REQUIRED";

export type SecurityFinding = {
  id: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  status: SecurityFindingStatus;
  title: string;
  risk: string;
  evidence: string[];
  recommendation: string;
  implementedImprovement: string | null;
};

export type SecuritySeveritySummary = Record<SecuritySeverity, number>;

export type SecurityPlatformState = {
  settlement: {
    authority: string;
    certificationStatus: string;
    comparisonMode: string;
    rollbackReadiness: string;
  };
  ledger: {
    authority: string;
    certificationStatus: string;
    comparisonMode: string;
    rollbackReadiness: string;
  };
  credit: {
    authority: string;
    certificationStatus: string;
    comparisonMode: string;
    rollbackReadiness: string;
  };
  baselineStatus: AuthorityBaselineStatus["overallBaselineStatus"];
};

export type SecurityDependencyAuditStatus = {
  status: "PASS" | "WARNING" | "FAIL" | "UNAVAILABLE";
  threshold: "low" | "moderate" | "high" | "critical";
  totalVulnerabilities: number;
  counts: {
    low: number;
    moderate: number;
    high: number;
    critical: number;
  };
  checkedAt: string | null;
  error: string | null;
};

export type SecurityControlStatus = {
  authRateLimit: {
    enabled: boolean;
    mode: "IN_MEMORY";
    distributed: boolean;
    limitation: string;
  };
  rabbitmqSecrets: {
    defaultCredentialsDetected: boolean;
    productionSecretEnforcementEnabled: boolean;
    posture: "READY" | "WARNING" | "ACTION_REQUIRED";
  };
  dependencyAudit: SecurityDependencyAuditStatus;
  csp: {
    enabled: boolean;
    tightened: boolean;
    nonceBased: boolean;
    limitation: string;
  };
};

export type SecurityFindingsReport = {
  findings: SecurityFinding[];
  severitySummary: SecuritySeveritySummary;
  implementedImprovements: SecurityFinding[];
  deferredItems: SecurityFinding[];
  controlStatus: SecurityControlStatus;
  generatedAt: string;
};

export type SecurityStatus = {
  status: SecurityPostureStatus;
  generatedAt: string;
  openCriticalCount: number;
  openHighCount: number;
  openMediumCount: number;
  implementedImprovementCount: number;
  severitySummary: SecuritySeveritySummary;
  blockers: string[];
  warnings: string[];
  recommendation: string;
  platformState: SecurityPlatformState;
  controlStatus: SecurityControlStatus;
};

export type SecuritySummary = {
  status: SecurityPostureStatus;
  posture: string;
  generatedAt: string;
  severitySummary: SecuritySeveritySummary;
  implementedImprovements: SecurityFinding[];
  deferredItems: SecurityFinding[];
  riskRegister: SecurityFinding[];
  recommendation: string;
  platformState: SecurityPlatformState;
  controlStatus: SecurityControlStatus;
};
