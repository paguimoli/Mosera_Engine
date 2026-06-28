import { getAuthorityBaselineStatus } from "../authority-baseline/authority-baseline.service";
import { getAuthRateLimitStatus } from "../auth/auth-rate-limit";
import type {
  SecurityControlStatus,
  SecurityDependencyAuditStatus,
  SecurityFinding,
  SecurityFindingsReport,
  SecurityPlatformState,
  SecuritySeverity,
  SecuritySeveritySummary,
  SecurityStatus,
  SecuritySummary,
} from "./security-hardening.types";

const SEVERITIES: SecuritySeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFORMATIONAL",
];

function nowIso() {
  return new Date().toISOString();
}

function summarize(findings: SecurityFinding[]): SecuritySeveritySummary {
  return SEVERITIES.reduce(
    (summary, severity) => ({
      ...summary,
      [severity]: findings.filter((finding) => finding.severity === severity)
        .length,
    }),
    {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFORMATIONAL: 0,
    } satisfies SecuritySeveritySummary
  );
}

function isOpenRisk(finding: SecurityFinding) {
  return finding.status === "OPEN" || finding.status === "DEFERRED";
}

function hasDefaultRabbitMqCredentials() {
  const rabbitMqUrl = process.env.RABBITMQ_URL ?? "";

  return (
    rabbitMqUrl.includes("lottery_dev_password") ||
    rabbitMqUrl.includes("guest:guest")
  );
}

function isProductionSecretEnforcementEnabled() {
  return process.env.SECURITY_ENFORCE_PRODUCTION_SECRETS === "true";
}

function hasPlaceholderSupabaseSecret() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  return (
    serviceRoleKey.includes("dummy") ||
    serviceRoleKey.includes("placeholder") ||
    serviceRoleKey.length < 24
  );
}

function platformStateFromBaseline(
  baseline: Awaited<ReturnType<typeof getAuthorityBaselineStatus>>
): SecurityPlatformState {
  return {
    settlement: {
      authority: baseline.settlement.authority,
      certificationStatus: baseline.settlement.certificationStatus,
      comparisonMode: baseline.settlement.comparisonMode,
      rollbackReadiness: baseline.settlement.rollbackReadiness,
    },
    ledger: {
      authority: baseline.ledger.authority,
      certificationStatus: baseline.ledger.certificationStatus,
      comparisonMode: baseline.ledger.comparisonMode,
      rollbackReadiness: baseline.ledger.rollbackReadiness,
    },
    credit: {
      authority: baseline.credit.authority,
      certificationStatus: baseline.credit.certificationStatus,
      comparisonMode: baseline.credit.comparisonMode,
      rollbackReadiness: baseline.credit.rollbackReadiness,
    },
    baselineStatus: baseline.overallBaselineStatus,
  };
}

function getDependencyAuditStatus(): SecurityDependencyAuditStatus {
  const threshold = (
    process.env.SECURITY_AUDIT_LEVEL || "critical"
  ).toLowerCase() as SecurityDependencyAuditStatus["threshold"];

  return {
    status: "PASS",
    threshold,
    totalVulnerabilities: 0,
    counts: {
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    },
    checkedAt: null,
    error:
      "Runtime API reports release-gate configuration only; run security:audit or ops:dependency-audit for live npm audit results.",
  };
}

export function getSecurityControlStatus(): SecurityControlStatus {
  const authRateLimit = getAuthRateLimitStatus();
  const defaultCredentialsDetected = hasDefaultRabbitMqCredentials();
  const productionSecretEnforcementEnabled = isProductionSecretEnforcementEnabled();
  const rabbitmqPosture =
    defaultCredentialsDetected && productionSecretEnforcementEnabled
      ? "ACTION_REQUIRED"
      : defaultCredentialsDetected
        ? "WARNING"
        : "READY";

  return {
    authRateLimit: {
      enabled: authRateLimit.enabled,
      mode: authRateLimit.mode,
      distributed: authRateLimit.distributed,
      limitation: authRateLimit.limitation,
    },
    rabbitmqSecrets: {
      defaultCredentialsDetected,
      productionSecretEnforcementEnabled,
      posture: rabbitmqPosture,
    },
    dependencyAudit: getDependencyAuditStatus(),
    csp: {
      enabled: true,
      tightened: true,
      nonceBased: false,
      limitation:
        "CSP is tightened with frame, object, manifest, media, and worker restrictions while retaining Next.js-compatible inline/eval allowances.",
    },
  };
}

function getFindings(): SecurityFinding[] {
  const rabbitMqDefaultCredentials = hasDefaultRabbitMqCredentials();
  const placeholderSupabaseSecret = hasPlaceholderSupabaseSecret();

  return [
    {
      id: "SEC-HTTP-HEADERS-001",
      category: "HTTP_SECURITY",
      severity: "MEDIUM",
      status: "IMPLEMENTED",
      title: "HTTP security headers were missing from the application response path.",
      risk: "Without baseline headers, browsers receive less protection against framing, MIME sniffing, permissive referrer leakage, and broad feature access.",
      evidence: [
        "next.config.ts previously had no headers() policy.",
        "A global header policy is now applied for all routes.",
      ],
      recommendation:
        "Keep the baseline header policy enabled and tighten CSP further once production asset and script requirements are finalized.",
      implementedImprovement:
        "Added X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy, and a compatibility CSP.",
    },
    {
      id: "SEC-AUTH-RATE-LIMIT-001",
      category: "AUTHENTICATION",
      severity: "MEDIUM",
      status: "IMPLEMENTED",
      title: "Authentication endpoints rely on account lockout but do not expose a dedicated request rate limiter.",
      risk: "Credential stuffing or password reset abuse can create avoidable load and audit noise before per-account lockout activates.",
      evidence: [
        "Login, password reset, MFA verification, OAuth token, and OAuth introspection routes now apply in-memory IP and identifier limits.",
        "Rate-limited responses use generic messages and do not disclose account existence.",
      ],
      recommendation:
        "Replace or back the in-memory limiter with distributed storage before horizontally scaled production deployment.",
      implementedImprovement:
        "Added process-local rate limiting for sensitive authentication and token endpoints.",
    },
    {
      id: "SEC-CSP-STRICTNESS-001",
      category: "HTTP_SECURITY",
      severity: "LOW",
      status: "IMPLEMENTED",
      title: "Content Security Policy is compatibility-first rather than strict nonce based.",
      risk: "The compatibility policy reduces framing and object injection risk but still allows inline and eval script execution for framework compatibility.",
      evidence: [
        "CSP now includes frame-src, media-src, manifest-src, and worker-src restrictions.",
        "script-src still includes 'unsafe-inline' and 'unsafe-eval' to avoid changing runtime behavior in this remediation phase.",
      ],
      recommendation:
        "Move to a nonce/hash-based CSP after validating Next.js production assets and any inline runtime requirements.",
      implementedImprovement:
        "Tightened the compatibility CSP where safe without introducing nonce or hash plumbing.",
    },
    {
      id: "SEC-CSP-NONCE-001",
      category: "HTTP_SECURITY",
      severity: "LOW",
      status: "DEFERRED",
      title: "Nonce or hash based CSP remains deferred pending architecture review.",
      risk: "Removing inline and eval allowances may require framework-level rendering changes and production asset validation.",
      evidence: [
        "Current CSP retains compatibility allowances required for safe local and production build validation.",
      ],
      recommendation:
        "Design nonce/hash CSP after confirming Next.js runtime script requirements and deployment asset strategy.",
      implementedImprovement: null,
    },
    {
      id: "SEC-INFRA-RABBITMQ-001",
      category: "INFRASTRUCTURE_SECURITY",
      severity: rabbitMqDefaultCredentials ? "MEDIUM" : "INFORMATIONAL",
      status: "IMPLEMENTED",
      title: "RabbitMQ credentials must be production-managed secrets.",
      risk: "Development defaults are acceptable for local QA but unsafe if reused in production deployments.",
      evidence: [
        rabbitMqDefaultCredentials
          ? "The runtime RABBITMQ_URL appears to use a known local development credential."
          : "The runtime RABBITMQ_URL does not expose a known local development credential pattern.",
        isProductionSecretEnforcementEnabled()
          ? "Production secret enforcement is enabled."
          : "Production secret enforcement is disabled for this local/QA runtime.",
        "RabbitMQ is only accessed through the outbox dispatcher and worker path.",
      ],
      recommendation:
        "Set SECURITY_ENFORCE_PRODUCTION_SECRETS=true in production so default credentials become ACTION_REQUIRED.",
      implementedImprovement:
        "Security status now detects default RabbitMQ credentials and escalates to ACTION_REQUIRED when production secret enforcement is enabled.",
    },
    {
      id: "SEC-SECRETS-SUPABASE-001",
      category: "SECRETS_MANAGEMENT",
      severity: placeholderSupabaseSecret ? "HIGH" : "INFORMATIONAL",
      status: placeholderSupabaseSecret ? "DEFERRED" : "ACCEPTED",
      title: "Supabase service role secret must be externally managed.",
      risk: "Placeholder or weak service role secrets would allow privileged data access if used outside local QA.",
      evidence: [
        placeholderSupabaseSecret
          ? "The runtime SUPABASE_SERVICE_ROLE_KEY resembles a placeholder or short secret."
          : "The runtime SUPABASE_SERVICE_ROLE_KEY is present and does not match placeholder patterns.",
        "The service role is used server-side only by repository and evidence services.",
      ],
      recommendation:
        "Enforce production secret injection through the deployment secret manager and reject placeholder values before production start.",
      implementedImprovement: null,
    },
    {
      id: "SEC-CONTAINER-USER-001",
      category: "CONTAINER_SECURITY",
      severity: "INFORMATIONAL",
      status: "ACCEPTED",
      title: "Runtime container runs as the node user.",
      risk: "The runtime process is not running as root, reducing container breakout blast radius.",
      evidence: ["Dockerfile runtime stage uses USER node."],
      recommendation:
        "Keep the non-root runtime user and add image vulnerability scanning to release gates.",
      implementedImprovement: null,
    },
    {
      id: "SEC-PASSWORD-HASHING-001",
      category: "AUTHENTICATION",
      severity: "INFORMATIONAL",
      status: "ACCEPTED",
      title: "Password storage uses Argon2id with explicit cost settings.",
      risk: "Password hashes are generated using a modern password hashing algorithm.",
      evidence: [
        "Password helper uses argon2.argon2id.",
        "Hash metadata records algorithm and createdAt.",
      ],
      recommendation:
        "Review Argon2id cost factors during production capacity testing.",
      implementedImprovement: null,
    },
    {
      id: "SEC-SESSION-TOKEN-001",
      category: "SESSION_MANAGEMENT",
      severity: "INFORMATIONAL",
      status: "ACCEPTED",
      title: "Session tokens are bearer tokens stored server-side as hashes.",
      risk: "Database exposure does not directly reveal bearer tokens.",
      evidence: [
        "Session lookup hashes the presented token before repository lookup.",
        "Session status and expiration are verified before authorization.",
      ],
      recommendation:
        "Continue validating session revocation and operator single-session behavior in auth QA.",
      implementedImprovement: null,
    },
    {
      id: "SEC-RBAC-ADMIN-001",
      category: "AUTHORIZATION",
      severity: "INFORMATIONAL",
      status: "ACCEPTED",
      title: "Administrative and operations APIs use permission-gated access.",
      risk: "Protected operational endpoints require authenticated users with system.admin or explicit permission membership.",
      evidence: [
        "Operations and authority routes call requirePermission(request, 'system.admin').",
        "system.admin supersets specific permissions.",
      ],
      recommendation:
        "Continue expanding route-level authorization QA when new privileged endpoints are added.",
      implementedImprovement: null,
    },
    {
      id: "SEC-DEPENDENCY-AUDIT-001",
      category: "DEPENDENCY_SECURITY",
      severity: "MEDIUM",
      status: "IMPLEMENTED",
      title: "Dependency vulnerability posture requires release-gate audit review.",
      risk: "Known package vulnerabilities may exist unless npm audit or equivalent scanning is run during release.",
      evidence: [
        "security:audit and ops:dependency-audit run npm audit with a configurable threshold.",
        "The default threshold is critical for local/QA; CI can set SECURITY_AUDIT_LEVEL=high or stricter.",
      ],
      recommendation:
        "Run the audit gate in CI and review high findings before lowering the release threshold.",
      implementedImprovement:
        "Added dependency audit operations tooling and package scripts without auto-upgrading dependencies.",
    },
  ];
}

export async function getSecurityFindingsReport(): Promise<SecurityFindingsReport> {
  const findings = getFindings();

  return {
    findings,
    severitySummary: summarize(findings),
    implementedImprovements: findings.filter(
      (finding) => finding.status === "IMPLEMENTED"
    ),
    deferredItems: findings.filter((finding) => finding.status === "DEFERRED"),
    controlStatus: getSecurityControlStatus(),
    generatedAt: nowIso(),
  };
}

export async function getSecurityStatus(): Promise<SecurityStatus> {
  const [baseline, report] = await Promise.all([
    getAuthorityBaselineStatus(),
    getSecurityFindingsReport(),
  ]);
  const openCriticalCount = report.findings.filter(
    (finding) => isOpenRisk(finding) && finding.severity === "CRITICAL"
  ).length;
  const openHighCount = report.findings.filter(
    (finding) => isOpenRisk(finding) && finding.severity === "HIGH"
  ).length;
  const openMediumCount = report.findings.filter(
    (finding) => isOpenRisk(finding) && finding.severity === "MEDIUM"
  ).length;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (openCriticalCount > 0) {
    blockers.push("Open critical security findings require action.");
  }
  if (openHighCount > 0) {
    warnings.push("Open high security findings require operator review.");
  }
  if (openMediumCount > 0) {
    warnings.push("Open medium security findings require a tracked hardening plan.");
  }
  if (report.controlStatus.rabbitmqSecrets.posture === "ACTION_REQUIRED") {
    blockers.push("Default RabbitMQ credentials are present while production secret enforcement is enabled.");
  }
  if (baseline.overallBaselineStatus !== "READY") {
    warnings.push("Authority baseline is not fully READY.");
  }

  const status =
    blockers.length > 0
      ? "ACTION_REQUIRED"
      : warnings.length > 0
        ? "WARNING"
        : "READY";

  return {
    status,
    generatedAt: nowIso(),
    openCriticalCount,
    openHighCount,
    openMediumCount,
    implementedImprovementCount: report.implementedImprovements.length,
    severitySummary: report.severitySummary,
    blockers,
    warnings,
    recommendation:
      status === "ACTION_REQUIRED"
        ? "Resolve critical security blockers before production readiness."
        : "Proceed with prioritized hardening for deferred high and medium findings.",
    platformState: platformStateFromBaseline(baseline),
    controlStatus: report.controlStatus,
  };
}

export async function getSecuritySummary(): Promise<SecuritySummary> {
  const [status, report] = await Promise.all([
    getSecurityStatus(),
    getSecurityFindingsReport(),
  ]);

  return {
    status: status.status,
    posture:
      status.status === "READY"
        ? "Baseline security posture is ready with no open critical, high, or medium findings."
        : "Baseline security posture is established with documented follow-up items.",
    generatedAt: nowIso(),
    severitySummary: report.severitySummary,
    implementedImprovements: report.implementedImprovements,
    deferredItems: report.deferredItems,
    riskRegister: report.findings,
    recommendation: status.recommendation,
    platformState: status.platformState,
    controlStatus: report.controlStatus,
  };
}
