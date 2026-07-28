import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import type {
  AccountBalanceAuthority,
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
  PersistedAccountType,
} from "@/src/domains/accounts/account.types";

export type CanonicalScopeClaim = {
  readonly scopeType: string;
  readonly scopeId: string;
};

export type CanonicalScopePrincipal = {
  readonly identityId: string;
  readonly sessionId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly claims: readonly CanonicalScopeClaim[];
};

export type CanonicalScopeTarget = {
  readonly platformId?: string | null;
  readonly organizationId?: string | null;
  readonly tenantId?: string | null;
  readonly brandId?: string | null;
  readonly marketId?: string | null;
  readonly websiteId?: string | null;
  readonly accountId?: string | null;
  readonly accountType?: PersistedAccountType | null;
  readonly parentAccountId?: string | null;
  readonly playerProfileId?: string | null;
  readonly agentAccountId?: string | null;
  readonly masterAgentAccountId?: string | null;
  readonly hierarchyAccountIds?: readonly string[];
  readonly operatingMode?: AccountOperatingMode | null;
  readonly fundingModel?: AccountFundingModel | null;
  readonly defaultFundingSource?: AccountDefaultFundingSource | null;
  readonly balanceAuthority?: AccountBalanceAuthority | null;
};

export type FundingInstrumentEligibility =
  | "CASH"
  | "CREDIT"
  | "FREE_PLAY"
  | "EXTERNAL_BALANCE";

export type CanonicalScopeResolution = {
  readonly identityId: string;
  readonly sessionId: string;
  readonly organizationId: string | null;
  readonly tenantId: string | null;
  readonly brandId: string | null;
  readonly marketId: string | null;
  readonly websiteId: string | null;
  readonly accountId: string | null;
  readonly playerAccountId: string | null;
  readonly playerProfileId: string | null;
  readonly agentAccountId: string | null;
  readonly masterAgentAccountId: string | null;
  readonly hierarchyAccountIds: readonly string[];
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly claims: readonly CanonicalScopeClaim[];
  readonly operatingMode: AccountOperatingMode | null;
  readonly fundingInstrumentEligibility: readonly FundingInstrumentEligibility[];
  readonly matchedClaim: CanonicalScopeClaim | null;
  readonly targetBound: boolean;
  readonly authorized: boolean;
};

const SCOPE_PRECEDENCE = [
  "ACCOUNT",
  "PLAYER",
  "AGENT",
  "MASTER_AGENT",
  "WEBSITE",
  "MARKET",
  "BRAND",
  "TENANT",
  "ORGANIZATION",
  "PLATFORM",
] as const;

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function normalizedClaims(claims: readonly CanonicalScopeClaim[]): CanonicalScopeClaim[] {
  return claims
    .map((scope) => ({
      scopeType: scope.scopeType.trim().toUpperCase(),
      scopeId: normalize(scope.scopeId),
    }))
    .filter((scope) => scope.scopeType.length > 0 && scope.scopeId.length > 0);
}

function principalFrom(
  source: AuthContext | CanonicalScopePrincipal
): CanonicalScopePrincipal {
  if ("user" in source) {
    return {
      identityId: source.user.id,
      sessionId: source.session.id,
      roles: source.groups.map((group) => group.name),
      permissions: source.permissions.map((permission) => permission.key),
      claims: source.platformScopes ?? [],
    };
  }

  return source;
}

function claimMatches(
  claim: CanonicalScopeClaim,
  scopeType: string,
  scopeId?: string | null
) {
  if (claim.scopeType !== scopeType) return false;
  if (claim.scopeId === "*") return true;
  return Boolean(scopeId) && claim.scopeId === normalize(scopeId ?? "");
}

function targetIds(target: CanonicalScopeTarget) {
  const ids = new Map<string, readonly string[]>();
  const add = (type: string, ...values: Array<string | null | undefined>) => {
    const present = values.filter((value): value is string => Boolean(value));
    if (present.length > 0) ids.set(type, present);
  };

  add("PLATFORM", target.platformId);
  add("ORGANIZATION", target.organizationId);
  add("TENANT", target.tenantId);
  add("BRAND", target.brandId);
  add("MARKET", target.marketId);
  add("WEBSITE", target.websiteId);
  add("ACCOUNT", target.accountId, ...(target.hierarchyAccountIds ?? []));
  add("PLAYER", target.accountType === "PLAYER" ? target.accountId : null);
  add("AGENT", target.agentAccountId, target.accountType === "AGENT" ? target.accountId : null);
  add(
    "MASTER_AGENT",
    target.masterAgentAccountId,
    target.accountType === "MASTER_AGENT" ? target.accountId : null
  );
  return ids;
}

function fundingEligibility(
  target: CanonicalScopeTarget
): FundingInstrumentEligibility[] {
  const eligible = new Set<FundingInstrumentEligibility>();

  if (target.fundingModel === "CASH" || target.fundingModel === "HYBRID") {
    eligible.add("CASH");
  }
  if (target.fundingModel === "CREDIT" || target.fundingModel === "HYBRID") {
    eligible.add("CREDIT");
  }
  if (target.defaultFundingSource === "FREE_PLAY") {
    eligible.add("FREE_PLAY");
  }
  if (target.balanceAuthority === "EXTERNAL") {
    eligible.add("EXTERNAL_BALANCE");
  }

  return [...eligible];
}

export function resolveCanonicalScope(
  source: AuthContext | CanonicalScopePrincipal,
  target: CanonicalScopeTarget = {}
): CanonicalScopeResolution {
  const principal = principalFrom(source);
  const claims = normalizedClaims(principal.claims);
  const permissions = [...principal.permissions];
  const roles = [...principal.roles];
  const ids = targetIds(target);
  const hasTarget = ids.size > 0;
  const globalClaim = claims.find(
    (claim) =>
      claim.scopeType === "GLOBAL" &&
      (claim.scopeId === "platform" || claim.scopeId === "*")
  );
  let matchedClaim: CanonicalScopeClaim | null = globalClaim ?? null;

  if (!matchedClaim) {
    for (const type of SCOPE_PRECEDENCE) {
      const values = ids.get(type) ?? [];
      matchedClaim =
        claims.find((claim) =>
          values.some((value) => claimMatches(claim, type, value))
        ) ?? null;
      if (matchedClaim) break;
    }
  }

  const systemAdmin = permissions.includes("system.admin");
  const playerAccountId =
    target.accountType === "PLAYER" ? target.accountId ?? null : null;
  const agentAccountId =
    target.agentAccountId ??
    (target.accountType === "AGENT" ? target.accountId ?? null : null);
  const masterAgentAccountId =
    target.masterAgentAccountId ??
    (target.accountType === "MASTER_AGENT" ? target.accountId ?? null : null);

  return {
    identityId: principal.identityId,
    sessionId: principal.sessionId,
    organizationId: target.organizationId ?? null,
    tenantId: target.tenantId ?? null,
    brandId: target.brandId ?? null,
    marketId: target.marketId ?? null,
    websiteId: target.websiteId ?? null,
    accountId: target.accountId ?? null,
    playerAccountId,
    playerProfileId: target.playerProfileId ?? null,
    agentAccountId,
    masterAgentAccountId,
    hierarchyAccountIds: target.hierarchyAccountIds ?? [],
    roles,
    permissions,
    claims,
    operatingMode: target.operatingMode ?? null,
    fundingInstrumentEligibility: fundingEligibility(target),
    matchedClaim,
    targetBound: hasTarget,
    authorized: !hasTarget || systemAdmin || Boolean(matchedClaim),
  };
}

export function canonicalPermissionGranted(
  resolution: CanonicalScopeResolution,
  permissionKey: string
) {
  return (
    resolution.permissions.includes(permissionKey) ||
    resolution.permissions.includes("system.admin")
  );
}

export function hasCanonicalGlobalScope(resolution: CanonicalScopeResolution) {
  return (
    resolution.permissions.includes("system.admin") ||
    resolution.claims.some(
      (claim) =>
        claim.scopeType === "GLOBAL" &&
        (claim.scopeId === "platform" || claim.scopeId === "*")
    )
  );
}
