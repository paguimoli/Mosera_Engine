import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import * as collectionRoute from "../../app/api/platform-management/[resource]/route";
import * as lifecycleRoute from "../../app/api/platform-management/[resource]/[id]/lifecycle/[action]/route";
import { setPlatformManagementAuthOverrideForTesting } from "../../src/domains/platform-management/platform-management-auth";

type JsonObject = Record<string, unknown>;

const checks: { name: string; status: "PASS" | "FAIL"; metadata?: JsonObject }[] = [];

function addCheck(name: string, passed: boolean, metadata: JsonObject = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function hash(label: string, runId: string) {
  return `sha256:platform-lifecycle:${label}:${runId}`;
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

function collectionParams(resource: string) {
  return { params: Promise.resolve({ resource }) };
}

function lifecycleParams(resource: string, id: string, action: string) {
  return { params: Promise.resolve({ resource, id, action }) };
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

async function lifecycle(resource: string, id: string, action: string, body: JsonObject) {
  const response = await lifecycleRoute.POST(
    apiRequest(`http://qa.local/api/platform-management/${resource}/${id}/lifecycle/${action}`, "POST", body),
    lifecycleParams(resource, id, action)
  );

  return { response, json: await readJson(response) };
}

function recordId(json: JsonObject, key: string) {
  const record = json[key] as JsonObject | undefined;
  return typeof record?.id === "string" ? record.id : "";
}

function record(json: JsonObject, key: string) {
  return (json[key] ?? {}) as JsonObject;
}

function requireRecordId(json: JsonObject, key: string, label: string) {
  const id = recordId(json, key);
  if (!id) {
    throw new Error(`${label} did not return ${key}.id: ${JSON.stringify(json)}`);
  }
  return id;
}

async function queryOne<T extends JsonObject>(pool: Pool, sql: string, params: unknown[] = []) {
  const result = await pool.query<T>(sql, params);
  return result.rows[0] ?? null;
}

async function createOrganization(runId: string, label: string, status = "Draft") {
  const result = await create("organizations", {
    code: `${label}-org-${runId}`,
    name: `${label} Organization`,
    status,
    version: "1.0.0",
    contentHash: hash(`${label}-organization`, runId),
  });
  return requireRecordId(result.json, "organization", "create organization");
}

async function createTenant(runId: string, label: string, organizationId: string, status = "Draft") {
  const result = await create("tenants", {
    organizationId,
    code: `${label}-tenant-${runId}`,
    name: `${label} Tenant`,
    status,
    defaultLanguage: "en",
    defaultCurrency: "USD",
    defaultTimezone: "America/Costa_Rica",
    creditEnabled: true,
    cashierEnabled: false,
    version: "1.0.0",
    contentHash: hash(`${label}-tenant`, runId),
  });
  return requireRecordId(result.json, "tenant", "create tenant");
}

async function createBrand(runId: string, label: string, tenantId: string, status = "Draft") {
  const result = await create("brands", {
    tenantId,
    code: `${label}-brand-${runId}`,
    name: `${label} Brand`,
    displayName: `${label} Brand`,
    status,
    version: "1.0.0",
    contentHash: hash(`${label}-brand`, runId),
  });
  return requireRecordId(result.json, "brand", "create brand");
}

async function createMarket(runId: string, label: string, brandId: string, status = "Active") {
  const result = await create("markets", {
    brandId,
    code: `${label}-market-${runId}`,
    name: `${label} Market`,
    displayName: `${label} Market`,
    language: "en",
    currency: "USD",
    timezone: "America/Costa_Rica",
    status,
    version: "1.0.0",
    contentHash: hash(`${label}-market`, runId),
  });
  return requireRecordId(result.json, "market", "create market");
}

async function main() {
  const runId = randomUUID();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
  });

  setPlatformManagementAuthOverrideForTesting(["system.admin"]);

  try {
    const baseOrganizationId = await createOrganization(runId, "base");
    const activatedOrganization = await lifecycle("organizations", baseOrganizationId, "activate", {
      version: "1.1.0",
      reason: "qa activate organization",
      operator: "platform-lifecycle-qa",
    });
    const activeOrganization = record(activatedOrganization.json, "organization");
    const activeOrganizationId = requireRecordId(
      activatedOrganization.json,
      "organization",
      "activate organization"
    );

    addCheck(
      "valid lifecycle transition Draft -> Active",
      activatedOrganization.response.status === 201 && activeOrganization.status === "Active",
      { status: activatedOrganization.response.status, body: activatedOrganization.json }
    );

    const invalidCancel = await lifecycle("organizations", activeOrganizationId, "cancel", {
      version: "1.2.0",
      reason: "qa invalid cancel",
      operator: "platform-lifecycle-qa",
    });
    addCheck(
      "invalid lifecycle transition rejected",
      invalidCancel.response.status === 400 && invalidCancel.json.success === false,
      { status: invalidCancel.response.status, body: invalidCancel.json }
    );

    const tenantId = await createTenant(runId, "base", activeOrganizationId);
    const activatedTenant = await lifecycle("tenants", tenantId, "activate", {
      version: "1.1.0",
      reason: "qa activate tenant",
      operator: "platform-lifecycle-qa",
    });
    const activeTenantId = requireRecordId(activatedTenant.json, "tenant", "activate tenant");

    const brandId = await createBrand(runId, "base", activeTenantId);
    const activatedBrand = await lifecycle("brands", brandId, "activate", {
      version: "1.1.0",
      reason: "qa activate brand",
      operator: "platform-lifecycle-qa",
    });
    const activeBrandId = requireRecordId(activatedBrand.json, "brand", "activate brand");

    const supersededBrand = await lifecycle("brands", activeBrandId, "supersede", {
      version: "1.2.0",
      displayName: "Superseded QA Brand",
      reason: "qa supersede brand",
      operator: "platform-lifecycle-qa",
      approvalMetadata: { approvalState: "InternalVerified" },
    });
    const currentBrand = record(supersededBrand.json, "brand");
    const currentBrandId = requireRecordId(supersededBrand.json, "brand", "supersede brand");

    addCheck(
      "supersede creates new version",
      supersededBrand.response.status === 201 &&
        currentBrand.version === "1.2.0" &&
        currentBrand.previousVersion === "1.1.0" &&
        currentBrand.supersedesVersion === "1.1.0",
      { status: supersededBrand.response.status, body: supersededBrand.json }
    );

    const oldBrand = await queryOne<{ status: string; version: string; display_name: string }>(
      pool,
      "select status, version, display_name from platform.brands where id = $1",
      [activeBrandId]
    );
    addCheck(
      "previous version immutable",
      oldBrand?.status === "Active" && oldBrand.version === "1.1.0" && oldBrand.display_name === "base Brand",
      { oldBrand: oldBrand ?? {} }
    );

    const effectiveTrail = await queryOne<{ old_closed: string; new_opened: string; event_count: string }>(
      pool,
      `
select
  count(*) filter (where record_id = $1 and to_status = 'Superseded' and effective_to is not null)::text as old_closed,
  count(*) filter (where record_id = $2 and to_status = 'Active' and effective_to is null)::text as new_opened,
  count(*)::text as event_count
from platform.platform_lifecycle_events
where record_id in ($1, $2);
`,
      [activeBrandId, currentBrandId]
    );
    addCheck(
      "effective dating correct",
      effectiveTrail?.old_closed === "1" && effectiveTrail.new_opened === "1",
      { effectiveTrail: effectiveTrail ?? {} }
    );
    addCheck(
      "history preserved",
      Number(effectiveTrail?.event_count ?? 0) >= 2,
      { effectiveTrail: effectiveTrail ?? {} }
    );

    const activeBrandCount = await queryOne<{ active_count: string }>(
      pool,
      `
select count(*)::text as active_count
from platform.brands b
left join lateral (
  select to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'brands'
    and lifecycle.record_id = b.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) lifecycle on true
where b.tenant_id = $1
  and b.brand_code = $2
  and coalesce(lifecycle.to_status, b.status) = 'Active';
`,
      [activeTenantId, currentBrand.brandCode]
    );
    addCheck("single active version enforced", activeBrandCount?.active_count === "1", {
      activeBrandCount: activeBrandCount ?? {},
    });

    const suspendedBrand = await lifecycle("brands", currentBrandId, "suspend", {
      version: "1.3.0",
      reason: "qa suspend brand",
      operator: "platform-lifecycle-qa",
    });
    const suspendedBrandId = recordId(suspendedBrand.json, "brand");
    const reactivatedBrand = await lifecycle("brands", suspendedBrandId, "activate", {
      version: "1.4.0",
      reason: "qa reactivate brand",
      operator: "platform-lifecycle-qa",
    });
    const reactivatedBrandRecord = record(reactivatedBrand.json, "brand");
    const reactivatedBrandId = String(reactivatedBrandRecord.id);
    addCheck(
      "valid suspend and reactivate transitions",
      suspendedBrand.response.status === 201 &&
        record(suspendedBrand.json, "brand").status === "Suspended" &&
        reactivatedBrand.response.status === 201 &&
        reactivatedBrandRecord.status === "Active",
      { suspended: suspendedBrand.json, reactivated: reactivatedBrand.json }
    );

    const draftOrganizationId = await createOrganization(runId, "dependency", "Draft");
    const draftTenantId = await createTenant(runId, "dependency", draftOrganizationId, "Draft");
    const dependencyFailure = await lifecycle("tenants", draftTenantId, "activate", {
      version: "1.1.0",
      reason: "qa invalid dependency activation",
      operator: "platform-lifecycle-qa",
    });
    addCheck(
      "activation dependency validation",
      dependencyFailure.response.status === 400 && dependencyFailure.json.success === false,
      { status: dependencyFailure.response.status, body: dependencyFailure.json }
    );

    const marketId = await createMarket(runId, "base", reactivatedBrandId, "Active");
    const website = await create("websites", {
      tenantId: activeTenantId,
      brandId: reactivatedBrandId,
      marketId,
      code: `base-site-${runId}`,
      displayName: "Lifecycle Website",
      status: "Active",
      defaultLanguage: "en",
      defaultCurrency: "USD",
      defaultTimezone: "America/Costa_Rica",
      maintenanceMode: false,
      version: "1.0.0",
      contentHash: hash("website", runId),
    });
    const websiteId = recordId(website.json, "website");
    await create("domains", {
      websiteId,
      hostname: `lifecycle-${runId}.example.test`,
      canonical: true,
      status: "Active",
      verificationStatus: "Verified",
      version: "1.0.0",
      contentHash: hash("domain", runId),
    });
    const suspendedWebsite = await lifecycle("websites", websiteId, "suspend", {
      version: "1.1.0",
      reason: "qa suspend website before retirement check",
      operator: "platform-lifecycle-qa",
    });
    const suspendedWebsiteId = requireRecordId(
      suspendedWebsite.json,
      "website",
      "suspend website before retirement check"
    );
    const blockedWebsiteRetirement = await lifecycle("websites", suspendedWebsiteId, "retire", {
      version: "1.2.0",
      reason: "qa blocked website retirement",
      operator: "platform-lifecycle-qa",
    });
    addCheck(
      "retirement dependency validation",
      blockedWebsiteRetirement.response.status === 400 && blockedWebsiteRetirement.json.success === false,
      { status: blockedWebsiteRetirement.response.status, body: blockedWebsiteRetirement.json }
    );

    const suspendedTenant = await lifecycle("tenants", activeTenantId, "suspend", {
      version: "1.2.0",
      reason: "qa suspend tenant before retirement check",
      operator: "platform-lifecycle-qa",
    });
    const suspendedTenantId = requireRecordId(
      suspendedTenant.json,
      "tenant",
      "suspend tenant before retirement check"
    );
    const blockedTenantRetirement = await lifecycle("tenants", suspendedTenantId, "retire", {
      version: "1.3.0",
      reason: "qa blocked tenant retirement",
      operator: "platform-lifecycle-qa",
    });
    addCheck(
      "tenant retirement blocked while active brands exist",
      blockedTenantRetirement.response.status === 400 && blockedTenantRetirement.json.success === false,
      { status: blockedTenantRetirement.response.status, body: blockedTenantRetirement.json }
    );

    const otherOrganizationId = await createOrganization(runId, "other", "Active");
    const otherTenantId = await createTenant(runId, "other", otherOrganizationId, "Active");
    const otherBrandId = await createBrand(runId, "other", otherTenantId, "Active");

    setPlatformManagementAuthOverrideForTesting({
      permissions: ["platform.brand.create"],
      scopes: [{ scopeType: "TENANT", scopeId: activeTenantId }],
    });
    const crossTenantLifecycle = await lifecycle("brands", otherBrandId, "suspend", {
      version: "1.1.0",
      reason: "qa cross tenant denied",
      operator: "platform-lifecycle-qa",
    });
    addCheck(
      "cross-tenant isolation preserved",
      crossTenantLifecycle.response.status === 403 && crossTenantLifecycle.json.success === false,
      { status: crossTenantLifecycle.response.status, body: crossTenantLifecycle.json }
    );

    setPlatformManagementAuthOverrideForTesting({
      permissions: ["platform.brand.read"],
      scopes: [{ scopeType: "TENANT", scopeId: activeTenantId }],
    });
    const missingCreatePermission = await lifecycle("brands", reactivatedBrandId, "suspend", {
      version: "1.5.0",
      reason: "qa missing permission",
      operator: "platform-lifecycle-qa",
    });
    addCheck(
      "permission checks preserved",
      missingCreatePermission.response.status === 403 && missingCreatePermission.json.success === false,
      { status: missingCreatePermission.response.status, body: missingCreatePermission.json }
    );

    addCheck("no update/delete endpoints", !("PATCH" in lifecycleRoute) && !("DELETE" in lifecycleRoute), {});
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
