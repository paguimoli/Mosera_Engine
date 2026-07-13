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
  return `sha256:platform-management-api:${label}:${runId}`;
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
  const json = await readJson(response);
  return { response, json };
}

async function list(resource: string, query = "") {
  const response = await collectionRoute.GET(
    apiRequest(`http://qa.local/api/platform-management/${resource}${query}`),
    collectionParams(resource)
  );
  const json = await readJson(response);
  return { response, json };
}

async function get(resource: string, id: string) {
  const response = await recordRoute.GET(
    apiRequest(`http://qa.local/api/platform-management/${resource}/${id}`),
    recordParams(resource, id)
  );
  const json = await readJson(response);
  return { response, json };
}

function recordId(json: JsonObject, key: string) {
  const record = json[key] as JsonObject | undefined;
  return typeof record?.id === "string" ? record.id : "";
}

async function main() {
setPlatformManagementAuthOverrideForTesting(["system.admin"]);

const runId = randomUUID();

const organization = await create("organizations", {
  code: `api-org-${runId}`,
  name: "API QA Organization",
  status: "Active",
  governanceMetadata: { governanceModel: "platform-management-api-v1" },
  globalDefaults: { defaultLanguage: "en" },
  version: "1.0.0",
  contentHash: hash("organization", runId),
});
addCheck("create organization", organization.response.status === 201 && organization.json.success === true, {
  status: organization.response.status,
  body: organization.json,
});
const organizationId = recordId(organization.json, "organization");

const tenant = await create("tenants", {
  organizationId,
  code: `api-tenant-${runId}`,
  name: "API QA Tenant",
  status: "Active",
  operatorMetadata: { operatorType: "qa" },
  defaultLanguage: "en",
  defaultCurrency: "USD",
  defaultTimezone: "America/Costa_Rica",
  creditEnabled: true,
  cashierEnabled: false,
  version: "1.0.0",
  contentHash: hash("tenant", runId),
});
addCheck("create tenant with cashier disabled allowed", tenant.response.status === 201 && tenant.json.success === true, {
  status: tenant.response.status,
  body: tenant.json,
});
const tenantId = recordId(tenant.json, "tenant");

const brand = await create("brands", {
  tenantId,
  code: `api-brand-${runId}`,
  name: "API QA Brand",
  displayName: "API QA Brand",
  status: "Active",
  version: "1.0.0",
  contentHash: hash("brand", runId),
});
addCheck("create brand", brand.response.status === 201 && brand.json.success === true, {
  status: brand.response.status,
  body: brand.json,
});
const brandId = recordId(brand.json, "brand");

const market = await create("markets", {
  brandId,
  code: `api-market-${runId}`,
  name: "API QA Market",
  displayName: "API QA Market",
  country: null,
  jurisdiction: null,
  language: "en",
  currency: "USD",
  timezone: "America/Costa_Rica",
  status: "Active",
  version: "1.0.0",
  contentHash: hash("market", runId),
});
addCheck("create market with optional jurisdiction", market.response.status === 201 && market.json.success === true, {
  status: market.response.status,
  body: market.json,
});
const marketId = recordId(market.json, "market");

const website = await create("websites", {
  tenantId,
  brandId,
  marketId,
  code: `api-site-${runId}`,
  displayName: "API QA Website",
  status: "Active",
  defaultLanguage: "en",
  defaultCurrency: "USD",
  defaultTimezone: "America/Costa_Rica",
  maintenanceMode: false,
  version: "1.0.0",
  contentHash: hash("website", runId),
});
addCheck("create website", website.response.status === 201 && website.json.success === true, {
  status: website.response.status,
  body: website.json,
});
const websiteId = recordId(website.json, "website");

const hostname = `api-${runId}.example.test`;
const domain = await create("domains", {
  websiteId,
  hostname,
  canonical: true,
  status: "Active",
  verificationStatus: "Verified",
  tlsMode: { mode: "managed-placeholder" },
  version: "1.0.0",
  contentHash: hash("domain", runId),
});
addCheck("create domain", domain.response.status === 201 && domain.json.success === true, {
  status: domain.response.status,
  body: domain.json,
});

const theme = await create("themes", {
  tenantId,
  brandId,
  code: `api-theme-${runId}`,
  displayName: "API QA Theme",
  status: "Active",
  isDefault: true,
  colorTokens: { primary: "#123456" },
  typographyTokens: { body: "system" },
  spacingRadiusTokens: { radius: 4 },
  componentTokenPlaceholders: {},
  modeSupport: ["light", "dark"],
  version: "1.0.0",
  contentHash: hash("theme", runId),
});
addCheck("create theme", theme.response.status === 201 && theme.json.success === true, {
  status: theme.response.status,
  body: theme.json,
});

const asset = await create("brand-assets", {
  tenantId,
  brandId,
  assetType: "LOGO",
  assetKey: `api-logo-${runId}`,
  storageReference: { uri: `object://qa/${runId}/logo.svg` },
  mimeType: "image/svg+xml",
  assetChecksumHash: hash("asset-checksum", runId),
  status: "Active",
  version: "1.0.0",
  contentHash: hash("asset", runId),
});
addCheck("create brand asset", asset.response.status === 201 && asset.json.success === true, {
  status: asset.response.status,
  body: asset.json,
});

const availability = await create("game-availability", {
  tenantId,
  brandId,
  marketId,
  websiteId,
  gameId: `game:${runId}`,
  gameCode: `api-game-${runId}`,
  gameManifestReference: null,
  status: "Active",
  minWagerOverride: 1,
  maxWagerOverride: 100,
  version: "1.0.0",
  contentHash: hash("availability", runId),
});
addCheck("create game availability with optional manifest", availability.response.status === 201 && availability.json.success === true, {
  status: availability.response.status,
  body: availability.json,
});
const availabilityId = recordId(availability.json, "availability");

for (const [resource, key, id] of [
  ["organizations", "organization", organizationId],
  ["tenants", "tenant", tenantId],
  ["brands", "brand", brandId],
  ["markets", "market", marketId],
  ["websites", "website", websiteId],
  ["domains", "domain", recordId(domain.json, "domain")],
  ["themes", "theme", recordId(theme.json, "theme")],
  ["brand-assets", "asset", recordId(asset.json, "asset")],
  ["game-availability", "availability", availabilityId],
] as const) {
  const listed = await list(resource, `?limit=10&id=${id}`);
  const loaded = await get(resource, id);

  const records = Array.isArray(listed.json.records) ? listed.json.records : [];

  addCheck(
    `list ${resource}`,
    listed.response.status === 200 &&
      listed.json.success === true &&
      records.some((record) => typeof record === "object" && record !== null && (record as JsonObject).id === id),
    {
    status: listed.response.status,
    body: listed.json,
    }
  );
  addCheck(`get ${resource}`, loaded.response.status === 200 && loaded.json.success === true && Boolean(loaded.json[key]), {
    status: loaded.response.status,
    body: loaded.json,
  });
}

const hostResponse = await hostRoute.GET(
  apiRequest(`http://qa.local/api/platform-management/resolve-host?hostname=${hostname}`)
);
const hostJson = await readJson(hostResponse);
addCheck("host resolution endpoint works", hostResponse.status === 200 && hostJson.success === true, {
  status: hostResponse.status,
  body: hostJson,
});

const availabilityResponse = await gameAvailabilityRoute.GET(
  apiRequest(
    `http://qa.local/api/platform-management/resolve-game-availability?tenantId=${tenantId}&brandId=${brandId}&marketId=${marketId}&websiteId=${websiteId}`
  )
);
const availabilityJson = await readJson(availabilityResponse);
const games = Array.isArray(availabilityJson.games) ? availabilityJson.games : [];
addCheck(
  "game availability resolution endpoint works",
  availabilityResponse.status === 200 &&
    availabilityJson.success === true &&
    games.some((game) => typeof game === "object" && game !== null && (game as JsonObject).availabilityId === availabilityId),
  { status: availabilityResponse.status, body: availabilityJson }
);

addCheck("update endpoint unavailable", !("PATCH" in collectionRoute) && !("PATCH" in recordRoute));
addCheck("delete endpoint unavailable", !("DELETE" in collectionRoute) && !("DELETE" in recordRoute));

const invalidWebsite = await create("websites", {
  tenantId: randomUUID(),
  brandId,
  code: `invalid-api-site-${runId}`,
  displayName: "Invalid API QA Website",
  status: "Active",
  defaultLanguage: "en",
  defaultCurrency: "USD",
  defaultTimezone: "UTC",
  version: "1.0.0",
  contentHash: hash("invalid-website", runId),
});
addCheck("invalid hierarchy rejected", invalidWebsite.response.status === 400 && invalidWebsite.json.success === false, {
  status: invalidWebsite.response.status,
  body: invalidWebsite.json,
});

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

setPlatformManagementAuthOverrideForTesting(null);
}

main().catch((error: unknown) => {
  setPlatformManagementAuthOverrideForTesting(null);
  console.error(JSON.stringify({
    status: "FAIL",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
