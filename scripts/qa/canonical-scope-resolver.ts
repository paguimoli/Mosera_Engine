import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { AuthContext } from "../../src/domains/auth/auth-context.types";
import {
  canonicalPermissionGranted,
  hasCanonicalGlobalScope,
  resolveCanonicalScope,
} from "../../src/domains/scope/canonical-scope-resolver";

type Check = {
  name: string;
  status: "PASS" | "FAIL";
  metadata?: Record<string, unknown>;
};

const checks: Check[] = [];

function check(
  name: string,
  passed: boolean,
  metadata: Record<string, unknown> = {}
) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

async function source(file: string) {
  return readFile(file, "utf8");
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) return sourceFiles(target);
        return /\.(?:ts|tsx|mjs|cjs)$/.test(entry.name) ? [target] : [];
      })
    )
  ).flat();
}

function context(
  scopes: Array<{ scopeType: string; scopeId: string }>,
  permissions = ["reports.view"]
): AuthContext {
  return {
    user: {
      id: "identity-1",
      username: "scope-qa",
      email: "",
      displayName: "Scope QA",
      identityClass: "PLATFORM_OPERATOR",
      status: "ACTIVE",
      failedLoginAttempts: 0,
    },
    session: {
      id: "session-1",
      userId: "identity-1",
      createdAt: new Date(0).toISOString(),
      lastSeenAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    },
    groups: [
      {
        id: "role-1",
        name: "Operations Admin",
        isSystemGroup: true,
        createdAt: new Date(0).toISOString(),
      },
    ],
    permissions: permissions.map((key) => ({
      id: key,
      key,
      isSystemPermission: true,
      createdAt: new Date(0).toISOString(),
    })),
    platformScopes: scopes,
    hasPermission: (key) =>
      permissions.includes(key) || permissions.includes("system.admin"),
  };
}

async function main() {
  const tenantContext = context([{ scopeType: "tenant", scopeId: "TENANT-A" }]);
  const ownTenant = resolveCanonicalScope(tenantContext, {
    organizationId: "organization-a",
    tenantId: "tenant-a",
    brandId: "brand-a",
    marketId: "market-a",
  });
  const otherTenant = resolveCanonicalScope(tenantContext, {
    organizationId: "organization-b",
    tenantId: "tenant-b",
    brandId: "brand-b",
    marketId: "market-b",
  });
  check(
    "tenant scope is normalized and cannot cross tenant",
    ownTenant.authorized && !otherTenant.authorized
  );

  const agentContext = context([{ scopeType: "AGENT", scopeId: "agent-a" }]);
  const playerScope = resolveCanonicalScope(agentContext, {
    accountId: "player-a",
    accountType: "PLAYER",
    agentAccountId: "agent-a",
    masterAgentAccountId: "master-a",
    hierarchyAccountIds: ["player-a", "agent-a", "master-a"],
    operatingMode: null,
    fundingModel: "HYBRID",
    defaultFundingSource: "FREE_PLAY",
    balanceAuthority: "EXTERNAL",
  });
  check(
    "operational hierarchy derives player agent and master-agent scope",
    playerScope.authorized &&
      playerScope.playerAccountId === "player-a" &&
      playerScope.agentAccountId === "agent-a" &&
      playerScope.masterAgentAccountId === "master-a"
  );
  check(
    "operating mode and funding eligibility derive from authoritative account",
    playerScope.operatingMode === null &&
      ["CASH", "CREDIT", "FREE_PLAY", "EXTERNAL_BALANCE"].every((item) =>
        playerScope.fundingInstrumentEligibility.includes(
          item as "CASH" | "CREDIT" | "FREE_PLAY" | "EXTERNAL_BALANCE"
        )
      )
  );
  check(
    "roles and permissions derive from authenticated identity",
    playerScope.roles.includes("Operations Admin") &&
      canonicalPermissionGranted(playerScope, "reports.view") &&
      !canonicalPermissionGranted(playerScope, "system.admin")
  );
  check(
    "global access is explicit and not inferred from a client target",
    !hasCanonicalGlobalScope(resolveCanonicalScope(tenantContext)) &&
      hasCanonicalGlobalScope(
        resolveCanonicalScope(
          context([{ scopeType: "GLOBAL", scopeId: "platform" }])
        )
      )
  );

  const accountGuard = await source(
    "src/domains/accounts/account-scope-governance.ts"
  );
  const ticketGuard = await source(
    "src/domains/tickets/canonical-ticket.authorization.ts"
  );
  const platformGuard = await source(
    "src/domains/platform-management/platform-management-auth.ts"
  );
  const authMiddleware = await source("src/domains/auth/auth-middleware.ts");
  check(
    "all production authorization guards delegate to the canonical resolver",
    [accountGuard, ticketGuard, platformGuard, authMiddleware].every((contents) =>
      contents.includes("resolveCanonicalScope")
    ) &&
      !ticketGuard.includes("function hasScope") &&
      !accountGuard.includes("function includesScope") &&
      !platformGuard.includes("function hasScope")
  );

  const ticketRoute = await source("app/api/tickets/route.ts");
  const depositRoute = await source("app/api/cashier/deposits/route.ts");
  const withdrawalRoute = await source("app/api/cashier/withdrawals/route.ts");
  const adjustmentRoute = await source("app/api/commissions/adjust/route.ts");
  const creditReservationRoute = await source(
    "app/api/credit/reservations/route.ts"
  );
  const creditReleaseRoute = await source(
    "app/api/credit/reservations/[reservationId]/release/route.ts"
  );
  const creditSettlementRoute = await source(
    "app/api/credit/settlements/apply/route.ts"
  );
  const walletLedgerRoute = await source(
    "app/api/wallets/[walletId]/ledger/route.ts"
  );
  check(
    "client account identifiers are authoritative lookups only",
    ticketRoute.includes("resolveScopedAccount(context, playerAccountId)") &&
      depositRoute.includes("resolveScopedAccount(authContext, accountId)") &&
      withdrawalRoute.includes("resolveScopedAccount(authContext, accountId)") &&
      adjustmentRoute.includes("resolveScopedAccount(context, accountId)") &&
      creditReservationRoute.includes(
        "resolveScopedAccount(context, playerId)"
      ) &&
      creditReleaseRoute.includes(
        "resolveScopedAccount(context, existing.playerId)"
      ) &&
      creditSettlementRoute.includes(
        "resolveScopedAccount(context, existing.playerId)"
      ) &&
      walletLedgerRoute.includes(
        "resolveScopedAccount(context, wallet.accountId)"
      )
  );
  check(
    "client cannot select the financial audit actor",
    adjustmentRoute.includes("actorUserId: context.user.id") &&
      !adjustmentRoute.includes(
        "actorUserId: getString(payload.actorUserId"
      )
  );

  const runtimeFiles = (
    await Promise.all(
      ["app/api", "src/domains/workers", "scripts/workers"].map(sourceFiles)
    )
  ).flat();
  const duplicateScopeMatchers: string[] = [];
  for (const file of runtimeFiles) {
    const contents = await source(file);
    if (
      /function (?:hasScope|includesScope|normalizedScopes)\s*\(/.test(
        contents
      )
    ) {
      duplicateScopeMatchers.push(path.relative(process.cwd(), file));
    }
  }
  check(
    "no duplicate production scope matcher remains",
    duplicateScopeMatchers.length === 0,
    { duplicateScopeMatchers }
  );

  const settlementEndpoints = await source(
    "services/settlement-service/Controllers/SettlementInputIngestionEndpoints.cs"
  );
  const ledgerEndpoints = await source(
    "services/ledger-service/Controllers/LedgerEndpoints.cs"
  );
  const creditEndpoints = await source(
    "services/credit-wallet-service/Controllers/CreditWalletAuthorityEndpoints.cs"
  );
  check(
    ".NET authorities consume canonical resource contracts rather than client scope headers",
    creditEndpoints.includes("InternalServiceAuthorizer") &&
      settlementEndpoints.includes("SettlementInput") &&
      ledgerEndpoints.includes("Ledger") &&
      [settlementEndpoints, ledgerEndpoints, creditEndpoints].every(
        (contents) =>
          !/X-(?:Tenant|Brand|Market|Website|Account)/i.test(contents)
      )
  );

  const failed = checks.filter((item) => item.status === "FAIL");
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "PASS" : "FAIL",
        checkCount: checks.length,
        failedCount: failed.length,
        checks,
      },
      null,
      2
    )
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
