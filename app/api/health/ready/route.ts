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

export const runtime = "nodejs";

export async function GET() {
  try {
    const [accountChecks, ticketChecks] = await Promise.all([
      getAccountScopeReadiness(),
      getTicketReadiness(),
    ]);
    const platformMutationChecks = getPlatformMutationAuthorityChecks();
    const authorityConsolidationChecks = getAuthorityConsolidationReadiness();
    const launchConfiguration = getLaunchConfigurationReadiness();
    const checks = [
      ...accountChecks.map((check) => ({ ...check, authority: "account" })),
      ...ticketChecks.map((check) => ({ ...check, authority: "ticket" })),
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
          accountPlayerAgentScopeGovernance: accountChecks.every(
            (check) => check.ready
          ),
          canonicalPlatformHierarchy: accountChecks
            .filter((check) => check.checkName.startsWith("platform_authority:"))
            .every((check) => check.ready),
          canonicalTicketLifecycle: ticketChecks.every((check) => check.ready),
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
          launchConfigurationFrozen: launchConfiguration.ready,
          creditOnlyLaunch: process.env.CREDIT_ONLY_LAUNCH_ENABLED === "true",
          cashierLaunchDisabled: process.env.CASHIER_LAUNCH_ENABLED === "false",
        },
        configuration: {
          environment: launchConfiguration.environment,
          version: launchConfiguration.version,
          fingerprint: launchConfiguration.fingerprint,
        },
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
          accountPlayerAgentScopeGovernance: false,
          canonicalPlatformHierarchy: false,
          canonicalTicketLifecycle: false,
          ticketLegacyProductionMutationDisabled: true,
          canonicalPlatformMutationAuthority: false,
          legacyPlatformProductionMutationDisabled: false,
          coreAuthoritiesConsolidated: false,
          launchConfigurationFrozen: false,
          creditOnlyLaunch: false,
          cashierLaunchDisabled: false,
        },
        error:
          error instanceof AccountRepositoryError ||
          error instanceof CanonicalTicketRepositoryError
            ? error.message
            : "Application readiness failed.",
      },
      { status: 503 }
    );
  }
}
