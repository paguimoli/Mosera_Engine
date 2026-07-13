import { randomUUID } from "node:crypto";

import * as collectionRoute from "../../app/api/platform-management/[resource]/route";
import * as runtimeContextRoute from "../../app/api/platform-management/runtime-context/route";
import { setPlatformManagementAuthOverrideForTesting } from "../../src/domains/platform-management/platform-management-auth";

type JsonObject = Record<string, unknown>;

const checks: { name: string; status: "PASS" | "FAIL"; metadata?: JsonObject }[] = [];

function addCheck(name: string, passed: boolean, metadata: JsonObject = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function collectionParams(resource: string) {
  return { params: Promise.resolve({ resource }) };
}

function apiRequest(url: string, method = "GET", body?: JsonObject, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: {
      accept: "application/json",
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readJson(response: Response) {
  return (await response.json()) as JsonObject;
}

function hash(label: string, runId: string) {
  return `sha256:runtime-brand-context:${label}:${runId}`;
}

function recordId(json: JsonObject, key: string) {
  const record = json[key] as JsonObject | undefined;
  if (typeof record?.id !== "string") {
    throw new Error(`Missing ${key}.id in ${JSON.stringify(json)}`);
  }

  return record.id;
}

async function create(resource: string, body: JsonObject) {
  const response = await collectionRoute.POST(
    apiRequest(`http://qa.local/api/platform-management/${resource}`, "POST", body),
    collectionParams(resource)
  );
  const json = await readJson(response);
  return { response, json };
}

async function runtimeContext(hostname: string, headers: Record<string, string> = {}) {
  const response = await runtimeContextRoute.GET(
    apiRequest(`http://qa.local/api/platform-management/runtime-context?hostname=${encodeURIComponent(hostname)}`, "GET", undefined, headers)
  );
  const json = await readJson(response);
  return { response, json };
}

async function runtimeContextFromHeader(hostname: string) {
  const response = await runtimeContextRoute.GET(
    apiRequest("http://qa.local/api/platform-management/runtime-context", "GET", undefined, { host: hostname })
  );
  const json = await readJson(response);
  return { response, json };
}

function context(json: JsonObject) {
  return json.context as JsonObject | undefined;
}

function gameSummary(ctx: JsonObject | undefined) {
  return ctx?.resolvedGameAvailabilitySummary as JsonObject | undefined;
}

function games(ctx: JsonObject | undefined) {
  const summary = gameSummary(ctx);
  return Array.isArray(summary?.games) ? (summary.games as JsonObject[]) : [];
}

function containsSensitiveFields(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveFields);
  }

  if (value && typeof value === "object") {
    return Object.entries(value as JsonObject).some(([key, entry]) => {
      const lowered = key.toLowerCase();
      return (
        lowered.includes("audit") ||
        lowered.includes("storage") ||
        lowered.includes("secret") ||
        lowered.includes("permission") ||
        containsSensitiveFields(entry)
      );
    });
  }

  return false;
}

async function createBaseHierarchy(runId: string, label: string, options: {
  readonly brandStatus?: string;
  readonly websiteStatus?: string;
  readonly websiteMaintenance?: boolean;
  readonly websiteHasMarket?: boolean;
  readonly domainStatus?: string;
  readonly canonicalHostname?: string;
  readonly aliasHostname?: string;
  readonly websiteLanguage?: string;
  readonly websiteCurrency?: string;
  readonly websiteTimezone?: string;
} = {}) {
  const organization = await create("organizations", {
    code: `${label}-org-${runId}`,
    name: `${label} Organization`,
    status: "Active",
    version: "1.0.0",
    contentHash: hash(`${label}:organization`, runId),
  });
  const organizationId = recordId(organization.json, "organization");

  const tenant = await create("tenants", {
    organizationId,
    code: `${label}-tenant-${runId}`,
    name: `${label} Tenant`,
    status: "Active",
    defaultLanguage: "en",
    defaultCurrency: "USD",
    defaultTimezone: "America/New_York",
    creditEnabled: true,
    cashierEnabled: false,
    version: "1.0.0",
    contentHash: hash(`${label}:tenant`, runId),
  });
  const tenantId = recordId(tenant.json, "tenant");

  const brand = await create("brands", {
    tenantId,
    code: `${label}-brand-${runId}`,
    name: `${label} Brand`,
    displayName: `${label} Brand`,
    status: options.brandStatus ?? "Active",
    version: "1.0.0",
    contentHash: hash(`${label}:brand`, runId),
  });
  const brandId = recordId(brand.json, "brand");

  let marketId: string | null = null;
  if (options.websiteHasMarket !== false) {
    const market = await create("markets", {
      brandId,
      code: `${label}-market-${runId}`,
      name: `${label} Market`,
      displayName: `${label} Market`,
      country: null,
      jurisdiction: null,
      language: "fr",
      currency: "EUR",
      timezone: "UTC",
      status: "Active",
      version: "1.0.0",
      contentHash: hash(`${label}:market`, runId),
    });
    marketId = recordId(market.json, "market");
  }

  const website = await create("websites", {
    tenantId,
    brandId,
    marketId,
    code: `${label}-site-${runId}`,
    displayName: `${label} Website`,
    status: options.websiteStatus ?? "Active",
    defaultLanguage: options.websiteLanguage ?? "es",
    defaultCurrency: options.websiteCurrency ?? "CRC",
    defaultTimezone: options.websiteTimezone ?? "America/Costa_Rica",
    maintenanceMode: options.websiteMaintenance ?? false,
    version: "1.0.0",
    contentHash: hash(`${label}:website`, runId),
  });
  const websiteId = recordId(website.json, "website");

  const canonicalHostname = options.canonicalHostname ?? `${label}-${runId}.example.test`;
  const canonicalDomain = await create("domains", {
    websiteId,
    hostname: canonicalHostname,
    canonical: true,
    status: options.domainStatus ?? "Active",
    verificationStatus: "Verified",
    tlsMode: { mode: "managed-placeholder" },
    cloudflareProxyMetadata: { proxied: true },
    version: "1.0.0",
    contentHash: hash(`${label}:domain`, runId),
  });

  let aliasHostname: string | null = null;
  if (options.aliasHostname) {
    aliasHostname = options.aliasHostname;
    await create("domains", {
      websiteId,
      hostname: aliasHostname,
      canonical: false,
      status: "Active",
      verificationStatus: "Verified",
      tlsMode: { mode: "managed-placeholder" },
      cloudflareProxyMetadata: { proxied: true },
      version: "1.0.0",
      contentHash: hash(`${label}:alias-domain`, runId),
    });
  }

  const theme = await create("themes", {
    tenantId,
    brandId,
    code: `${label}-theme-${runId}`,
    displayName: `${label} Theme`,
    status: "Active",
    isDefault: true,
    colorTokens: { primary: "#0055aa", accent: "#f7c948" },
    typographyTokens: { body: "Inter" },
    spacingRadiusTokens: { radius: 4 },
    componentTokenPlaceholders: { button: { radius: 4 } },
    modeSupport: ["light", "dark"],
    version: "1.0.0",
    contentHash: hash(`${label}:theme`, runId),
  });

  const asset = await create("brand-assets", {
    tenantId,
    brandId,
    assetType: "LOGO",
    assetKey: `${label}-logo-${runId}`,
    storageReference: { uri: `object://private/${runId}/${label}/logo.svg` },
    mimeType: "image/svg+xml",
    assetChecksumHash: hash(`${label}:asset-checksum`, runId),
    status: "Active",
    version: "1.0.0",
    contentHash: hash(`${label}:asset`, runId),
  });

  return {
    organizationId,
    tenantId,
    brandId,
    marketId,
    websiteId,
    canonicalHostname,
    aliasHostname,
    domainId: recordId(canonicalDomain.json, "domain"),
    themeId: recordId(theme.json, "theme"),
    assetId: recordId(asset.json, "asset"),
  };
}

async function main() {
  setPlatformManagementAuthOverrideForTesting(["system.admin"]);
  const runId = randomUUID();

  try {
    const base = await createBaseHierarchy(runId, "runtime", {
      aliasHostname: `runtime-alias-${runId}.example.test`,
    });

    const brandAvailability = await create("game-availability", {
      tenantId: base.tenantId,
      brandId: base.brandId,
      gameId: `game:${runId}:brand`,
      gameCode: `shared-game-${runId}`,
      status: "Active",
      version: "1.0.0",
      contentHash: hash("availability:brand", runId),
    });

    const websiteAvailability = await create("game-availability", {
      tenantId: base.tenantId,
      brandId: base.brandId,
      marketId: base.marketId,
      websiteId: base.websiteId,
      gameId: `game:${runId}:website`,
      gameCode: `shared-game-${runId}`,
      status: "Suspended",
      version: "1.0.0",
      contentHash: hash("availability:website", runId),
    });

    const canonical = await runtimeContext(`${base.canonicalHostname.toUpperCase()}:443`);
    const canonicalContext = context(canonical.json);
    addCheck(
      "canonical active hostname resolves",
      canonical.response.status === 200 &&
        canonicalContext?.hostname === base.canonicalHostname &&
        canonicalContext?.tenantId === base.tenantId &&
        canonicalContext?.brandId === base.brandId &&
        canonicalContext?.websiteId === base.websiteId,
      { status: canonical.response.status, body: canonical.json }
    );

    const alias = await runtimeContext(base.aliasHostname ?? "");
    const aliasContext = context(alias.json);
    addCheck(
      "non-canonical hostname returns redirect target",
      alias.response.status === 200 &&
        aliasContext?.canonicalRedirectRequired === true &&
        aliasContext?.canonicalHostname === base.canonicalHostname,
      { status: alias.response.status, body: alias.json }
    );

    const unknown = await runtimeContext(`unknown-${runId}.example.test`);
    addCheck("unknown hostname fails", unknown.response.status === 404 && unknown.json.success === false, {
      status: unknown.response.status,
      body: unknown.json,
    });

    const inactiveDomain = await createBaseHierarchy(runId, "inactive-domain", {
      domainStatus: "Suspended",
    });
    const inactiveDomainContext = await runtimeContext(inactiveDomain.canonicalHostname);
    addCheck(
      "inactive domain fails",
      inactiveDomainContext.response.status === 404 && inactiveDomainContext.json.success === false,
      { status: inactiveDomainContext.response.status, body: inactiveDomainContext.json }
    );

    const inactiveWebsite = await createBaseHierarchy(runId, "inactive-website", {
      websiteStatus: "Suspended",
    });
    const inactiveWebsiteContext = await runtimeContext(inactiveWebsite.canonicalHostname);
    addCheck(
      "inactive website fails",
      inactiveWebsiteContext.response.status === 404 && inactiveWebsiteContext.json.success === false,
      { status: inactiveWebsiteContext.response.status, body: inactiveWebsiteContext.json }
    );

    const inactiveParent = await createBaseHierarchy(runId, "inactive-parent", {
      brandStatus: "Suspended",
    });
    const inactiveParentContext = await runtimeContext(inactiveParent.canonicalHostname);
    addCheck(
      "inactive parent hierarchy fails",
      inactiveParentContext.response.status === 404 && inactiveParentContext.json.success === false,
      { status: inactiveParentContext.response.status, body: inactiveParentContext.json }
    );

    const noMarket = await createBaseHierarchy(runId, "no-market", {
      websiteHasMarket: false,
    });
    const noMarketContextResponse = await runtimeContext(noMarket.canonicalHostname);
    const noMarketContext = context(noMarketContextResponse.json);
    addCheck(
      "website without market resolves",
      noMarketContextResponse.response.status === 200 && noMarketContext?.marketId === null,
      { status: noMarketContextResponse.response.status, body: noMarketContextResponse.json }
    );
    addCheck(
      "jurisdiction omitted resolves",
      noMarketContextResponse.response.status === 200 && noMarketContext?.tenantId === noMarket.tenantId,
      { context: noMarketContext ?? {} }
    );

    addCheck(
      "locale/currency/timezone precedence works",
      canonicalContext?.defaultLanguage === "es" &&
        canonicalContext?.defaultCurrency === "CRC" &&
        canonicalContext?.defaultTimezone === "America/Costa_Rica",
      { context: canonicalContext ?? {} }
    );

    const maintenance = await createBaseHierarchy(runId, "maintenance", {
      websiteMaintenance: true,
    });
    await create("game-availability", {
      tenantId: maintenance.tenantId,
      brandId: maintenance.brandId,
      websiteId: maintenance.websiteId,
      gameId: `game:${runId}:maintenance`,
      gameCode: `maintenance-game-${runId}`,
      status: "Active",
      version: "1.0.0",
      contentHash: hash("availability:maintenance", runId),
    });
    const maintenanceResponse = await runtimeContext(maintenance.canonicalHostname);
    const maintenanceContext = context(maintenanceResponse.json);
    addCheck(
      "maintenance mode is reported",
      maintenanceResponse.response.status === 200 &&
        maintenanceContext?.maintenanceMode === true &&
        gameSummary(maintenanceContext)?.publiclyPlayableCount === 0,
      { status: maintenanceResponse.response.status, body: maintenanceResponse.json }
    );

    addCheck(
      "theme resolves",
      (canonicalContext?.activeThemeReference as JsonObject | undefined)?.themeId === base.themeId &&
        Boolean((canonicalContext?.activeThemeTokens as JsonObject | undefined)?.colorTokens),
      { context: canonicalContext ?? {} }
    );

    const assetReferences = Array.isArray(canonicalContext?.brandAssetReferences)
      ? (canonicalContext?.brandAssetReferences as JsonObject[])
      : [];
    addCheck(
      "asset references resolve",
      assetReferences.some((asset) => asset.assetId === base.assetId && asset.assetType === "LOGO"),
      { assetReferences }
    );

    const resolvedGames = games(canonicalContext);
    addCheck(
      "game availability precedence works",
      resolvedGames.some(
        (game) =>
          game.availabilityId === recordId(websiteAvailability.json, "availability") &&
          game.gameCode === `shared-game-${runId}` &&
          game.specificityRank === 4
      ),
      { games: resolvedGames, brandAvailability: brandAvailability.json, websiteAvailability: websiteAvailability.json }
    );
    addCheck(
      "suspended specific scope disables inherited game",
      resolvedGames.some(
        (game) =>
          game.availabilityId === recordId(websiteAvailability.json, "availability") &&
          game.isAvailable === false &&
          game.publiclyPlayable === false
      ),
      { games: resolvedGames }
    );

    const malformed = await runtimeContext("bad host.example.test");
    addCheck("malformed Host header rejected", malformed.response.status === 400 && malformed.json.success === false, {
      status: malformed.response.status,
      body: malformed.json,
    });

    const headerContext = await runtimeContextFromHeader(`${base.canonicalHostname}:3000`);
    addCheck(
      "Host header normalizes safely",
      headerContext.response.status === 200 && context(headerContext.json)?.hostname === base.canonicalHostname,
      { status: headerContext.response.status, body: headerContext.json }
    );

    const other = await createBaseHierarchy(runId, "other-tenant");
    const crossTenantWebsite = await create("websites", {
      tenantId: other.tenantId,
      brandId: base.brandId,
      code: `cross-tenant-site-${runId}`,
      displayName: "Cross Tenant Website",
      status: "Active",
      defaultLanguage: "en",
      defaultCurrency: "USD",
      defaultTimezone: "UTC",
      version: "1.0.0",
      contentHash: hash("cross-tenant-website", runId),
    });
    addCheck(
      "cross-tenant inconsistency rejected",
      crossTenantWebsite.response.status === 400 && crossTenantWebsite.json.success === false,
      { status: crossTenantWebsite.response.status, body: crossTenantWebsite.json }
    );

    addCheck("no sensitive fields exposed", canonical.response.status === 200 && !containsSensitiveFields(canonical.json), {
      body: canonical.json,
    });
  } finally {
    setPlatformManagementAuthOverrideForTesting(null);
  }

  const failed = checks.filter((check) => check.status !== "PASS");
  const report = {
    status: failed.length === 0 ? "PASS" : "FAIL",
    checkCount: checks.length,
    failedCount: failed.length,
    checks,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  setPlatformManagementAuthOverrideForTesting(null);
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
