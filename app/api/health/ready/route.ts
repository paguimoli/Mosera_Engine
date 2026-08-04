import { NextResponse } from "next/server";

import {
  AccountRepositoryError,
  getAccountScopeReadiness,
} from "@/src/domains/accounts/account.repository";
import {
  CanonicalTicketRepositoryError,
  getTicketReadiness,
} from "@/src/domains/tickets/canonical-ticket.repository";
import { getLaunchConfigurationReadiness } from "@/src/domains/launch-configuration/launch-configuration";
import { getPlatformMutationAuthorityChecks } from "@/src/domains/platform-management/platform-mutation-authority";
import { getAuthorityConsolidationReadiness } from "@/src/architecture/authorities/authority-consolidation";
import { getCrossServiceContractReadiness } from "@/src/architecture/service-boundaries/cross-service-contracts";
import {
  getOperationalGovernanceReadiness,
  OperationalGovernanceRepositoryError,
} from "@/src/domains/operational-governance/operational-governance.repository";
import { checkOperationalSecurityReadiness } from "@/src/domains/operational-security/operational-security.repository";
import { getOperationalChangeReadiness } from "@/src/domains/operational-change/operational-change.repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [accountChecks, ticketChecks, operationalChecks, operationalSecurityReady, operationalChangeChecks] = await Promise.all([
      getAccountScopeReadiness(),
      getTicketReadiness(),
      getOperationalGovernanceReadiness(),
      checkOperationalSecurityReadiness(),
      getOperationalChangeReadiness(),
    ]);
    const platformMutationChecks = getPlatformMutationAuthorityChecks();
    const authorityConsolidationChecks = getAuthorityConsolidationReadiness();
    const contractIntegrity = getCrossServiceContractReadiness();
    const launchConfiguration = getLaunchConfigurationReadiness();
    const checks = [
      ...accountChecks.map((check) => ({ ...check, authority: "account" })),
      ...ticketChecks.map((check) => ({ ...check, authority: "ticket" })),
      ...operationalChecks.map((check) => ({
        ...check,
        authority: "operational-governance",
      })),
      {
        checkName: "operational_security:canonical_authority",
        ready: operationalSecurityReady,
        issueCount: operationalSecurityReady ? 0 : 1,
        authority: "operational-security",
      },
      ...operationalChangeChecks.map((check) => ({
        ...check,
        authority: "operational-change",
      })),
      ...platformMutationChecks.map((check) => ({
        ...check,
        authority: "platform-mutation",
      })),
      ...authorityConsolidationChecks,
      ...launchConfiguration.checks.map((check) => ({
        checkName: `launch_configuration:${check.name.toLowerCase()}`,
        ready: check.ready,
        issueCount: check.ready ? 0 : 1,
        authority: "launch-configuration",
      })),
    ];
    const ready = checks.every((check) => check.ready);

    return NextResponse.json(
      {
        status: ready ? "ready" : "not_ready",
        dependencies: [
          {
            name: "postgres",
            status: "READY",
          },
        ],
        capabilities: {
          backendFreezeRuntimeIntegrity: ready,
          accountPlayerAgentScopeGovernance: accountChecks.every(
            (check) => check.ready
          ),
          canonicalPlatformHierarchy: accountChecks
            .filter((check) => check.checkName.startsWith("platform_authority:"))
            .every((check) => check.ready),
          canonicalTicketLifecycle: ticketChecks.every((check) => check.ready),
          ticketPlatformBackendFreezeReady: ticketChecks.every(
            (check) => check.ready
          ),
          ticketLegacyProductionMutationDisabled: true,
          canonicalPlatformMutationAuthority: platformMutationChecks.every(
            (check) => check.ready
          ),
          legacyPlatformProductionMutationDisabled: platformMutationChecks
            .filter((check) => check.checkName.includes("legacy_"))
            .every((check) => check.ready),
          coreAuthoritiesConsolidated: authorityConsolidationChecks.every(
            (check) => check.ready
          ),
          crossAuthorityIntegrity: authorityConsolidationChecks.every(
            (check) =>
              check.registered &&
              check.healthy &&
              check.productionCapable &&
              check.governed &&
              check.auditable
          ),
          crossServiceContractIntegrity: contractIntegrity.ready,
          repositoryWorkerSqlIntegrity:
            contractIntegrity.uniqueImplementations,
          operationalGovernanceAuthority: operationalChecks.every(
            (check) => check.ready
          ),
          operationalSecurityAuthority: operationalSecurityReady,
          operationalChangeAuthority: operationalChangeChecks.every((check) => check.ready),
          launchConfigurationFrozen: launchConfiguration.ready,
          creditOnlyLaunch: process.env.CREDIT_ONLY_LAUNCH_ENABLED === "true",
          cashierLaunchDisabled: process.env.CASHIER_LAUNCH_ENABLED === "false",
        },
        configuration: {
          environment: launchConfiguration.environment,
          version: launchConfiguration.version,
          fingerprint: launchConfiguration.fingerprint,
        },
        authorityOwnership: authorityConsolidationChecks,
        contractIntegrity,
        checks,
      },
      { status: ready ? 200 : 503 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "not_ready",
        dependencies: [
          {
            name: "postgres",
            status: "NOT_READY",
          },
        ],
        capabilities: {
          backendFreezeRuntimeIntegrity: false,
          accountPlayerAgentScopeGovernance: false,
          canonicalPlatformHierarchy: false,
          canonicalTicketLifecycle: false,
          ticketPlatformBackendFreezeReady: false,
          ticketLegacyProductionMutationDisabled: true,
          canonicalPlatformMutationAuthority: false,
          legacyPlatformProductionMutationDisabled: false,
          coreAuthoritiesConsolidated: false,
          crossAuthorityIntegrity: false,
          crossServiceContractIntegrity: false,
          repositoryWorkerSqlIntegrity: false,
          operationalGovernanceAuthority: false,
          operationalSecurityAuthority: false,
          operationalChangeAuthority: false,
          launchConfigurationFrozen: false,
          creditOnlyLaunch: false,
          cashierLaunchDisabled: false,
        },
        error:
          error instanceof AccountRepositoryError ||
          error instanceof CanonicalTicketRepositoryError ||
          error instanceof OperationalGovernanceRepositoryError
            ? error.message
            : "Application readiness failed.",
      },
      { status: 503 }
    );
  }
}
