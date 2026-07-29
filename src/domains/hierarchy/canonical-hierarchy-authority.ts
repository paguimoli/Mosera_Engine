import { Pool } from "pg";

import type {
  Account,
  PersistedAccountStatus,
  PersistedAccountType,
} from "@/src/domains/accounts/account.types";

export type CanonicalPlatformHierarchy = {
  readonly platformId: string;
  readonly organizationId: string;
  readonly tenantId: string | null;
  readonly brandId: string | null;
  readonly marketId: string | null;
  readonly websiteId: string | null;
};

export type CanonicalAccountScope = {
  readonly platformId: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId: string;
};

export type CanonicalAccountHierarchyNode = {
  readonly accountId: string;
  readonly accountType: PersistedAccountType;
  readonly parentAccountId: string | null;
  readonly depth: number;
};

export type CanonicalAccountHierarchy = {
  readonly hierarchyAccountIds: readonly string[];
  readonly ancestors: readonly CanonicalAccountHierarchyNode[];
  readonly superMasterAccountId: string | null;
  readonly masterAgentAccountId: string | null;
  readonly agentAccountId: string | null;
};

export type CanonicalAccountPlacement = {
  readonly accountId?: string | null;
  readonly accountType: PersistedAccountType;
  readonly parentAccountId: string | null;
  readonly scope: CanonicalAccountScope;
  readonly status?: PersistedAccountStatus;
};

type PlatformHierarchyRow = {
  platform_id: string;
  organization_id: string;
  tenant_id: string | null;
  brand_id: string | null;
  market_id: string | null;
  website_id: string | null;
};

type AccountHierarchyRow = {
  id: string;
  account_type: PersistedAccountType;
  parent_account_id: string | null;
  canonical_tenant_id: string;
  canonical_brand_id: string;
  canonical_market_id: string;
  status: PersistedAccountStatus;
  depth: number;
};

let pool: Pool | null = null;

export class CanonicalHierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalHierarchyError";
  }
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new CanonicalHierarchyError(
      "Canonical hierarchy database is not configured."
    );
  }

  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 5_000,
  });
  return pool;
}

function mapPlatformHierarchy(
  row: PlatformHierarchyRow | undefined
): CanonicalPlatformHierarchy | null {
  if (!row) return null;
  return {
    platformId: row.platform_id,
    organizationId: row.organization_id,
    tenantId: row.tenant_id,
    brandId: row.brand_id,
    marketId: row.market_id,
    websiteId: row.website_id,
  };
}

export async function resolveOrganizationHierarchy(
  organizationId: string
): Promise<CanonicalPlatformHierarchy | null> {
  const result = await databasePool().query<PlatformHierarchyRow>(
    `select
       platform.id as platform_id,
       organization.id as organization_id,
       null::uuid as tenant_id,
       null::uuid as brand_id,
       null::uuid as market_id,
       null::uuid as website_id
     from platform.organizations organization
     join platform.platforms platform on platform.id = organization.platform_id
     where organization.id = $1
     limit 1`,
    [organizationId]
  );
  return mapPlatformHierarchy(result.rows[0]);
}

export async function resolveTenantHierarchy(
  tenantId: string
): Promise<CanonicalPlatformHierarchy | null> {
  const result = await databasePool().query<PlatformHierarchyRow>(
    `select
       platform.id as platform_id,
       organization.id as organization_id,
       tenant.id as tenant_id,
       null::uuid as brand_id,
       null::uuid as market_id,
       null::uuid as website_id
     from platform.tenants tenant
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.platforms platform on platform.id = organization.platform_id
     where tenant.id = $1
     limit 1`,
    [tenantId]
  );
  return mapPlatformHierarchy(result.rows[0]);
}

export async function resolveBrandHierarchy(
  brandId: string
): Promise<CanonicalPlatformHierarchy | null> {
  const result = await databasePool().query<PlatformHierarchyRow>(
    `select
       platform.id as platform_id,
       organization.id as organization_id,
       tenant.id as tenant_id,
       brand.id as brand_id,
       null::uuid as market_id,
       null::uuid as website_id
     from platform.brands brand
     join platform.tenants tenant on tenant.id = brand.tenant_id
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.platforms platform on platform.id = organization.platform_id
     where brand.id = $1
     limit 1`,
    [brandId]
  );
  return mapPlatformHierarchy(result.rows[0]);
}

export async function resolveMarketHierarchy(
  marketId: string,
  options: { readonly requireActive?: boolean } = {}
): Promise<CanonicalPlatformHierarchy | null> {
  const activeClause = options.requireActive
    ? `and market.status = 'Active'
       and brand.status = 'Active'
       and tenant.status = 'Active'
       and organization.status = 'Active'
       and platform.status = 'Active'`
    : "";
  const result = await databasePool().query<PlatformHierarchyRow>(
    `select
       platform.id as platform_id,
       organization.id as organization_id,
       tenant.id as tenant_id,
       brand.id as brand_id,
       market.id as market_id,
       null::uuid as website_id
     from platform.markets market
     join platform.brands brand on brand.id = market.brand_id
     join platform.tenants tenant on tenant.id = brand.tenant_id
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.platforms platform on platform.id = organization.platform_id
     where market.id = $1
     ${activeClause}
     limit 1`,
    [marketId]
  );
  return mapPlatformHierarchy(result.rows[0]);
}

export async function resolveWebsiteHierarchy(
  websiteId: string
): Promise<CanonicalPlatformHierarchy | null> {
  const result = await databasePool().query<PlatformHierarchyRow>(
    `select
       platform.id as platform_id,
       organization.id as organization_id,
       tenant.id as tenant_id,
       brand.id as brand_id,
       market.id as market_id,
       website.id as website_id
     from platform.websites website
     join platform.markets market
       on market.id = website.market_id
       and market.brand_id = website.brand_id
     join platform.brands brand
       on brand.id = website.brand_id
       and brand.tenant_id = website.tenant_id
     join platform.tenants tenant on tenant.id = website.tenant_id
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.platforms platform on platform.id = organization.platform_id
     where website.id = $1
     limit 1`,
    [websiteId]
  );
  return mapPlatformHierarchy(result.rows[0]);
}

export async function resolvePlatformHierarchy(
  identifiers: {
    readonly organizationId?: string | null;
    readonly tenantId?: string | null;
    readonly brandId?: string | null;
    readonly marketId?: string | null;
    readonly websiteId?: string | null;
  }
): Promise<CanonicalPlatformHierarchy | null> {
  const candidates = (
    await Promise.all([
      identifiers.organizationId
        ? resolveOrganizationHierarchy(identifiers.organizationId)
        : null,
      identifiers.tenantId
        ? resolveTenantHierarchy(identifiers.tenantId)
        : null,
      identifiers.brandId ? resolveBrandHierarchy(identifiers.brandId) : null,
      identifiers.marketId ? resolveMarketHierarchy(identifiers.marketId) : null,
      identifiers.websiteId
        ? resolveWebsiteHierarchy(identifiers.websiteId)
        : null,
    ])
  ).filter(
    (candidate): candidate is CanonicalPlatformHierarchy => candidate !== null
  );

  const suppliedCount = Object.values(identifiers).filter(Boolean).length;
  if (candidates.length !== suppliedCount) {
    return null;
  }
  if (candidates.length === 0) return null;

  const mostSpecific = candidates.reduce((left, right) => {
    const specificity = (value: CanonicalPlatformHierarchy) =>
      [
        value.organizationId,
        value.tenantId,
        value.brandId,
        value.marketId,
        value.websiteId,
      ].filter(Boolean).length;
    return specificity(right) > specificity(left) ? right : left;
  });
  const keys = [
    "platformId",
    "organizationId",
    "tenantId",
    "brandId",
    "marketId",
    "websiteId",
  ] as const;
  for (const candidate of candidates) {
    for (const key of keys) {
      if (
        candidate[key] &&
        mostSpecific[key] &&
        candidate[key] !== mostSpecific[key]
      ) {
        throw new CanonicalHierarchyError(
          "Platform hierarchy identifiers do not share one canonical ancestry."
        );
      }
    }
  }
  return mostSpecific;
}

export type CanonicalPlatformHierarchyResource =
  | "tenants"
  | "brands"
  | "markets"
  | "websites";

export async function validatePlatformActivationHierarchy(
  resource: CanonicalPlatformHierarchyResource,
  row: Record<string, unknown>
): Promise<void> {
  const checks: Record<
    CanonicalPlatformHierarchyResource,
    { readonly sql: string; readonly params: unknown[]; readonly message: string }
  > = {
    tenants: {
      sql: "select 1 from platform.organizations where id = $1 and status = 'Active' limit 1",
      params: [row.organization_id],
      message: "Tenant activation requires an Active Organization.",
    },
    brands: {
      sql: "select 1 from platform.tenants where id = $1 and status = 'Active' limit 1",
      params: [row.tenant_id],
      message: "Brand activation requires an Active Tenant.",
    },
    markets: {
      sql: "select 1 from platform.brands where id = $1 and status = 'Active' limit 1",
      params: [row.brand_id],
      message: "Market activation requires an Active Brand.",
    },
    websites: {
      sql: `select 1
            from platform.markets market
            join platform.brands brand on brand.id = market.brand_id
            join platform.tenants tenant on tenant.id = brand.tenant_id
            join platform.organizations organization on organization.id = tenant.organization_id
            join platform.platforms platform on platform.id = organization.platform_id
            where market.id = $1
              and market.brand_id = $2
              and brand.tenant_id = $3
              and market.status = 'Active'
              and brand.status = 'Active'
              and tenant.status = 'Active'
              and organization.status = 'Active'
              and platform.status = 'Active'
            limit 1`,
      params: [row.market_id, row.brand_id, row.tenant_id],
      message:
        "Website activation requires an Active Platform, Organization, Tenant, Brand, and Market.",
    },
  };
  const check = checks[resource];
  const result = await databasePool().query(check.sql, check.params);
  if (!result.rows[0]) {
    throw new CanonicalHierarchyError(check.message);
  }
}

export async function validatePlatformRetirementHierarchy(
  resource: "tenants" | "brands" | "websites",
  row: Record<string, unknown>
): Promise<void> {
  const checks = {
    tenants: {
      sql: `select 1
            from platform.tenants tenant_version
            join platform.brands brand on brand.tenant_id = tenant_version.id
            left join lateral (
              select to_status
              from platform.platform_lifecycle_events lifecycle
              where lifecycle.resource = 'brands'
                and lifecycle.record_id = brand.id
              order by lifecycle.created_at desc, lifecycle.event_id desc
              limit 1
            ) brand_lifecycle on true
            where tenant_version.organization_id = $1
              and tenant_version.tenant_code = $2
              and coalesce(brand_lifecycle.to_status, brand.status) = 'Active'
            limit 1`,
      params: [row.organization_id, row.tenant_code],
      message: "Tenant retirement requires retiring Active Brands first.",
    },
    brands: {
      sql: `select 1
            from platform.brands brand_version
            join platform.websites website on website.brand_id = brand_version.id
            left join lateral (
              select to_status
              from platform.platform_lifecycle_events lifecycle
              where lifecycle.resource = 'websites'
                and lifecycle.record_id = website.id
              order by lifecycle.created_at desc, lifecycle.event_id desc
              limit 1
            ) website_lifecycle on true
            where brand_version.tenant_id = $1
              and brand_version.brand_code = $2
              and coalesce(website_lifecycle.to_status, website.status) = 'Active'
            union all
            select 1
            from platform.brands brand_version
            join platform.markets market on market.brand_id = brand_version.id
            left join lateral (
              select to_status
              from platform.platform_lifecycle_events lifecycle
              where lifecycle.resource = 'markets'
                and lifecycle.record_id = market.id
              order by lifecycle.created_at desc, lifecycle.event_id desc
              limit 1
            ) market_lifecycle on true
            where brand_version.tenant_id = $1
              and brand_version.brand_code = $2
              and coalesce(market_lifecycle.to_status, market.status) = 'Active'
            limit 1`,
      params: [row.tenant_id, row.brand_code],
      message:
        "Brand retirement requires retiring Active Websites and Markets first.",
    },
    websites: {
      sql: `select 1
            from platform.websites website_version
            join platform.website_domains domain on domain.website_id = website_version.id
            left join lateral (
              select to_status
              from platform.platform_lifecycle_events lifecycle
              where lifecycle.resource = 'domains'
                and lifecycle.record_id = domain.id
              order by lifecycle.created_at desc, lifecycle.event_id desc
              limit 1
            ) domain_lifecycle on true
            where website_version.brand_id = $1
              and website_version.website_code = $2
              and coalesce(domain_lifecycle.to_status, domain.status) = 'Active'
            limit 1`,
      params: [row.brand_id, row.website_code],
      message: "Website retirement requires retiring Active Domains first.",
    },
  } as const;
  const check = checks[resource];
  const result = await databasePool().query(check.sql, [...check.params]);
  if (result.rows[0]) {
    throw new CanonicalHierarchyError(check.message);
  }
}

export async function resolveCanonicalMarketScope(
  marketId: string
): Promise<CanonicalAccountScope | null> {
  const hierarchy = await resolveMarketHierarchy(marketId, {
    requireActive: true,
  });
  if (
    !hierarchy?.tenantId ||
    !hierarchy.brandId ||
    !hierarchy.marketId
  ) {
    return null;
  }
  return {
    platformId: hierarchy.platformId,
    organizationId: hierarchy.organizationId,
    tenantId: hierarchy.tenantId,
    brandId: hierarchy.brandId,
    marketId: hierarchy.marketId,
  };
}

export async function resolveAccountAncestors(
  accountId: string
): Promise<CanonicalAccountHierarchy> {
  const result = await databasePool().query<AccountHierarchyRow>(
    `with recursive hierarchy as (
       select
         account.id,
         account.account_type,
         account.parent_account_id,
         account.canonical_tenant_id,
         account.canonical_brand_id,
         account.canonical_market_id,
         account.status,
         0 as depth,
         array[account.id] as visited
       from public.accounts account
       where account.id = $1
         and account.governance_managed
       union all
       select
         parent.id,
         parent.account_type,
         parent.parent_account_id,
         parent.canonical_tenant_id,
         parent.canonical_brand_id,
         parent.canonical_market_id,
         parent.status,
         hierarchy.depth + 1,
         hierarchy.visited || parent.id
       from public.accounts parent
       join hierarchy on hierarchy.parent_account_id = parent.id
       where parent.governance_managed
         and not parent.id = any(hierarchy.visited)
     )
     select
       id,
       account_type,
       parent_account_id,
       canonical_tenant_id,
       canonical_brand_id,
       canonical_market_id,
       status,
       depth
     from hierarchy
     order by depth asc`,
    [accountId]
  );
  const ancestors = result.rows.map((row) => ({
    accountId: row.id,
    accountType: row.account_type,
    parentAccountId: row.parent_account_id,
    depth: row.depth,
  }));
  return {
    hierarchyAccountIds: ancestors.map((node) => node.accountId),
    ancestors,
    superMasterAccountId:
      ancestors.find((node) => node.accountType === "SUPER_MASTER")?.accountId ??
      null,
    masterAgentAccountId:
      ancestors.find((node) => node.accountType === "MASTER_AGENT")?.accountId ??
      null,
    agentAccountId:
      ancestors.find((node) => node.accountType === "AGENT")?.accountId ?? null,
  };
}

export async function resolveAccountDescendants(
  accountId: string
): Promise<readonly CanonicalAccountHierarchyNode[]> {
  const result = await databasePool().query<AccountHierarchyRow>(
    `with recursive descendants as (
       select
         child.id,
         child.account_type,
         child.parent_account_id,
         child.canonical_tenant_id,
         child.canonical_brand_id,
         child.canonical_market_id,
         child.status,
         1 as depth,
         array[$1::uuid, child.id] as visited
       from public.accounts child
       where child.parent_account_id = $1
         and child.governance_managed
       union all
       select
         child.id,
         child.account_type,
         child.parent_account_id,
         child.canonical_tenant_id,
         child.canonical_brand_id,
         child.canonical_market_id,
         child.status,
         descendants.depth + 1,
         descendants.visited || child.id
       from public.accounts child
       join descendants on child.parent_account_id = descendants.id
       where child.governance_managed
         and not child.id = any(descendants.visited)
     )
     select
       id,
       account_type,
       parent_account_id,
       canonical_tenant_id,
       canonical_brand_id,
       canonical_market_id,
       status,
       depth
     from descendants
     order by depth asc, id asc`,
    [accountId]
  );
  return result.rows.map((row) => ({
    accountId: row.id,
    accountType: row.account_type,
    parentAccountId: row.parent_account_id,
    depth: row.depth,
  }));
}

function allowedParentTypes(
  accountType: PersistedAccountType
): readonly PersistedAccountType[] {
  switch (accountType) {
    case "MASTER_AGENT":
      return ["SUPER_MASTER", "MASTER_AGENT"];
    case "AGENT":
      return ["MASTER_AGENT"];
    case "PLAYER":
      return ["AGENT"];
    case "SUPER_MASTER":
      return [];
  }
}

async function loadPlacementAccount(accountId: string): Promise<Account | null> {
  const result = await databasePool().query<{
    id: string;
    account_type: PersistedAccountType;
    account_code: string;
    display_name: string;
    parent_account_id: string | null;
    platform_id: string;
    organization_id: string;
    canonical_tenant_id: string;
    canonical_brand_id: string;
    canonical_market_id: string;
    status: PersistedAccountStatus;
    governance_managed: true;
    created_at: string;
  }>(
    `select
       account.id,
       account.account_type,
       account.account_code,
       account.display_name,
       account.parent_account_id,
       platform.id as platform_id,
       organization.id as organization_id,
       account.canonical_tenant_id,
       account.canonical_brand_id,
       account.canonical_market_id,
       account.status,
       account.governance_managed,
       account.created_at
     from public.accounts account
     join platform.markets market on market.id = account.canonical_market_id
     join platform.brands brand on brand.id = account.canonical_brand_id
     join platform.tenants tenant on tenant.id = account.canonical_tenant_id
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.platforms platform on platform.id = organization.platform_id
     where account.id = $1
       and account.governance_managed
     limit 1`,
    [accountId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountType: row.account_type,
    accountCode: row.account_code,
    displayName: row.display_name,
    parentAccountId: row.parent_account_id,
    platformId: row.platform_id,
    organizationId: row.organization_id,
    tenantId: row.canonical_tenant_id,
    brandId: row.canonical_brand_id,
    marketId: row.canonical_market_id,
    status: row.status,
    governanceManaged: true,
    createdAt: row.created_at,
  };
}

export async function validateAccountPlacement(
  placement: CanonicalAccountPlacement
): Promise<void> {
  if (placement.accountType === "SUPER_MASTER") {
    if (placement.parentAccountId) {
      throw new CanonicalHierarchyError(
        "Super Master accounts cannot have a parent account."
      );
    }
  } else if (!placement.parentAccountId) {
    throw new CanonicalHierarchyError(
      `${placement.accountType} accounts require a parent account.`
    );
  }

  if (placement.parentAccountId) {
    if (placement.accountId === placement.parentAccountId) {
      throw new CanonicalHierarchyError("Account hierarchy cycle detected.");
    }
    const parent = await loadPlacementAccount(placement.parentAccountId);
    if (!parent) {
      throw new CanonicalHierarchyError("Parent account is not governed.");
    }
    if (parent.status !== "ACTIVE") {
      throw new CanonicalHierarchyError("Parent account must be active.");
    }
    if (!allowedParentTypes(placement.accountType).includes(parent.accountType)) {
      throw new CanonicalHierarchyError(
        `${placement.accountType} accounts cannot be assigned under ${parent.accountType} accounts.`
      );
    }
    if (
      parent.tenantId !== placement.scope.tenantId ||
      parent.brandId !== placement.scope.brandId ||
      parent.marketId !== placement.scope.marketId
    ) {
      throw new CanonicalHierarchyError(
        "Account hierarchy cannot cross canonical scope."
      );
    }
    if (placement.accountId) {
      const descendants = await resolveAccountDescendants(placement.accountId);
      if (
        descendants.some(
          (descendant) =>
            descendant.accountId === placement.parentAccountId
        )
      ) {
        throw new CanonicalHierarchyError("Account hierarchy cycle detected.");
      }
    }
  }

  if (placement.accountId) {
    const current = await loadPlacementAccount(placement.accountId);
    if (!current) {
      throw new CanonicalHierarchyError("Account not found.");
    }
    if (current.accountType !== placement.accountType) {
      const descendants = await resolveAccountDescendants(placement.accountId);
      if (descendants.length > 0) {
        throw new CanonicalHierarchyError(
          "Cannot change an account type while it has downline accounts."
        );
      }
    }
  }
}

export async function validateAccountMembership(
  ancestorAccountId: string,
  targetAccountId: string
): Promise<boolean> {
  if (ancestorAccountId === targetAccountId) return true;
  const hierarchy = await resolveAccountAncestors(targetAccountId);
  return hierarchy.hierarchyAccountIds.includes(ancestorAccountId);
}

export async function hierarchyAuthorityReadiness() {
  const result = await databasePool().query<{
    check_name: string;
    ready: boolean;
    issue_count: string | number;
  }>(
    `select 'platform:' || check_name as check_name, ready, issue_count
     from platform.canonical_hierarchy_readiness()
     union all
     select 'accounts:' || check_name, ready, issue_count
     from platform.account_scope_governance_readiness()
     order by check_name`
  );
  return result.rows.map((row) => ({
    checkName: row.check_name,
    ready: row.ready,
    issueCount: Number(row.issue_count),
  }));
}
