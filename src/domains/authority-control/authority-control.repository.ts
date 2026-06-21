import type {
  AuthorityDomain,
  AuthorityDomainConfiguration,
  AuthorityValue,
  ComparisonMode,
} from "./authority-control.types";

const DEFAULT_MISMATCH_ALERT_THRESHOLD = 0.001;

type DomainEnvConfig = {
  authorityEnv: string;
  comparisonModeEnv: string;
  mismatchAlertThresholdEnv: string;
  serviceUrlEnv: string;
  defaultServiceUrl: string;
};

const DOMAIN_ENV: Record<AuthorityDomain, DomainEnvConfig> = {
  SETTLEMENT: {
    authorityEnv: "SETTLEMENT_AUTHORITY",
    comparisonModeEnv: "SETTLEMENT_COMPARISON_MODE",
    mismatchAlertThresholdEnv: "SETTLEMENT_MISMATCH_ALERT_THRESHOLD",
    serviceUrlEnv: "SETTLEMENT_SERVICE_URL",
    defaultServiceUrl: "http://settlement-service:8080",
  },
  LEDGER: {
    authorityEnv: "LEDGER_AUTHORITY",
    comparisonModeEnv: "LEDGER_COMPARISON_MODE",
    mismatchAlertThresholdEnv: "LEDGER_MISMATCH_ALERT_THRESHOLD",
    serviceUrlEnv: "LEDGER_SERVICE_URL",
    defaultServiceUrl: "http://ledger-service:8080",
  },
  CREDIT: {
    authorityEnv: "CREDIT_AUTHORITY",
    comparisonModeEnv: "CREDIT_COMPARISON_MODE",
    mismatchAlertThresholdEnv: "CREDIT_MISMATCH_ALERT_THRESHOLD",
    serviceUrlEnv: "CREDIT_SERVICE_URL",
    defaultServiceUrl: "http://credit-wallet-service:8080",
  },
};

function normalizeAuthority(value: string | undefined): AuthorityValue {
  return value === "SERVICE" ? "SERVICE" : "MONOLITH";
}

function normalizeComparisonMode(value: string | undefined): ComparisonMode {
  return value === "DISABLED" ? "DISABLED" : "ENABLED";
}

function assertAuthority(value: AuthorityValue) {
  if (value !== "MONOLITH" && value !== "SERVICE") {
    throw new Error("Unsupported authority value.");
  }
}

function assertComparisonMode(value: ComparisonMode) {
  if (value !== "ENABLED" && value !== "DISABLED") {
    throw new Error("Unsupported comparison mode.");
  }
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

export function readAuthorityDomainConfiguration(
  domain: AuthorityDomain
): AuthorityDomainConfiguration {
  const env = DOMAIN_ENV[domain];

  return {
    domain,
    authority: normalizeAuthority(process.env[env.authorityEnv]),
    comparisonMode: normalizeComparisonMode(process.env[env.comparisonModeEnv]),
    mismatchAlertThreshold: getNumberEnv(
      env.mismatchAlertThresholdEnv,
      DEFAULT_MISMATCH_ALERT_THRESHOLD
    ),
    serviceUrl: process.env[env.serviceUrlEnv]?.trim() || env.defaultServiceUrl,
  };
}

export function readAuthorityConfigurations() {
  return {
    settlement: readAuthorityDomainConfiguration("SETTLEMENT"),
    ledger: readAuthorityDomainConfiguration("LEDGER"),
    credit: readAuthorityDomainConfiguration("CREDIT"),
  };
}

export function setRuntimeAuthorityDomainConfiguration({
  domain,
  authority,
  comparisonMode,
}: {
  domain: AuthorityDomain;
  authority?: AuthorityValue;
  comparisonMode?: ComparisonMode;
}) {
  const env = DOMAIN_ENV[domain];

  if (authority) {
    assertAuthority(authority);
    process.env[env.authorityEnv] = authority;
  }

  if (comparisonMode) {
    assertComparisonMode(comparisonMode);
    process.env[env.comparisonModeEnv] = comparisonMode;
  }

  return readAuthorityDomainConfiguration(domain);
}
