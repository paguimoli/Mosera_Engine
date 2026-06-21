export type AuthorityDomain = "SETTLEMENT" | "LEDGER" | "CREDIT";

export type AuthorityValue = "MONOLITH" | "SERVICE";

export type ComparisonMode = "ENABLED" | "DISABLED";

export type RollbackReadinessStatus = "READY" | "WARNING" | "BLOCKED";

export type AuthorityDomainConfiguration = {
  domain: AuthorityDomain;
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  mismatchAlertThreshold: number;
  serviceUrl: string;
};

export type AuthorityConfigurationSummary = {
  settlement: AuthorityDomainConfiguration;
  ledger: AuthorityDomainConfiguration;
  credit: AuthorityDomainConfiguration;
  evaluatedAt: string;
};

export type ServiceHealthStatus = {
  available: boolean;
  statusCode: number | null;
  error: string | null;
  checkedAt: string;
};

export type DomainRollbackReadiness = AuthorityDomainConfiguration & {
  monolithPathAvailable: boolean;
  serviceHealth: ServiceHealthStatus;
  rollbackStatus: RollbackReadinessStatus;
  reasons: string[];
};

export type RollbackReadinessSummary = {
  settlement: DomainRollbackReadiness;
  ledger: DomainRollbackReadiness;
  credit: DomainRollbackReadiness;
  overallStatus: RollbackReadinessStatus;
  evaluatedAt: string;
};
