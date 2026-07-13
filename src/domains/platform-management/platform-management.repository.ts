import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

export class PlatformManagementDatabaseUnavailableError extends Error {
  constructor() {
    super("Platform management database is not configured.");
    this.name = "PlatformManagementDatabaseUnavailableError";
  }
}

export class PlatformManagementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformManagementValidationError";
  }
}

export class PlatformManagementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformManagementConflictError";
  }
}

export type PlatformLifecycleAction = "activate" | "suspend" | "retire" | "supersede" | "cancel";

export type PlatformLifecycleStatus =
  | "Draft"
  | "Active"
  | "Suspended"
  | "Retired"
  | "Superseded"
  | "Cancelled";

export type PlatformResourceName =
  | "organizations"
  | "tenants"
  | "brands"
  | "markets"
  | "websites"
  | "domains"
  | "themes"
  | "brand-assets"
  | "game-availability";

type JsonValue = Record<string, unknown> | readonly unknown[];

type FieldDefinition = {
  readonly input: readonly string[];
  readonly column: string;
  readonly required?: boolean;
  readonly defaultValue?: unknown;
  readonly kind?: "string" | "boolean" | "json" | "number" | "timestamp";
  readonly normalize?: "lower";
};

type ResourceDefinition = {
  readonly table: string;
  readonly responseKey: string;
  readonly fields: readonly FieldDefinition[];
  readonly filters: readonly string[];
};

export type PlatformResourceScopeSnapshot = {
  readonly organizationId?: string | null;
  readonly tenantId?: string | null;
  readonly brandId?: string | null;
  readonly marketId?: string | null;
  readonly websiteId?: string | null;
};

export type RuntimeBrandContext = {
  readonly hostname: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId: string | null;
  readonly websiteId: string;
  readonly canonicalHostname: string | null;
  readonly canonicalRedirectRequired: boolean;
  readonly defaultLanguage: string;
  readonly defaultCurrency: string;
  readonly defaultTimezone: string;
  readonly maintenanceMode: boolean;
  readonly activeThemeReference: Record<string, unknown> | null;
  readonly activeThemeTokens: Record<string, unknown> | null;
  readonly brandAssetReferences: readonly Record<string, unknown>[];
  readonly resolvedGameAvailabilitySummary: Record<string, unknown>;
  readonly resolutionTimestamp: string;
  readonly contentVersionReferences: Record<string, unknown>;
};

const lifecycleDefault = "Draft";
const auditDefault = { createdBy: "platform-management-api", source: "internal-api" };

const resources: Record<PlatformResourceName, ResourceDefinition> = {
  organizations: {
    table: "platform.organizations",
    responseKey: "organization",
    filters: ["organization_code", "status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["code", "organizationCode", "organization_code"], "organization_code", {
        required: true,
        normalize: "lower",
      }),
      field(["name"], "name", { required: true }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["governanceMetadata", "governance_metadata"], "governance_metadata", {
        defaultValue: {},
        kind: "json",
      }),
      field(["globalDefaults", "global_defaults"], "global_defaults", {
        defaultValue: {},
        kind: "json",
      }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  tenants: {
    table: "platform.tenants",
    responseKey: "tenant",
    filters: ["organization_id", "tenant_code", "status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["organizationId", "organization_id"], "organization_id", { required: true }),
      field(["code", "tenantCode", "tenant_code"], "tenant_code", {
        required: true,
        normalize: "lower",
      }),
      field(["name"], "name", { required: true }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["operatorMetadata", "operator_metadata"], "operator_metadata", {
        defaultValue: {},
        kind: "json",
      }),
      field(["defaultLanguage", "default_language"], "default_language", { defaultValue: "en" }),
      field(["defaultCurrency", "default_currency"], "default_currency", { defaultValue: "USD" }),
      field(["defaultTimezone", "default_timezone"], "default_timezone", {
        defaultValue: "UTC",
      }),
      field(["creditEnabled", "credit_enabled"], "credit_enabled", {
        defaultValue: true,
        kind: "boolean",
      }),
      field(["cashierEnabled", "cashier_enabled"], "cashier_enabled", {
        defaultValue: false,
        kind: "boolean",
      }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  brands: {
    table: "platform.brands",
    responseKey: "brand",
    filters: ["tenant_id", "brand_code", "status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["tenantId", "tenant_id"], "tenant_id", { required: true }),
      field(["code", "brandCode", "brand_code"], "brand_code", {
        required: true,
        normalize: "lower",
      }),
      field(["name"], "name", { required: true }),
      field(["displayName", "display_name"], "display_name", { required: true }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["futureThemeReference", "themeReferencePlaceholder"], "theme_reference_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["futureAssetReference", "assetReferencePlaceholder"], "asset_reference_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["futureWebsiteReferences", "websiteReferencePlaceholder"], "website_reference_placeholder", {
        defaultValue: [],
        kind: "json",
      }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  markets: {
    table: "platform.markets",
    responseKey: "market",
    filters: ["brand_id", "market_code", "status", "country", "jurisdiction", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["brandId", "brand_id"], "brand_id", { required: true }),
      field(["code", "marketCode", "market_code"], "market_code", {
        required: true,
        normalize: "lower",
      }),
      field(["name"], "name", { required: true }),
      field(["displayName", "display_name"], "display_name", { required: true }),
      field(["country"], "country"),
      field(["jurisdiction"], "jurisdiction"),
      field(["language"], "language", { defaultValue: "en" }),
      field(["currency"], "currency", { defaultValue: "USD" }),
      field(["timezone"], "timezone", { defaultValue: "UTC" }),
      field(["futureGameAvailability", "future_game_availability_placeholder"], "future_game_availability_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  websites: {
    table: "platform.websites",
    responseKey: "website",
    filters: ["tenant_id", "brand_id", "market_id", "website_code", "status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["tenantId", "tenant_id"], "tenant_id", { required: true }),
      field(["brandId", "brand_id"], "brand_id", { required: true }),
      field(["marketId", "market_id"], "market_id"),
      field(["code", "websiteCode", "website_code"], "website_code", {
        required: true,
        normalize: "lower",
      }),
      field(["displayName", "display_name"], "display_name", { required: true }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["defaultLanguage", "default_language"], "default_language", { defaultValue: "en" }),
      field(["defaultCurrency", "default_currency"], "default_currency", { defaultValue: "USD" }),
      field(["defaultTimezone", "default_timezone"], "default_timezone", {
        defaultValue: "UTC",
      }),
      field(["maintenanceMode", "maintenance_mode"], "maintenance_mode", {
        defaultValue: false,
        kind: "boolean",
      }),
      field(["futureThemeReference", "future_theme_reference_placeholder"], "future_theme_reference_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["futureHomepageConfig", "future_homepage_config_placeholder"], "future_homepage_config_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  domains: {
    table: "platform.website_domains",
    responseKey: "domain",
    filters: ["website_id", "hostname", "canonical", "status", "verification_status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["websiteId", "website_id"], "website_id", { required: true }),
      field(["hostname"], "hostname", { required: true, normalize: "lower" }),
      field(["canonical"], "canonical", { defaultValue: false, kind: "boolean" }),
      field(["status"], "status", { defaultValue: "PendingVerification" }),
      field(["verificationStatus", "verification_status"], "verification_status", {
        defaultValue: "Pending",
      }),
      field(["tlsMode", "tls_mode_placeholder"], "tls_mode_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["cloudflareProxyMetadata", "cloudflare_proxy_metadata_placeholder"], "cloudflare_proxy_metadata_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["effectiveFrom", "effective_from"], "effective_from", { defaultValue: () => new Date().toISOString() }),
      field(["effectiveTo", "effective_to"], "effective_to"),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: false }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  themes: {
    table: "platform.brand_themes",
    responseKey: "theme",
    filters: ["tenant_id", "brand_id", "theme_code", "status", "is_default", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["tenantId", "tenant_id"], "tenant_id", { required: true }),
      field(["brandId", "brand_id"], "brand_id", { required: true }),
      field(["code", "themeCode", "theme_code"], "theme_code", {
        required: true,
        normalize: "lower",
      }),
      field(["displayName", "display_name"], "display_name", { required: true }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["isDefault", "is_default"], "is_default", { defaultValue: false, kind: "boolean" }),
      field(["colorTokens", "color_tokens"], "color_tokens", { defaultValue: {}, kind: "json" }),
      field(["typographyTokens", "typography_tokens"], "typography_tokens", {
        defaultValue: {},
        kind: "json",
      }),
      field(["spacingRadiusTokens", "spacing_radius_tokens"], "spacing_radius_tokens", {
        defaultValue: {},
        kind: "json",
      }),
      field(["componentTokenPlaceholders", "component_token_placeholders"], "component_token_placeholders", {
        defaultValue: {},
        kind: "json",
      }),
      field(["modeSupport", "mode_support"], "mode_support", {
        defaultValue: ["light"],
        kind: "json",
      }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  "brand-assets": {
    table: "platform.brand_assets",
    responseKey: "asset",
    filters: ["tenant_id", "brand_id", "asset_type", "asset_key", "status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["tenantId", "tenant_id"], "tenant_id", { required: true }),
      field(["brandId", "brand_id"], "brand_id", { required: true }),
      field(["assetType", "asset_type"], "asset_type", { required: true }),
      field(["assetKey", "asset_key"], "asset_key", {
        required: true,
        normalize: "lower",
      }),
      field(["storageReference", "storageReferencePlaceholder", "storage_reference_placeholder"], "storage_reference_placeholder", {
        defaultValue: {},
        kind: "json",
      }),
      field(["mimeType", "mime_type"], "mime_type", { required: true }),
      field(["assetChecksumHash", "asset_checksum_hash"], "asset_checksum_hash", {
        required: true,
      }),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: true }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
  "game-availability": {
    table: "platform.game_availability",
    responseKey: "availability",
    filters: ["tenant_id", "brand_id", "market_id", "website_id", "agent_id", "game_code", "status", "version", "content_hash"],
    fields: [
      field(["id"], "id", { defaultValue: () => randomUUID() }),
      field(["tenantId", "tenant_id"], "tenant_id", { required: true }),
      field(["brandId", "brand_id"], "brand_id", { required: true }),
      field(["marketId", "market_id"], "market_id"),
      field(["websiteId", "website_id"], "website_id"),
      field(["agentId", "agent_id"], "agent_id", { normalize: "lower" }),
      field(["gameId", "game_id"], "game_id", { required: true }),
      field(["gameCode", "game_code"], "game_code", { required: true, normalize: "lower" }),
      field(["gameManifestReference", "game_manifest_reference"], "game_manifest_reference"),
      field(["jurisdiction"], "jurisdiction"),
      field(["status"], "status", { defaultValue: lifecycleDefault }),
      field(["effectiveFrom", "effective_from"], "effective_from", { defaultValue: () => new Date().toISOString() }),
      field(["effectiveTo", "effective_to"], "effective_to"),
      field(["minWagerOverride", "min_wager_override"], "min_wager_override", { kind: "number" }),
      field(["maxWagerOverride", "max_wager_override"], "max_wager_override", { kind: "number" }),
      field(["languageOverride", "language_override"], "language_override"),
      field(["currencyOverride", "currency_override"], "currency_override"),
      field(["timezoneOverride", "timezone_override"], "timezone_override"),
      field(["version"], "version", { defaultValue: "1.0.0" }),
      ...platformLifecycleFields({ effectiveDating: false }),
      field(["contentHash", "content_hash"], "content_hash"),
      field(["auditMetadata", "audit_metadata"], "audit_metadata", {
        defaultValue: auditDefault,
        kind: "json",
      }),
    ],
  },
};

let pool: Pool | null = null;

function field(
  input: readonly string[],
  column: string,
  options: Omit<FieldDefinition, "input" | "column"> = {}
): FieldDefinition {
  return { input, column, ...options };
}

function platformLifecycleFields(options: { readonly effectiveDating: boolean }) {
  const fields = [
    field(["previousVersion", "previous_version"], "previous_version"),
    field(["supersedesVersion", "supersedes_version"], "supersedes_version"),
    field(["lifecycleReason", "lifecycle_reason"], "lifecycle_reason"),
    field(["lifecycleOperator", "lifecycle_operator"], "lifecycle_operator"),
    field(["approvalMetadata", "approval_metadata"], "approval_metadata", {
      defaultValue: {},
      kind: "json",
    }),
  ];

  if (!options.effectiveDating) {
    return fields;
  }

  return [
    field(["effectiveFrom", "effective_from"], "effective_from", {
      defaultValue: () => new Date().toISOString(),
    }),
    field(["effectiveTo", "effective_to"], "effective_to"),
    ...fields,
  ];
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new PlatformManagementDatabaseUnavailableError();
  }

  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 5_000,
  });

  return pool;
}

function valueFromInput(input: Record<string, unknown>, definition: FieldDefinition) {
  for (const key of definition.input) {
    if (Object.hasOwn(input, key)) {
      return input[key];
    }
  }

  if (typeof definition.defaultValue === "function") {
    return definition.defaultValue();
  }

  return definition.defaultValue;
}

function normalizeValue(value: unknown, definition: FieldDefinition) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (definition.kind === "boolean") {
    return Boolean(value);
  }

  if (definition.kind === "json") {
    return JSON.stringify((value ?? {}) as JsonValue);
  }

  if (definition.kind === "number") {
    return Number(value);
  }

  if (definition.normalize === "lower" && typeof value === "string") {
    return value.trim().toLowerCase();
  }

  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function contentHashFor(resource: PlatformResourceName, values: Record<string, unknown>) {
  const hash = createHash("sha256")
    .update(stableStringify({ resource, values }))
    .digest("hex");
  return `sha256:${hash}`;
}

function buildInsert(resource: PlatformResourceName, input: Record<string, unknown>) {
  const definition = resources[resource];
  const values: Record<string, unknown> = {};
  const columns: string[] = [];
  const params: unknown[] = [];

  for (const fieldDefinition of definition.fields) {
    let value = valueFromInput(input, fieldDefinition);
    if (fieldDefinition.column === "content_hash" && value === undefined) {
      value = contentHashFor(resource, values);
    }

    const normalized = normalizeValue(value, fieldDefinition);
    if (fieldDefinition.required && (normalized === undefined || normalized === null || normalized === "")) {
      throw new PlatformManagementValidationError(`${fieldDefinition.column} is required.`);
    }

    if (normalized !== undefined) {
      columns.push(fieldDefinition.column);
      params.push(normalized);
      values[fieldDefinition.column] = normalized;
    }
  }

  return {
    sql: `insert into ${definition.table} (${columns.join(", ")}) values (${params
      .map((_, index) => `$${index + 1}`)
      .join(", ")}) returning *`,
    params,
  };
}

function mapError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    const message = "message" in error ? String(error.message) : "Platform management operation failed.";

    if (code === "23505") {
      throw new PlatformManagementConflictError(message);
    }

    if (code === "23503" || code === "23514" || code === "P0001" || code === "22P02") {
      throw new PlatformManagementValidationError(message);
    }
  }

  throw error;
}

function camelizeKey(key: string) {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeValue(entry)])
    );
  }
  return value;
}

function timestampValue(value: unknown, fallback: string) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return fallback;
}

function dbValue(row: QueryResultRow, camelKey: string, snakeKey?: string) {
  const key = snakeKey ?? camelKey.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return row[key];
}

function mapRow(row: QueryResultRow) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camelizeKey(key), serializeValue(value)])
  );
}

function stringValue(input: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

async function scopeFromTenantId(tenantId: string) {
  const result = await databasePool().query(
    "select id, organization_id from platform.tenants where id = $1 limit 1",
    [tenantId]
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    organizationId: String(result.rows[0].organization_id),
    tenantId: String(result.rows[0].id),
  };
}

async function scopeFromBrandId(brandId: string) {
  const result = await databasePool().query(
    `select b.id, b.tenant_id, t.organization_id
     from platform.brands b
     join platform.tenants t on t.id = b.tenant_id
     where b.id = $1
     limit 1`,
    [brandId]
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    organizationId: String(result.rows[0].organization_id),
    tenantId: String(result.rows[0].tenant_id),
    brandId: String(result.rows[0].id),
  };
}

async function scopeFromMarketId(marketId: string) {
  const result = await databasePool().query(
    `select m.id, m.brand_id, b.tenant_id, t.organization_id
     from platform.markets m
     join platform.brands b on b.id = m.brand_id
     join platform.tenants t on t.id = b.tenant_id
     where m.id = $1
     limit 1`,
    [marketId]
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    organizationId: String(result.rows[0].organization_id),
    tenantId: String(result.rows[0].tenant_id),
    brandId: String(result.rows[0].brand_id),
    marketId: String(result.rows[0].id),
  };
}

async function scopeFromWebsiteId(websiteId: string) {
  const result = await databasePool().query(
    `select w.id, w.tenant_id, w.brand_id, w.market_id, t.organization_id
     from platform.websites w
     join platform.tenants t on t.id = w.tenant_id
     where w.id = $1
     limit 1`,
    [websiteId]
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    organizationId: String(result.rows[0].organization_id),
    tenantId: String(result.rows[0].tenant_id),
    brandId: String(result.rows[0].brand_id),
    marketId: result.rows[0].market_id ? String(result.rows[0].market_id) : null,
    websiteId: String(result.rows[0].id),
  };
}

function mergeScope(
  left: PlatformResourceScopeSnapshot | null,
  right: PlatformResourceScopeSnapshot | null
): PlatformResourceScopeSnapshot | null {
  if (!left) return right;
  if (!right) return left;

  return {
    organizationId: right.organizationId ?? left.organizationId ?? null,
    tenantId: right.tenantId ?? left.tenantId ?? null,
    brandId: right.brandId ?? left.brandId ?? null,
    marketId: right.marketId ?? left.marketId ?? null,
    websiteId: right.websiteId ?? left.websiteId ?? null,
  };
}

async function scopeFromRecordIdentifiers(input: Record<string, unknown>) {
  let scope: PlatformResourceScopeSnapshot | null = null;

  const tenantId = stringValue(input, "tenantId", "tenant_id");
  if (tenantId) {
    scope = mergeScope(scope, await scopeFromTenantId(tenantId));
  }

  const brandId = stringValue(input, "brandId", "brand_id");
  if (brandId) {
    scope = mergeScope(scope, await scopeFromBrandId(brandId));
  }

  const marketId = stringValue(input, "marketId", "market_id");
  if (marketId) {
    scope = mergeScope(scope, await scopeFromMarketId(marketId));
  }

  const websiteId = stringValue(input, "websiteId", "website_id");
  if (websiteId) {
    scope = mergeScope(scope, await scopeFromWebsiteId(websiteId));
  }

  return scope;
}

function resourceDefinition(resource: string): ResourceDefinition {
  if (resource in resources) {
    return resources[resource as PlatformResourceName];
  }

  throw new PlatformManagementValidationError(`Unknown platform management resource '${resource}'.`);
}

function filterColumn(definition: ResourceDefinition, key: string) {
  if (key === "id") {
    return "id";
  }

  const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return definition.filters.find((column) => column === key || column === snakeKey);
}

export function platformResourceResponseKey(resource: PlatformResourceName) {
  return resources[resource].responseKey;
}

export function isPlatformResourceName(resource: string): resource is PlatformResourceName {
  return resource in resources;
}

export async function createPlatformRecord(resource: PlatformResourceName, input: Record<string, unknown>) {
  const { sql, params } = buildInsert(resource, input);

  try {
    const result = await databasePool().query(sql, params);
    return mapRow(result.rows[0]);
  } catch (error) {
    mapError(error);
  }
}

export async function listPlatformRecords(resource: PlatformResourceName, filters: URLSearchParams) {
  const definition = resourceDefinition(resource);
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of filters.entries()) {
    if (key === "limit") continue;
    const column = filterColumn(definition, key);
    if (!column || value === "") continue;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  }

  const limit = Math.min(Math.max(Number(filters.get("limit") ?? 100), 1), 500);
  params.push(limit);

  const result = await databasePool().query(
    `select * from ${definition.table}${clauses.length ? ` where ${clauses.join(" and ")}` : ""}
     order by created_at asc, id asc
     limit $${params.length}`,
    params
  );

  return result.rows.map(mapRow);
}

export async function getPlatformRecord(resource: PlatformResourceName, id: string) {
  const definition = resourceDefinition(resource);
  const result = await databasePool().query(`select * from ${definition.table} where id = $1 limit 1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function resolvePlatformResourceScope(
  resource: PlatformResourceName,
  input: Record<string, unknown>
): Promise<PlatformResourceScopeSnapshot | null> {
  const id = stringValue(input, "id");

  if (resource === "organizations") {
    return {
      organizationId: id ?? stringValue(input, "organizationId", "organization_id"),
    };
  }

  if (resource === "tenants") {
    if (id) {
      return scopeFromTenantId(id);
    }

    return {
      organizationId: stringValue(input, "organizationId", "organization_id"),
    };
  }

  if (resource === "brands") {
    if (id) {
      return scopeFromBrandId(id);
    }

    return scopeFromRecordIdentifiers(input);
  }

  if (resource === "markets") {
    if (id) {
      return scopeFromMarketId(id);
    }

    return scopeFromRecordIdentifiers(input);
  }

  if (resource === "websites") {
    if (id) {
      return scopeFromWebsiteId(id);
    }

    return scopeFromRecordIdentifiers(input);
  }

  if (resource === "domains") {
    if (id) {
      const result = await databasePool().query(
        "select website_id from platform.website_domains where id = $1 limit 1",
        [id]
      );
      const websiteId = result.rows[0]?.website_id ? String(result.rows[0].website_id) : null;
      return websiteId ? scopeFromWebsiteId(websiteId) : null;
    }

    return scopeFromRecordIdentifiers(input);
  }

  if (resource === "themes") {
    if (id) {
      const result = await databasePool().query(
        "select tenant_id, brand_id from platform.brand_themes where id = $1 limit 1",
        [id]
      );
      return result.rows[0]
        ? scopeFromRecordIdentifiers({
            tenantId: result.rows[0].tenant_id,
            brandId: result.rows[0].brand_id,
          })
        : null;
    }

    return scopeFromRecordIdentifiers(input);
  }

  if (resource === "brand-assets") {
    if (id) {
      const result = await databasePool().query(
        "select tenant_id, brand_id from platform.brand_assets where id = $1 limit 1",
        [id]
      );
      return result.rows[0]
        ? scopeFromRecordIdentifiers({
            tenantId: result.rows[0].tenant_id,
            brandId: result.rows[0].brand_id,
          })
        : null;
    }

    return scopeFromRecordIdentifiers(input);
  }

  if (resource === "game-availability") {
    if (id) {
      const result = await databasePool().query(
        "select tenant_id, brand_id, market_id, website_id from platform.game_availability where id = $1 limit 1",
        [id]
      );
      return result.rows[0]
        ? scopeFromRecordIdentifiers({
            tenantId: result.rows[0].tenant_id,
            brandId: result.rows[0].brand_id,
            marketId: result.rows[0].market_id,
            websiteId: result.rows[0].website_id,
          })
        : null;
    }

    return scopeFromRecordIdentifiers(input);
  }

  return null;
}

export async function resolvePlatformHost(hostname: string) {
  if (!hostname.trim()) {
    throw new PlatformManagementValidationError("hostname is required.");
  }

  const result = await databasePool().query(
    `select *
     from platform.active_host_resolutions
     where hostname = lower(btrim($1))
     limit 1`,
    [hostname]
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function resolvePlatformGameAvailability(input: {
  readonly tenantId: string;
  readonly brandId: string;
  readonly marketId?: string | null;
  readonly websiteId?: string | null;
  readonly agentId?: string | null;
  readonly asOf?: string | null;
}) {
  if (!input.tenantId || !input.brandId) {
    throw new PlatformManagementValidationError("tenantId and brandId are required.");
  }

  const result = await databasePool().query(
    `select *
     from platform.resolve_game_availability($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
     order by game_code asc`,
    [
      input.tenantId,
      input.brandId,
      input.marketId ?? null,
      input.websiteId ?? null,
      input.agentId ?? null,
      input.asOf ?? null,
    ]
  );

  return result.rows.map(mapRow);
}

export function normalizeRuntimeHostname(input: string) {
  const rawHostname = input.trim().toLowerCase();
  if (!rawHostname) {
    throw new PlatformManagementValidationError("hostname is required.");
  }

  if (
    rawHostname.includes("://") ||
    rawHostname.includes("/") ||
    rawHostname.includes("\\") ||
    rawHostname.includes("@") ||
    /\s/.test(rawHostname) ||
    rawHostname.startsWith("[") ||
    rawHostname.includes(",")
  ) {
    throw new PlatformManagementValidationError("hostname is malformed.");
  }

  const withoutTrailingDot = rawHostname.endsWith(".") ? rawHostname.slice(0, -1) : rawHostname;
  const colonCount = (withoutTrailingDot.match(/:/g) ?? []).length;
  let hostname = withoutTrailingDot;

  if (colonCount === 1) {
    const [hostPart, portPart] = withoutTrailingDot.split(":");
    if (!/^\d{1,5}$/.test(portPart ?? "")) {
      throw new PlatformManagementValidationError("hostname port is malformed.");
    }

    const port = Number(portPart);
    if (port < 1 || port > 65535) {
      throw new PlatformManagementValidationError("hostname port is out of range.");
    }

    hostname = hostPart ?? "";
  } else if (colonCount > 1) {
    throw new PlatformManagementValidationError("hostname is malformed.");
  }

  if (
    hostname !== "localhost" &&
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(
      hostname
    )
  ) {
    throw new PlatformManagementValidationError("hostname is malformed.");
  }

  return hostname;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveActiveDefaultTheme(tenantId: string, brandId: string) {
  const result = await databasePool().query(
    `select theme.*
     from platform.brand_themes theme
     left join lateral (
       select lifecycle.to_status
       from platform.platform_lifecycle_events lifecycle
       where lifecycle.resource = 'themes'
         and lifecycle.record_id = theme.id
       order by lifecycle.created_at desc, lifecycle.event_id desc
       limit 1
     ) lifecycle on true
     where theme.tenant_id = $1
       and theme.brand_id = $2
       and theme.is_default = true
       and coalesce(lifecycle.to_status, theme.status) = 'Active'
       and theme.effective_from <= now()
       and (theme.effective_to is null or theme.effective_to > now())
     order by theme.effective_from desc, theme.created_at desc, theme.id desc
     limit 1`,
    [tenantId, brandId]
  );

  return result.rows[0] ?? null;
}

async function resolveActiveBrandAssets(tenantId: string, brandId: string) {
  const result = await databasePool().query(
    `select asset.*
     from platform.brand_assets asset
     left join lateral (
       select lifecycle.to_status
       from platform.platform_lifecycle_events lifecycle
       where lifecycle.resource = 'brand-assets'
         and lifecycle.record_id = asset.id
       order by lifecycle.created_at desc, lifecycle.event_id desc
       limit 1
     ) lifecycle on true
     where asset.tenant_id = $1
       and asset.brand_id = $2
       and coalesce(lifecycle.to_status, asset.status) = 'Active'
       and asset.effective_from <= now()
       and (asset.effective_to is null or asset.effective_to > now())
     order by asset.asset_type asc, asset.asset_key asc, asset.effective_from desc, asset.created_at desc`,
    [tenantId, brandId]
  );

  return result.rows;
}

export async function resolveRuntimeBrandContext(input: {
  readonly hostname: string;
  readonly agentId?: string | null;
}): Promise<RuntimeBrandContext | null> {
  const hostname = normalizeRuntimeHostname(input.hostname);

  const result = await databasePool().query(
    `select
       resolved.hostname,
       resolved.tenant_id,
       resolved.brand_id,
       resolved.market_id,
       resolved.website_id,
       resolved.domain_id,
       resolved.canonical,
       resolved.canonical_redirect_target,
       resolved.maintenance_mode,
       resolved.default_language as website_default_language,
       resolved.default_currency as website_default_currency,
       resolved.default_timezone as website_default_timezone,
       resolved.effective_from as domain_effective_from,
       resolved.effective_to as domain_effective_to,
       organization.id as organization_id,
       organization.organization_code,
       organization.version as organization_version,
       organization.content_hash as organization_content_hash,
       tenant.tenant_code,
       tenant.default_language as tenant_default_language,
       tenant.default_currency as tenant_default_currency,
       tenant.default_timezone as tenant_default_timezone,
       tenant.version as tenant_version,
       tenant.content_hash as tenant_content_hash,
       brand.brand_code,
       brand.version as brand_version,
       brand.content_hash as brand_content_hash,
       market.market_code,
       market.language as market_language,
       market.currency as market_currency,
       market.timezone as market_timezone,
       market.version as market_version,
       market.content_hash as market_content_hash,
       website.website_code,
       website.version as website_version,
       website.content_hash as website_content_hash,
       domain.version as domain_version,
       domain.content_hash as domain_content_hash
     from platform.active_host_resolutions resolved
     join platform.websites website on website.id = resolved.website_id
     join platform.website_domains domain on domain.id = resolved.domain_id
     join platform.tenants tenant on tenant.id = resolved.tenant_id
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.brands brand on brand.id = resolved.brand_id and brand.tenant_id = tenant.id
     left join platform.markets market on market.id = resolved.market_id and market.brand_id = brand.id
     where resolved.hostname = $1
       and website.tenant_id = tenant.id
       and website.brand_id = brand.id
       and (website.market_id is null or website.market_id = market.id)
     limit 1`,
    [hostname]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const tenantId = String(row.tenant_id);
  const brandId = String(row.brand_id);
  const marketId = row.market_id ? String(row.market_id) : null;
  const websiteId = String(row.website_id);
  const theme = await resolveActiveDefaultTheme(tenantId, brandId);
  const assets = await resolveActiveBrandAssets(tenantId, brandId);
  const games = await resolvePlatformGameAvailability({
    tenantId,
    brandId,
    marketId,
    websiteId,
    agentId: input.agentId ?? null,
  });

  const maintenanceMode = Boolean(row.maintenance_mode);
  const availableGames = games.filter((game) => game.isAvailable === true);
  const publiclyPlayableGames = maintenanceMode ? [] : availableGames;
  const canonicalHostname = nullableString(row.canonical_redirect_target) ?? hostname;
  const canonicalRedirectRequired = canonicalHostname !== hostname;

  return {
    hostname,
    organizationId: String(row.organization_id),
    tenantId,
    brandId,
    marketId,
    websiteId,
    canonicalHostname,
    canonicalRedirectRequired,
    defaultLanguage:
      nullableString(row.website_default_language) ??
      nullableString(row.market_language) ??
      nullableString(row.tenant_default_language) ??
      "en",
    defaultCurrency:
      nullableString(row.website_default_currency) ??
      nullableString(row.market_currency) ??
      nullableString(row.tenant_default_currency) ??
      "USD",
    defaultTimezone:
      nullableString(row.website_default_timezone) ??
      nullableString(row.market_timezone) ??
      nullableString(row.tenant_default_timezone) ??
      "UTC",
    maintenanceMode,
    activeThemeReference: theme
      ? {
          themeId: String(theme.id),
          themeCode: String(theme.theme_code),
          displayName: String(theme.display_name),
          version: String(theme.version),
          contentHash: String(theme.content_hash),
        }
      : null,
    activeThemeTokens: theme
      ? {
          colorTokens: serializeValue(theme.color_tokens),
          typographyTokens: serializeValue(theme.typography_tokens),
          spacingRadiusTokens: serializeValue(theme.spacing_radius_tokens),
          componentTokenPlaceholders: serializeValue(theme.component_token_placeholders),
          modeSupport: serializeValue(theme.mode_support),
        }
      : null,
    brandAssetReferences: assets.map((asset) => ({
      assetId: String(asset.id),
      assetType: String(asset.asset_type),
      assetKey: String(asset.asset_key),
      mimeType: String(asset.mime_type),
      assetChecksumHash: String(asset.asset_checksum_hash),
      version: String(asset.version),
      contentHash: String(asset.content_hash),
    })),
    resolvedGameAvailabilitySummary: {
      totalResolved: games.length,
      availableCount: availableGames.length,
      publiclyPlayableCount: publiclyPlayableGames.length,
      maintenanceMode,
      games: games.map((game) => ({
        availabilityId: game.availabilityId,
        gameId: game.gameId,
        gameCode: game.gameCode,
        gameManifestReference: game.gameManifestReference,
        status: game.status,
        isAvailable: game.isAvailable,
        publiclyPlayable: !maintenanceMode && game.isAvailable === true,
        specificityRank: game.specificityRank,
        minWagerOverride: game.minWagerOverride,
        maxWagerOverride: game.maxWagerOverride,
        languageOverride: game.languageOverride,
        currencyOverride: game.currencyOverride,
        timezoneOverride: game.timezoneOverride,
        contentHash: game.contentHash,
      })),
    },
    resolutionTimestamp: new Date().toISOString(),
    contentVersionReferences: {
      organization: {
        id: String(row.organization_id),
        code: String(row.organization_code),
        version: String(row.organization_version),
        contentHash: String(row.organization_content_hash),
      },
      tenant: {
        id: tenantId,
        code: String(row.tenant_code),
        version: String(row.tenant_version),
        contentHash: String(row.tenant_content_hash),
      },
      brand: {
        id: brandId,
        code: String(row.brand_code),
        version: String(row.brand_version),
        contentHash: String(row.brand_content_hash),
      },
      market: marketId
        ? {
            id: marketId,
            code: String(row.market_code),
            version: String(row.market_version),
            contentHash: String(row.market_content_hash),
          }
        : null,
      website: {
        id: websiteId,
        code: String(row.website_code),
        version: String(row.website_version),
        contentHash: String(row.website_content_hash),
      },
      domain: {
        id: String(row.domain_id),
        hostname,
        version: String(row.domain_version),
        contentHash: String(row.domain_content_hash),
        effectiveFrom: serializeValue(row.domain_effective_from),
        effectiveTo: serializeValue(row.domain_effective_to),
      },
      theme: theme
        ? {
            id: String(theme.id),
            code: String(theme.theme_code),
            version: String(theme.version),
            contentHash: String(theme.content_hash),
          }
        : null,
    },
  };
}

const lifecycleTransitions: Record<PlatformLifecycleStatus, readonly PlatformLifecycleStatus[]> = {
  Draft: ["Active", "Cancelled"],
  Active: ["Suspended", "Superseded"],
  Suspended: ["Active", "Retired", "Superseded"],
  Retired: [],
  Superseded: [],
  Cancelled: [],
};

const lifecycleTargetByAction: Record<Exclude<PlatformLifecycleAction, "supersede">, PlatformLifecycleStatus> = {
  activate: "Active",
  suspend: "Suspended",
  retire: "Retired",
  cancel: "Cancelled",
};

function ensureLifecycleTransition(fromStatus: string, toStatus: PlatformLifecycleStatus) {
  if (!isPlatformLifecycleStatus(fromStatus)) {
    throw new PlatformManagementValidationError(`Unsupported lifecycle status '${fromStatus}'.`);
  }

  if (!lifecycleTransitions[fromStatus].includes(toStatus)) {
    throw new PlatformManagementValidationError(`Illegal lifecycle transition ${fromStatus} -> ${toStatus}.`);
  }
}

function isPlatformLifecycleStatus(status: string): status is PlatformLifecycleStatus {
  return Object.hasOwn(lifecycleTransitions, status);
}

function lifecycleEntityColumns(resource: PlatformResourceName) {
  switch (resource) {
    case "organizations":
      return ["organization_code"];
    case "tenants":
      return ["organization_id", "tenant_code"];
    case "brands":
      return ["tenant_id", "brand_code"];
    case "markets":
      return ["brand_id", "market_code"];
    case "websites":
      return ["brand_id", "website_code"];
    case "domains":
      return ["hostname"];
    case "themes":
      return ["brand_id", "theme_code"];
    case "brand-assets":
      return ["brand_id", "asset_type", "asset_key"];
    case "game-availability":
      return ["tenant_id", "brand_id", "market_id", "website_id", "agent_id", "game_code"];
  }
}

async function currentLifecycleStatus(resource: PlatformResourceName, recordId: string, fallbackStatus: string) {
  const result = await databasePool().query(
    `select to_status
     from platform.platform_lifecycle_events
     where resource = $1 and record_id = $2
     order by created_at desc, event_id desc
     limit 1`,
    [resource, recordId]
  );

  return result.rows[0]?.to_status ? String(result.rows[0].to_status) : fallbackStatus;
}

async function assertNoActivePeer(resource: PlatformResourceName, row: QueryResultRow, allowedRecordId?: string) {
  const definition = resources[resource];
  const columns = lifecycleEntityColumns(resource);
  const clauses: string[] = [];
  const params: unknown[] = [resource, allowedRecordId ?? null];

  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) {
      clauses.push(`${column} is null`);
    } else {
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
  }

  const result = await databasePool().query(
    `select current_row.id
     from ${definition.table} current_row
     left join lateral (
       select to_status
       from platform.platform_lifecycle_events lifecycle
       where lifecycle.resource = $1
         and lifecycle.record_id = current_row.id
       order by lifecycle.created_at desc, lifecycle.event_id desc
       limit 1
     ) lifecycle on true
     where (${clauses.join(" and ")})
       and current_row.id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       and coalesce(lifecycle.to_status, current_row.status) = 'Active'
     limit 1`,
    params
  );

  if (result.rows[0]) {
    throw new PlatformManagementConflictError("Only one Active version is allowed for this platform entity.");
  }
}

async function assertActivationDependencies(resource: PlatformResourceName, row: QueryResultRow) {
  const checks: Partial<Record<PlatformResourceName, { sql: string; params: unknown[]; message: string }>> = {
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
      sql: "select 1 from platform.brands where id = $1 and status = 'Active' limit 1",
      params: [row.brand_id],
      message: "Website activation requires an Active Brand.",
    },
    domains: {
      sql: "select 1 from platform.websites where id = $1 and status = 'Active' limit 1",
      params: [row.website_id],
      message: "Domain activation requires an Active Website.",
    },
    themes: {
      sql: "select 1 from platform.brands where id = $1 and status = 'Active' limit 1",
      params: [row.brand_id],
      message: "Theme activation requires an Active Brand.",
    },
    "brand-assets": {
      sql: "select 1 from platform.brands where id = $1 and status = 'Active' limit 1",
      params: [row.brand_id],
      message: "Asset activation requires an Active Brand.",
    },
    "game-availability": {
      sql: `select 1
            from platform.tenants t
            join platform.brands b on b.id = $2 and b.tenant_id = t.id
            left join platform.markets m on m.id = $3
            left join platform.websites w on w.id = $4
            where t.id = $1
              and t.status = 'Active'
              and b.status = 'Active'
              and ($3::uuid is null or (m.status = 'Active' and m.brand_id = b.id))
              and ($4::uuid is null or (w.status = 'Active' and w.brand_id = b.id and w.tenant_id = t.id))
            limit 1`,
      params: [row.tenant_id, row.brand_id, row.market_id, row.website_id],
      message: "Game Availability activation requires an Active hierarchy.",
    },
  };

  const check = checks[resource];
  if (!check) return;

  const result = await databasePool().query(check.sql, check.params);
  if (!result.rows[0]) {
    throw new PlatformManagementValidationError(check.message);
  }
}

async function assertRetirementDependencies(resource: PlatformResourceName, row: QueryResultRow) {
  const checks: Partial<Record<PlatformResourceName, { sql: string; params: unknown[]; message: string }>> = {
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
      message: "Brand retirement requires retiring Active Websites and Markets first.",
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
  };

  const check = checks[resource];
  if (!check) return;

  const result = await databasePool().query(check.sql, check.params);
  if (result.rows[0]) {
    throw new PlatformManagementValidationError(check.message);
  }
}

function sourceInputFromRow(resource: PlatformResourceName, row: QueryResultRow) {
  const input: Record<string, unknown> = {};
  for (const fieldDefinition of resources[resource].fields) {
    if (fieldDefinition.column === "id" || fieldDefinition.column === "content_hash") {
      continue;
    }

    input[camelizeKey(fieldDefinition.column)] = dbValue(row, camelizeKey(fieldDefinition.column), fieldDefinition.column);
  }

  return input;
}

function lifecycleOperator(input: Record<string, unknown>) {
  const operator = input.operator ?? input.lifecycleOperator ?? input.requestedBy;
  return typeof operator === "string" && operator.trim() ? operator.trim() : "platform-management-api";
}

function lifecycleReason(input: Record<string, unknown>) {
  const reason = input.reason ?? input.lifecycleReason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : "lifecycle-management";
}

async function insertLifecycleEvent(input: {
  readonly resource: PlatformResourceName;
  readonly recordId: string;
  readonly entityKey: Record<string, unknown>;
  readonly fromStatus: string;
  readonly toStatus: PlatformLifecycleStatus;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly supersedesRecordId?: string | null;
  readonly supersededByRecordId?: string | null;
  readonly effectiveFrom?: string | null;
  readonly effectiveTo?: string | null;
  readonly reason: string;
  readonly operator: string;
  readonly approvalMetadata: unknown;
}) {
  await databasePool().query(
    `insert into platform.platform_lifecycle_events (
       resource, record_id, entity_key, from_status, to_status, from_version, to_version,
       supersedes_record_id, superseded_by_record_id, effective_from, effective_to,
       reason, operator, approval_metadata, event_hash
     )
     values ($1::text, $2::uuid, $3::jsonb, $4::text, $5::text, $6::text, $7::text, $8::uuid, $9::uuid, coalesce($10::timestamptz, now()),
       $11::timestamptz, $12::text, $13::text, $14::jsonb,
       'sha256:' || encode(digest(concat_ws(':', $1::text, $2::uuid::text, $4::text, $5::text, $6::text, $7::text, coalesce($8::uuid::text, ''), coalesce($9::uuid::text, ''), $12::text, $13::text), 'sha256'), 'hex'))`,
    [
      input.resource,
      input.recordId,
      JSON.stringify(input.entityKey),
      input.fromStatus,
      input.toStatus,
      input.fromVersion,
      input.toVersion,
      input.supersedesRecordId ?? null,
      input.supersededByRecordId ?? null,
      input.effectiveFrom ?? null,
      input.effectiveTo ?? null,
      input.reason,
      input.operator,
      JSON.stringify(input.approvalMetadata ?? {}),
    ]
  );
}

function entityKeyFromRow(resource: PlatformResourceName, row: QueryResultRow) {
  return Object.fromEntries(lifecycleEntityColumns(resource).map((column) => [column, row[column] ?? null]));
}

export async function performPlatformLifecycleAction(
  resource: PlatformResourceName,
  id: string,
  action: PlatformLifecycleAction,
  input: Record<string, unknown>
) {
  const definition = resources[resource];
  const currentResult = await databasePool().query(`select * from ${definition.table} where id = $1 limit 1`, [id]);
  const current = currentResult.rows[0];

  if (!current) {
    return null;
  }

  const currentStatus = await currentLifecycleStatus(resource, id, String(current.status));
  const targetStatus = action === "supersede" ? "Active" : lifecycleTargetByAction[action];

  if (!targetStatus) {
    throw new PlatformManagementValidationError(`Unsupported lifecycle action '${action}'.`);
  }

  ensureLifecycleTransition(currentStatus, action === "supersede" ? "Superseded" : targetStatus);

  if (targetStatus === "Active") {
    await assertActivationDependencies(resource, current);
    await assertNoActivePeer(resource, current, id);
  }

  if (targetStatus === "Retired") {
    await assertRetirementDependencies(resource, current);
  }

  const nextVersion = input.version;
  if (typeof nextVersion !== "string" || !nextVersion.trim()) {
    throw new PlatformManagementValidationError("New lifecycle version is required.");
  }

  if (nextVersion.trim() === String(current.version)) {
    throw new PlatformManagementValidationError("New lifecycle version must differ from current version.");
  }

  const reason = lifecycleReason(input);
  const operator = lifecycleOperator(input);
  const now = new Date().toISOString();
  const approvalMetadata = input.approvalMetadata ?? {};
  const nextInput = {
    ...sourceInputFromRow(resource, current),
    ...input,
    id: randomUUID(),
    status: targetStatus,
    version: nextVersion.trim(),
    previousVersion: String(current.version),
    supersedesVersion: String(current.version),
    effectiveFrom: input.effectiveFrom ?? now,
    effectiveTo: input.effectiveTo ?? null,
    lifecycleReason: reason,
    lifecycleOperator: operator,
    approvalMetadata,
    contentHash: input.contentHash,
  };

  const next = await createPlatformRecord(resource, nextInput);
  const nextId = String(next.id);

  await insertLifecycleEvent({
    resource,
    recordId: id,
    entityKey: entityKeyFromRow(resource, current),
    fromStatus: currentStatus,
    toStatus: "Superseded",
    fromVersion: String(current.version),
    toVersion: String(current.version),
    supersededByRecordId: nextId,
    effectiveFrom: timestampValue(
      dbValue(current, "effectiveFrom", "effective_from") ?? current.created_at,
      now
    ),
    effectiveTo: now,
    reason,
    operator,
    approvalMetadata,
  });

  await insertLifecycleEvent({
    resource,
    recordId: nextId,
    entityKey: entityKeyFromRow(resource, current),
    fromStatus: currentStatus,
    toStatus: targetStatus,
    fromVersion: String(current.version),
    toVersion: String(next.version),
    supersedesRecordId: id,
    effectiveFrom: String(next.effectiveFrom ?? now),
    effectiveTo: typeof next.effectiveTo === "string" ? next.effectiveTo : null,
    reason,
    operator,
    approvalMetadata,
  });

  return {
    previous: mapRow(current),
    current: next,
  };
}

export async function listPlatformLifecycleEvents(resource: PlatformResourceName, id: string) {
  const result = await databasePool().query(
    `select *
     from platform.platform_lifecycle_events
     where resource = $1 and record_id = $2
     order by created_at asc, event_id asc`,
    [resource, id]
  );

  return result.rows.map(mapRow);
}
