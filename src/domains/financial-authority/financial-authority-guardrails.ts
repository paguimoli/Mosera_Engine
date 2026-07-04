import type {
  AuthorityDomain,
  AuthorityDomainConfiguration,
  AuthorityValue,
} from "../authority-control/authority-control.types";

export type FinancialAuthorityProductionStatus =
  | "MONOLITH_ALLOWED"
  | "PRODUCTION_READY"
  | "NOT_PRODUCTION_READY";

export type FinancialAuthorityCapabilityEvidence = {
  serviceReachable: boolean;
  readinessHealthy: boolean;
  mutationCapabilityEnabled: boolean;
  durablePersistenceConfigured: boolean;
  idempotencySupportConfigured: boolean;
  qaCapabilityMarkerPresent: boolean;
};

export type FinancialAuthorityGuardrailStatus = {
  domain: AuthorityDomain;
  authority: AuthorityValue;
  serviceUrl: string;
  productionStatus: FinancialAuthorityProductionStatus;
  productionReady: boolean;
  allowedToRun: boolean;
  failClosed: boolean;
  capabilityEvidence: FinancialAuthorityCapabilityEvidence;
  blockers: string[];
  warnings: string[];
};

export type FinancialAuthorityGuardrailSummary = {
  status: "PASS" | "FAIL";
  productionReady: boolean;
  domains: Record<Lowercase<AuthorityDomain>, FinancialAuthorityGuardrailStatus>;
  blockers: string[];
  warnings: string[];
  evaluatedAt: string;
};

type GuardrailInput = {
  config: AuthorityDomainConfiguration;
  serviceReachable?: boolean;
  readinessHealthy?: boolean;
  mutationCapabilityEnabled?: boolean;
  durablePersistenceConfigured?: boolean;
  idempotencySupportConfigured?: boolean;
  qaCapabilityMarkerPresent?: boolean;
};

type EnvironmentReader = Pick<NodeJS.ProcessEnv, string>;

const DOMAIN_ENV_PREFIX: Record<AuthorityDomain, string> = {
  SETTLEMENT: "SETTLEMENT_SERVICE",
  LEDGER: "LEDGER_SERVICE",
  CREDIT: "CREDIT_SERVICE",
};
const SERVICE_READINESS_TIMEOUT_MS = 2_000;

function isEnabled(value: unknown) {
  return String(value ?? "").trim().toUpperCase() === "ENABLED";
}

function hasMarker(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

function lowerDomain(domain: AuthorityDomain): Lowercase<AuthorityDomain> {
  return domain.toLowerCase() as Lowercase<AuthorityDomain>;
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export async function checkFinancialAuthorityServiceReadiness(
  serviceUrl: string
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_READINESS_TIMEOUT_MS);

  try {
    const response = await fetch(`${trimTrailingSlash(serviceUrl)}/health/ready`, {
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function readFinancialAuthorityCapabilityEvidenceFromEnv(
  domain: AuthorityDomain,
  env: EnvironmentReader = process.env
): Pick<
  FinancialAuthorityCapabilityEvidence,
  | "mutationCapabilityEnabled"
  | "durablePersistenceConfigured"
  | "idempotencySupportConfigured"
  | "qaCapabilityMarkerPresent"
> {
  const prefix = DOMAIN_ENV_PREFIX[domain];

  return {
    mutationCapabilityEnabled: isEnabled(env[`${prefix}_MUTATION_CAPABILITY`]),
    durablePersistenceConfigured: isEnabled(env[`${prefix}_DURABLE_PERSISTENCE`]),
    idempotencySupportConfigured: isEnabled(env[`${prefix}_IDEMPOTENCY_SUPPORT`]),
    qaCapabilityMarkerPresent: hasMarker(env[`${prefix}_QA_CAPABILITY_MARKER`]),
  };
}

export function evaluateFinancialAuthorityGuardrail({
  config,
  serviceReachable = false,
  readinessHealthy = false,
  mutationCapabilityEnabled = false,
  durablePersistenceConfigured = false,
  idempotencySupportConfigured = false,
  qaCapabilityMarkerPresent = false,
}: GuardrailInput): FinancialAuthorityGuardrailStatus {
  const capabilityEvidence: FinancialAuthorityCapabilityEvidence = {
    serviceReachable,
    readinessHealthy,
    mutationCapabilityEnabled,
    durablePersistenceConfigured,
    idempotencySupportConfigured,
    qaCapabilityMarkerPresent,
  };
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (config.authority === "MONOLITH") {
    warnings.push(
      `${config.domain} authority remains MONOLITH; service production mutation capability is not required.`
    );

    return {
      domain: config.domain,
      authority: config.authority,
      serviceUrl: config.serviceUrl,
      productionStatus: "MONOLITH_ALLOWED",
      productionReady: false,
      allowedToRun: true,
      failClosed: false,
      capabilityEvidence,
      blockers,
      warnings,
    };
  }

  if (!serviceReachable) {
    blockers.push(`${config.domain} service is not reachable.`);
  }
  if (!readinessHealthy) {
    blockers.push(`${config.domain} service readiness endpoint is not healthy.`);
  }
  if (!mutationCapabilityEnabled) {
    blockers.push(`${config.domain} service mutation capability is not explicitly enabled.`);
  }
  if (!durablePersistenceConfigured) {
    blockers.push(`${config.domain} service durable persistence is not configured.`);
  }
  if (!idempotencySupportConfigured) {
    blockers.push(`${config.domain} service idempotency support is not configured.`);
  }
  if (!qaCapabilityMarkerPresent) {
    blockers.push(`${config.domain} service QA capability marker is missing.`);
  }

  const productionReady = blockers.length === 0;

  return {
    domain: config.domain,
    authority: config.authority,
    serviceUrl: config.serviceUrl,
    productionStatus: productionReady ? "PRODUCTION_READY" : "NOT_PRODUCTION_READY",
    productionReady,
    allowedToRun: productionReady,
    failClosed: !productionReady,
    capabilityEvidence,
    blockers,
    warnings,
  };
}

export function summarizeFinancialAuthorityGuardrails(
  statuses: FinancialAuthorityGuardrailStatus[]
): FinancialAuthorityGuardrailSummary {
  const blockers = statuses.flatMap((status) => status.blockers);
  const warnings = statuses.flatMap((status) => status.warnings);
  const domains = statuses.reduce(
    (result, status) => ({
      ...result,
      [lowerDomain(status.domain)]: status,
    }),
    {} as Record<Lowercase<AuthorityDomain>, FinancialAuthorityGuardrailStatus>
  );

  return {
    status: blockers.length === 0 ? "PASS" : "FAIL",
    productionReady:
      statuses.length > 0 &&
      statuses.every((status) => status.productionStatus === "PRODUCTION_READY"),
    domains,
    blockers,
    warnings,
    evaluatedAt: new Date().toISOString(),
  };
}
