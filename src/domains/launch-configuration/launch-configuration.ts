import { createHash } from "node:crypto";

export const LAUNCH_CONFIGURATION_VERSION = "P1-014.5-2026-07-25";

const launchConfigurationBaseline = {
  version: LAUNCH_CONFIGURATION_VERSION,
  approvalStatus: "APPROVED_BASELINE",
  freezeStatus: "READY_FOR_BACKEND_FREEZE",
  operatingModel: "CREDIT_ONLY",
  authorityModes: {
    authentication: "MONOLITH",
    creditWallet: "MONOLITH",
    ledger: "MONOLITH",
    settlement: "MONOLITH",
    outcome: "DISABLED_PENDING_PROMOTION",
  },
  canonicalPaths: {
    platform: true,
    ticket: true,
    outcomePublication: true,
    drawOrchestration: true,
    outcomeRecovery: true,
  },
  disabledPaths: {
    cashier: true,
    paymentProviders: true,
    playerCashDeposits: true,
    playerCashWithdrawals: true,
    externalIntegrations: true,
    legacyOutcomePublication: true,
    legacyPlatformMutations: true,
    legacyTicketMutations: true,
    productionUi: true,
    selfServiceOnboarding: true,
  },
  productLaunchStatus: "DISABLED_PENDING_BUSINESS_APPROVAL",
  requiredWorkers: [
    "outbox-dispatcher",
    "critical-financial-worker",
    "ticket-lifecycle-worker",
    "settlement-worker",
    "accounting-worker",
    "commission-worker",
    "reconciliation-worker",
    "operational-access-worker",
    "reporting-worker",
  ],
} as const;

const canonicalBaseline = JSON.stringify(launchConfigurationBaseline);

export const LAUNCH_CONFIGURATION_FINGERPRINT = `sha256:${createHash("sha256")
  .update(canonicalBaseline)
  .digest("hex")}`;

type LaunchConfigurationCheck = {
  readonly name: string;
  readonly ready: boolean;
  readonly expected: string;
  readonly actual: string;
};

const requiredProductionValues: Readonly<Record<string, string>> = {
  LAUNCH_CONFIGURATION_VERSION,
  CREDIT_ONLY_LAUNCH_ENABLED: "true",
  CASHIER_LAUNCH_ENABLED: "false",
  PAYMENT_PROVIDER_INTEGRATION_ENABLED: "false",
  PLAYER_CASH_DEPOSITS_ENABLED: "false",
  PLAYER_CASH_WITHDRAWALS_ENABLED: "false",
  EXTERNAL_INTEGRATIONS_ENABLED: "false",
  PRODUCTION_UI_ENABLED: "false",
  SELF_SERVICE_ONBOARDING_ENABLED: "false",
  PLATFORM_HIERARCHY_MODE: "CANONICAL",
  PLATFORM_LEGACY_DEVELOPMENT_MUTATIONS_ENABLED: "false",
  CANONICAL_TICKET_PATH_ENABLED: "true",
  TICKET_LEGACY_MUTATIONS_ENABLED: "false",
  TICKET_SCOPE_ENFORCEMENT_ENABLED: "true",
  TICKET_CORRELATION_CONTRACT_ENABLED: "true",
  CANONICAL_DRAW_ORCHESTRATION_ENABLED: "true",
  OUTCOME_CANONICAL_PIPELINE_ENABLED: "false",
  OUTCOME_LEGACY_PUBLICATION_ENABLED: "false",
  OUTCOME_CANONICAL_RECOVERY_ENABLED: "true",
  PRODUCT_LAUNCH_STATUS: "DISABLED_PENDING_BUSINESS_APPROVAL",
  REQUIRED_WORKERS_ENABLED: "true",
  AUDIT_RECORDING_ENABLED: "true",
  READINESS_ENFORCEMENT_ENABLED: "true",
  AUTH_AUTHORITY: "MONOLITH",
  LEDGER_AUTHORITY: "MONOLITH",
  CREDIT_AUTHORITY: "MONOLITH",
  SETTLEMENT_AUTHORITY: "MONOLITH",
};

export function getLaunchConfigurationReadiness(): {
  readonly ready: boolean;
  readonly environment: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly checks: readonly LaunchConfigurationCheck[];
} {
  const environment = (
    process.env.DEPLOYMENT_ENVIRONMENT ??
    process.env.NODE_ENV ??
    "local"
  )
    .trim()
    .toLowerCase();
  const governedEnvironment =
    environment === "production" || environment === "staging";
  const checks = Object.entries(requiredProductionValues).map(
    ([name, expected]) => {
      const actual = process.env[name] ?? "";
      return {
        name,
        expected,
        actual,
        ready: !governedEnvironment || actual === expected,
      };
    }
  );

  return {
    ready: checks.every((check) => check.ready),
    environment,
    version: LAUNCH_CONFIGURATION_VERSION,
    fingerprint: LAUNCH_CONFIGURATION_FINGERPRINT,
    checks,
  };
}

export function cashierLaunchMutationsEnabled() {
  return process.env.CASHIER_LAUNCH_ENABLED === "true";
}
