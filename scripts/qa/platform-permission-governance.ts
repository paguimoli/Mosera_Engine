import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import * as collectionRoute from "../../app/api/platform-management/[resource]/route";
import * as recordRoute from "../../app/api/platform-management/[resource]/[id]/route";
import * as hostRoute from "../../app/api/platform-management/resolve-host/route";
import { setPlatformManagementAuthOverrideForTesting } from "../../src/domains/platform-management/platform-management-auth";

type JsonObject = Record<string, unknown>;

const checks: { name: string; status: "PASS" | "FAIL"; metadata?: JsonObject }[] = [];

function addCheck(name: string, passed: boolean, metadata: JsonObject = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function hash(label: string, runId: string) {
  return `sha256:platform-permission-governance:${label}:${runId}`;
}

function collectionParams(resource: string) {
  return { params: Promise.resolve({ resource }) };
}

function recordParams(resource: string, id: string) {
  return { params: Promise.resolve({ resource, id }) };
}

function apiRequest(url: string, method = "GET", body?: JsonObject) {
  return new Request(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readJson(response: Response) {
  return (await response.json()) as JsonObject;
}

async function create(resource: string, body: JsonObject) {
  const response = await collectionRoute.POST(
    apiRequest(`http://qa.local/api/platform-management/${resource}`, "POST", body),
    collectionParams(resource)
  );

  return { response, json: await readJson(response) };
}

async function get(resource: string, id: string) {
  const response = await recordRoute.GET(
    apiRequest(`http://qa.local/api/platform-management/${resource}/${id}`),
    recordParams(resource, id)
  );

  return { response, json: await readJson(response) };
}

function recordId(json: JsonObject, key: string) {
  const record = json[key] as JsonObject | undefined;
  return typeof record?.id === "string" ? record.id : "";
}

async function queryOne<T extends JsonObject>(pool: Pool, sql: string) {
  const result = await pool.query<T>(sql);
  return result.rows[0] ?? null;
}

async function createTenantGraph(runId: string, label: string) {
  setPlatformManagementAuthOverrideForTesting(["system.admin"]);

  const organization = await create("organizations", {
    code: `${label}-org-${runId}`,
    name: `${label} Organization`,
    status: "Active",
    version: "1.0.0",
    contentHash: hash(`${label}-organization`, runId),
  });
  const organizationId = recordId(organization.json, "organization");

  const tenant = await create("tenants", {
    organizationId,
    code: `${label}-tenant-${runId}`,
    name: `${label} Tenant`,
    status: "Active",
    defaultLanguage: "en",
    defaultCurrency: "USD",
    defaultTimezone: "America/Costa_Rica",
    creditEnabled: true,
    cashierEnabled: false,
    version: "1.0.0",
    contentHash: hash(`${label}-tenant`, runId),
  });
  const tenantId = recordId(tenant.json, "tenant");

  const brand = await create("brands", {
    tenantId,
    code: `${label}-brand-${runId}`,
    name: `${label} Brand`,
    displayName: `${label} Brand`,
    status: "Active",
    version: "1.0.0",
    contentHash: hash(`${label}-brand`, runId),
  });
  const brandId = recordId(brand.json, "brand");

  const market = await create("markets", {
    brandId,
    code: `${label}-market-${runId}`,
    name: `${label} Market`,
    displayName: `${label} Market`,
    language: "en",
    currency: "USD",
    timezone: "America/Costa_Rica",
    status: "Active",
    version: "1.0.0",
    contentHash: hash(`${label}-market`, runId),
  });
  const marketId = recordId(market.json, "market");

  const website = await create("websites", {
    tenantId,
    brandId,
    marketId,
    code: `${label}-site-${runId}`,
    displayName: `${label} Website`,
    status: "Active",
    defaultLanguage: "en",
    defaultCurrency: "USD",
    defaultTimezone: "America/Costa_Rica",
    maintenanceMode: false,
    version: "1.0.0",
    contentHash: hash(`${label}-website`, runId),
  });
  const websiteId = recordId(website.json, "website");

  const hostname = `${label}-${runId}.example.test`;
  await create("domains", {
    websiteId,
    hostname,
    canonical: true,
    status: "Active",
    verificationStatus: "Verified",
    version: "1.0.0",
    contentHash: hash(`${label}-domain`, runId),
  });

  return {
    organizationId,
    tenantId,
    brandId,
    marketId,
    websiteId,
    hostname,
  };
}

async function main() {
  const runId = randomUUID();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
  });

  try {
    const seed = await queryOne<{
      permission_count: string;
      duplicate_count: string;
      super_count: number;
      operations_count: number;
      operations_has_org_create: boolean;
      auditor_non_read_count: string;
    }>(
      pool,
      `
select
  (select count(*)::text from auth_service.permissions where code like 'platform.%') as permission_count,
  (select count(*)::text from (
    select code from auth_service.permissions where code like 'platform.%' group by code having count(*) > 1
  ) dupes) as duplicate_count,
  (select jsonb_array_length(metadata->'permissions') from auth_service.roles where code = 'PLATFORM_SUPER_ADMIN') as super_count,
  (select jsonb_array_length(metadata->'permissions') from auth_service.roles where code = 'PLATFORM_OPERATIONS_ADMIN') as operations_count,
  (select metadata->'permissions' ? 'platform.organization.create' from auth_service.roles where code = 'PLATFORM_OPERATIONS_ADMIN') as operations_has_org_create,
  (select count(*)::text from auth_service.roles r, jsonb_array_elements_text(r.metadata->'permissions') permission(code)
   where r.code = 'PLATFORM_READ_ONLY_AUDITOR' and permission.code not like 'platform.%.read') as auditor_non_read_count;
`
    );

    addCheck(
      "permission seed is idempotent",
      seed?.permission_count === "18" && seed.duplicate_count === "0",
      { seed: seed ?? {} }
    );
    addCheck("Super Admin has all permissions", seed?.super_count === 18, { seed: seed ?? {} });
    addCheck(
      "Operations Admin receives intended permissions only",
      seed?.operations_count === 17 && seed.operations_has_org_create === false,
      { seed: seed ?? {} }
    );
    addCheck(
      "read-only role cannot create",
      seed?.auditor_non_read_count === "0",
      { seed: seed ?? {} }
    );

    const tenantA = await createTenantGraph(runId, "tenant-a");
    const tenantB = await createTenantGraph(runId, "tenant-b");

    setPlatformManagementAuthOverrideForTesting({
      permissions: ["platform.tenant.read", "platform.brand.create", "platform.website.create"],
      scopes: [{ scopeType: "TENANT", scopeId: tenantA.tenantId }],
    });

    const ownTenant = await get("tenants", tenantA.tenantId);
    addCheck(
      "tenant admin can access own tenant resources",
      ownTenant.response.status === 200 && ownTenant.json.success === true,
      { status: ownTenant.response.status, body: ownTenant.json }
    );

    const otherTenant = await get("tenants", tenantB.tenantId);
    addCheck(
      "tenant admin cannot access another tenant",
      otherTenant.response.status === 403 && otherTenant.json.success === false,
      { status: otherTenant.response.status, body: otherTenant.json }
    );

    const scopedBrand = await create("brands", {
      tenantId: tenantA.tenantId,
      code: `scoped-brand-${runId}`,
      name: "Scoped Brand",
      displayName: "Scoped Brand",
      status: "Active",
      version: "1.0.0",
      contentHash: hash("scoped-brand", runId),
    });
    addCheck(
      "tenant admin can create in own tenant scope",
      scopedBrand.response.status === 201 && scopedBrand.json.success === true,
      { status: scopedBrand.response.status, body: scopedBrand.json }
    );

    const crossTenantWebsite = await create("websites", {
      tenantId: tenantA.tenantId,
      brandId: tenantB.brandId,
      code: `cross-tenant-site-${runId}`,
      displayName: "Cross Tenant Site",
      status: "Active",
      defaultLanguage: "en",
      defaultCurrency: "USD",
      defaultTimezone: "UTC",
      version: "1.0.0",
      contentHash: hash("cross-tenant-site", runId),
    });
    addCheck(
      "cross-tenant create fails",
      crossTenantWebsite.response.status === 403 && crossTenantWebsite.json.success === false,
      { status: crossTenantWebsite.response.status, body: crossTenantWebsite.json }
    );

    setPlatformManagementAuthOverrideForTesting({
      permissions: ["platform.brand.create"],
      scopes: [],
    });
    const missingScopeBrand = await create("brands", {
      tenantId: tenantA.tenantId,
      code: `missing-scope-brand-${runId}`,
      name: "Missing Scope Brand",
      displayName: "Missing Scope Brand",
      status: "Active",
      version: "1.0.0",
      contentHash: hash("missing-scope-brand", runId),
    });
    addCheck(
      "missing scope fails closed",
      missingScopeBrand.response.status === 403 && missingScopeBrand.json.success === false,
      { status: missingScopeBrand.response.status, body: missingScopeBrand.json }
    );

    setPlatformManagementAuthOverrideForTesting(["system.admin"]);
    const invalidHierarchy = await create("websites", {
      tenantId: tenantA.tenantId,
      brandId: tenantB.brandId,
      code: `invalid-hierarchy-${runId}`,
      displayName: "Invalid Hierarchy",
      status: "Active",
      defaultLanguage: "en",
      defaultCurrency: "USD",
      defaultTimezone: "UTC",
      version: "1.0.0",
      contentHash: hash("invalid-hierarchy", runId),
    });
    addCheck(
      "invalid tenant/brand hierarchy fails",
      invalidHierarchy.response.status === 400 && invalidHierarchy.json.success === false,
      { status: invalidHierarchy.response.status, body: invalidHierarchy.json }
    );

    setPlatformManagementAuthOverrideForTesting(null);
    const hostResponse = await hostRoute.GET(
      apiRequest(`http://qa.local/api/platform-management/resolve-host?hostname=${tenantA.hostname}`)
    );
    const hostJson = await readJson(hostResponse);
    addCheck(
      "resolve-host remains intentionally public/internal-safe",
      hostResponse.status === 200 && hostJson.success === true,
      { status: hostResponse.status, body: hostJson }
    );
  } finally {
    setPlatformManagementAuthOverrideForTesting(null);
    await pool.end();
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
