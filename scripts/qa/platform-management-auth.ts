import { randomUUID } from "node:crypto";

import * as collectionRoute from "../../app/api/platform-management/[resource]/route";
import * as recordRoute from "../../app/api/platform-management/[resource]/[id]/route";
import * as hostRoute from "../../app/api/platform-management/resolve-host/route";
import * as gameAvailabilityRoute from "../../app/api/platform-management/resolve-game-availability/route";
import { setPlatformManagementAuthOverrideForTesting } from "../../src/domains/platform-management/platform-management-auth";

type JsonObject = Record<string, unknown>;

const checks: { name: string; status: "PASS" | "FAIL"; metadata?: JsonObject }[] = [];

function addCheck(name: string, passed: boolean, metadata: JsonObject = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function hash(label: string, runId: string) {
  return `sha256:platform-management-auth:${label}:${runId}`;
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

async function list(resource: string, query = "") {
  const response = await collectionRoute.GET(
    apiRequest(`http://qa.local/api/platform-management/${resource}${query}`),
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

async function seedHierarchy(runId: string) {
  setPlatformManagementAuthOverrideForTesting(["system.admin"]);

  const organization = await create("organizations", {
    code: `auth-org-${runId}`,
    name: "Auth QA Organization",
    status: "Active",
    version: "1.0.0",
    contentHash: hash("organization", runId),
  });
  const organizationId = recordId(organization.json, "organization");

  const tenant = await create("tenants", {
    organizationId,
    code: `auth-tenant-${runId}`,
    name: "Auth QA Tenant",
    status: "Active",
    defaultLanguage: "en",
    defaultCurrency: "USD",
    defaultTimezone: "America/Costa_Rica",
    creditEnabled: true,
    cashierEnabled: false,
    version: "1.0.0",
    contentHash: hash("tenant", runId),
  });
  const tenantId = recordId(tenant.json, "tenant");

  const brand = await create("brands", {
    tenantId,
    code: `auth-brand-${runId}`,
    name: "Auth QA Brand",
    displayName: "Auth QA Brand",
    status: "Active",
    version: "1.0.0",
    contentHash: hash("brand", runId),
  });
  const brandId = recordId(brand.json, "brand");

  const market = await create("markets", {
    brandId,
    code: `auth-market-${runId}`,
    name: "Auth QA Market",
    displayName: "Auth QA Market",
    jurisdiction: null,
    language: "en",
    currency: "USD",
    timezone: "America/Costa_Rica",
    status: "Active",
    version: "1.0.0",
    contentHash: hash("market", runId),
  });
  const marketId = recordId(market.json, "market");

  const website = await create("websites", {
    tenantId,
    brandId,
    marketId,
    code: `auth-site-${runId}`,
    displayName: "Auth QA Website",
    status: "Active",
    defaultLanguage: "en",
    defaultCurrency: "USD",
    defaultTimezone: "America/Costa_Rica",
    maintenanceMode: false,
    version: "1.0.0",
    contentHash: hash("website", runId),
  });
  const websiteId = recordId(website.json, "website");

  const hostname = `auth-${runId}.example.test`;
  await create("domains", {
    websiteId,
    hostname,
    canonical: true,
    status: "Active",
    verificationStatus: "Verified",
    version: "1.0.0",
    contentHash: hash("domain", runId),
  });

  const availability = await create("game-availability", {
    tenantId,
    brandId,
    marketId,
    websiteId,
    gameId: `game:${runId}`,
    gameCode: `auth-game-${runId}`,
    gameManifestReference: null,
    status: "Active",
    version: "1.0.0",
    contentHash: hash("availability", runId),
  });

  return {
    organizationId,
    tenantId,
    brandId,
    marketId,
    websiteId,
    hostname,
    availabilityId: recordId(availability.json, "availability"),
  };
}

async function main() {
  const runId = randomUUID();

  setPlatformManagementAuthOverrideForTesting(null);
  const unauthenticatedCreate = await create("organizations", {
    code: `unauth-org-${runId}`,
    name: "Unauthorized Organization",
  });
  addCheck(
    "unauthenticated create rejected",
    unauthenticatedCreate.response.status === 401 && unauthenticatedCreate.json.success === false,
    { status: unauthenticatedCreate.response.status, body: unauthenticatedCreate.json }
  );

  const unauthenticatedList = await list("organizations");
  addCheck(
    "unauthenticated list rejected",
    unauthenticatedList.response.status === 401 && unauthenticatedList.json.success === false,
    { status: unauthenticatedList.response.status, body: unauthenticatedList.json }
  );

  setPlatformManagementAuthOverrideForTesting(["platform.organization.read"]);
  const forbiddenCreate = await create("organizations", {
    code: `forbidden-org-${runId}`,
    name: "Forbidden Organization",
  });
  addCheck(
    "authenticated without create permission rejected",
    forbiddenCreate.response.status === 403 && forbiddenCreate.json.success === false,
    { status: forbiddenCreate.response.status, body: forbiddenCreate.json }
  );

  setPlatformManagementAuthOverrideForTesting(["system.admin"]);
  const created = await create("organizations", {
    code: `created-org-${runId}`,
    name: "Created Organization",
    status: "Active",
    version: "1.0.0",
    contentHash: hash("created-organization", runId),
  });
  const createdId = recordId(created.json, "organization");
  addCheck(
    "Super Admin can create organization",
    created.response.status === 201 && created.json.success === true && Boolean(createdId),
    { status: created.response.status, body: created.json }
  );

  setPlatformManagementAuthOverrideForTesting({
    permissions: ["platform.organization.read"],
    scopes: [{ scopeType: "ORGANIZATION", scopeId: createdId }],
  });
  const listed = await list("organizations", `?id=${createdId}`);
  const loaded = await get("organizations", createdId);
  const records = Array.isArray(listed.json.records) ? listed.json.records : [];
  addCheck(
    "authenticated with read permission can list",
    listed.response.status === 200 &&
      listed.json.success === true &&
      records.some((record) => typeof record === "object" && record !== null && (record as JsonObject).id === createdId),
    { status: listed.response.status, body: listed.json }
  );
  addCheck(
    "authenticated with read permission can get",
    loaded.response.status === 200 && loaded.json.success === true && Boolean(loaded.json.organization),
    { status: loaded.response.status, body: loaded.json }
  );

  const hierarchy = await seedHierarchy(runId);

  setPlatformManagementAuthOverrideForTesting(null);
  const hostResponse = await hostRoute.GET(
    apiRequest(`http://qa.local/api/platform-management/resolve-host?hostname=${hierarchy.hostname}`)
  );
  const hostJson = await readJson(hostResponse);
  addCheck(
    "resolve-host remains public active routing data",
    hostResponse.status === 200 && hostJson.success === true,
    { status: hostResponse.status, body: hostJson }
  );

  const availabilityUrl =
    `http://qa.local/api/platform-management/resolve-game-availability?tenantId=${hierarchy.tenantId}` +
    `&brandId=${hierarchy.brandId}&marketId=${hierarchy.marketId}&websiteId=${hierarchy.websiteId}`;

  const unauthenticatedAvailability = await gameAvailabilityRoute.GET(apiRequest(availabilityUrl));
  const unauthenticatedAvailabilityJson = await readJson(unauthenticatedAvailability);
  addCheck(
    "resolve-game-availability requires permission",
    unauthenticatedAvailability.status === 401 && unauthenticatedAvailabilityJson.success === false,
    { status: unauthenticatedAvailability.status, body: unauthenticatedAvailabilityJson }
  );

  setPlatformManagementAuthOverrideForTesting({
    permissions: ["platform.game_availability.read"],
    scopes: [{ scopeType: "TENANT", scopeId: hierarchy.tenantId }],
  });
  const availabilityResponse = await gameAvailabilityRoute.GET(apiRequest(availabilityUrl));
  const availabilityJson = await readJson(availabilityResponse);
  const games = Array.isArray(availabilityJson.games) ? availabilityJson.games : [];
  addCheck(
    "resolve-game-availability with read permission succeeds",
    availabilityResponse.status === 200 &&
      availabilityJson.success === true &&
      games.some(
        (game) =>
          typeof game === "object" &&
          game !== null &&
          (game as JsonObject).availabilityId === hierarchy.availabilityId
      ),
    { status: availabilityResponse.status, body: availabilityJson }
  );

  addCheck("update endpoint unavailable", !("PATCH" in collectionRoute) && !("PATCH" in recordRoute));
  addCheck("delete endpoint unavailable", !("DELETE" in collectionRoute) && !("DELETE" in recordRoute));

  setPlatformManagementAuthOverrideForTesting(null);

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
