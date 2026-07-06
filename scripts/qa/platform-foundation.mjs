import { randomUUID } from "node:crypto";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sqlString(value) {
  return value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(queryScalar(sql));
}

function insertOrganizationSql({ id, code, version, contentHash }) {
  return `
insert into platform.organizations (
  id, organization_code, name, status, governance_metadata, global_defaults, version, content_hash, audit_metadata
) values (
  '${id}',
  ${sqlString(code)},
  'Mosera Platform Owner',
  'Active',
  ${sqlJson({ governanceModel: "platform-foundation-v1" })},
  ${sqlJson({ defaultLocale: "en" })},
  ${sqlString(version)},
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:platform-foundation", reason: "P0-006.1" })}
);`;
}

function insertTenantSql({ id, organizationId, code, version, contentHash, cashierEnabled = false }) {
  return `
insert into platform.tenants (
  id, organization_id, tenant_code, name, status, operator_metadata, default_language, default_currency,
  default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata
) values (
  '${id}',
  '${organizationId}',
  ${sqlString(code)},
  'QA Operator Tenant',
  'Active',
  ${sqlJson({ operatorType: "internal-qa" })},
  'en',
  'USD',
  'America/Costa_Rica',
  true,
  ${cashierEnabled ? "true" : "false"},
  ${sqlString(version)},
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:platform-foundation", reason: "P0-006.1" })}
);`;
}

function insertBrandSql({ id, tenantId, code, version, contentHash }) {
  return `
insert into platform.brands (
  id, tenant_id, brand_code, name, display_name, status, theme_reference_placeholder,
  asset_reference_placeholder, website_reference_placeholder, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  ${sqlString(code)},
  'QA Brand',
  'QA Brand',
  'Active',
  ${sqlJson({ deferred: true })},
  ${sqlJson({ deferred: true })},
  ${sqlJson([])},
  ${sqlString(version)},
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:platform-foundation", reason: "P0-006.1" })}
);`;
}

function insertMarketSql({ id, brandId, code, version, contentHash, country = null, jurisdiction = null }) {
  return `
insert into platform.markets (
  id, brand_id, market_code, name, display_name, country, jurisdiction, language, currency,
  timezone, future_game_availability_placeholder, status, version, content_hash, audit_metadata
) values (
  '${id}',
  '${brandId}',
  ${sqlString(code)},
  'QA Market',
  'QA Market',
  ${sqlString(country)},
  ${sqlString(jurisdiction)},
  'en',
  'USD',
  'America/Costa_Rica',
  ${sqlJson({ deferred: true })},
  'Active',
  ${sqlString(version)},
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:platform-foundation", reason: "P0-006.1" })}
);`;
}

const runId = randomUUID();
const organizationId = randomUUID();
const tenantId = randomUUID();
const brandId = randomUUID();
const marketId = randomUUID();
const organizationCode = `org-${runId}`;
const tenantCode = `tenant-${runId}`;
const brandCode = `brand-${runId}`;
const marketCode = `market-${runId}`;
const version = "1.0.0";

addCheck("platform schema exists", queryScalar("select exists(select 1 from information_schema.schemata where schema_name = 'platform');") === "t");
addCheck("organizations table exists", existsRegclass("platform.organizations"));
addCheck("tenants table exists", existsRegclass("platform.tenants"));
addCheck("brands table exists", existsRegclass("platform.brands"));
addCheck("markets table exists", existsRegclass("platform.markets"));

runSql(insertOrganizationSql({
  id: organizationId,
  code: organizationCode,
  version,
  contentHash: `sha256:p0-006-1-organization:${runId}`,
}));
addCheck("organization creation persists", rowCount(`
select count(*) from platform.organizations
where id = '${organizationId}' and organization_code = ${sqlString(organizationCode)} and status = 'Active';
`) === 1, { organizationId });

runSql(insertTenantSql({
  id: tenantId,
  organizationId,
  code: tenantCode,
  version,
  contentHash: `sha256:p0-006-1-tenant:${runId}`,
  cashierEnabled: false,
}));
addCheck("tenant creation persists", rowCount(`
select count(*) from platform.tenants
where id = '${tenantId}' and organization_id = '${organizationId}' and tenant_code = ${sqlString(tenantCode)};
`) === 1, { tenantId });

addCheck("cashier disabled allowed", rowCount(`
select count(*) from platform.tenants
where id = '${tenantId}' and credit_enabled = true and cashier_enabled = false;
`) === 1, { tenantId });

runSql(insertBrandSql({
  id: brandId,
  tenantId,
  code: brandCode,
  version,
  contentHash: `sha256:p0-006-1-brand:${runId}`,
}));
addCheck("brand creation persists", rowCount(`
select count(*) from platform.brands
where id = '${brandId}' and tenant_id = '${tenantId}' and brand_code = ${sqlString(brandCode)};
`) === 1, { brandId });

runSql(insertMarketSql({
  id: marketId,
  brandId,
  code: marketCode,
  version,
  contentHash: `sha256:p0-006-1-market:${runId}`,
}));
addCheck("market creation persists", rowCount(`
select count(*) from platform.markets
where id = '${marketId}' and brand_id = '${brandId}' and market_code = ${sqlString(marketCode)};
`) === 1, { marketId });

addCheck("optional jurisdiction allowed", rowCount(`
select count(*) from platform.markets
where id = '${marketId}' and jurisdiction is null and country is null;
`) === 1, { marketId });

const duplicateTenant = runSql(insertTenantSql({
  id: randomUUID(),
  organizationId,
  code: tenantCode,
  version,
  contentHash: `sha256:p0-006-1-duplicate-tenant:${runId}`,
}), { allowFailure: true });
addCheck("duplicate tenant code within parent/version rejected", duplicateTenant.status !== 0, {
  stderr: duplicateTenant.stderr.trim(),
});

const duplicateBrand = runSql(insertBrandSql({
  id: randomUUID(),
  tenantId,
  code: brandCode,
  version,
  contentHash: `sha256:p0-006-1-duplicate-brand:${runId}`,
}), { allowFailure: true });
addCheck("duplicate brand code within parent/version rejected", duplicateBrand.status !== 0, {
  stderr: duplicateBrand.stderr.trim(),
});

const duplicateMarket = runSql(insertMarketSql({
  id: randomUUID(),
  brandId,
  code: marketCode,
  version,
  contentHash: `sha256:p0-006-1-duplicate-market:${runId}`,
}), { allowFailure: true });
addCheck("duplicate market code within parent/version rejected", duplicateMarket.status !== 0, {
  stderr: duplicateMarket.stderr.trim(),
});

const invalidTenantParent = runSql(insertTenantSql({
  id: randomUUID(),
  organizationId: randomUUID(),
  code: `${tenantCode}-invalid-parent`,
  version,
  contentHash: `sha256:p0-006-1-invalid-tenant-parent:${runId}`,
}), { allowFailure: true });
addCheck("hierarchy validation rejects tenant without organization", invalidTenantParent.status !== 0, {
  stderr: invalidTenantParent.stderr.trim(),
});

const invalidBrandParent = runSql(insertBrandSql({
  id: randomUUID(),
  tenantId: randomUUID(),
  code: `${brandCode}-invalid-parent`,
  version,
  contentHash: `sha256:p0-006-1-invalid-brand-parent:${runId}`,
}), { allowFailure: true });
addCheck("hierarchy validation rejects brand without tenant", invalidBrandParent.status !== 0, {
  stderr: invalidBrandParent.stderr.trim(),
});

const invalidMarketParent = runSql(insertMarketSql({
  id: randomUUID(),
  brandId: randomUUID(),
  code: `${marketCode}-invalid-parent`,
  version,
  contentHash: `sha256:p0-006-1-invalid-market-parent:${runId}`,
}), { allowFailure: true });
addCheck("hierarchy validation rejects market without brand", invalidMarketParent.status !== 0, {
  stderr: invalidMarketParent.stderr.trim(),
});

const updateAttempt = runSql(`
update platform.organizations
set name = 'Changed'
where id = '${organizationId}';
`, { allowFailure: true });
addCheck("append-only update enforcement", updateAttempt.status !== 0, { stderr: updateAttempt.stderr.trim() });

const deleteAttempt = runSql(`
delete from platform.markets
where id = '${marketId}';
`, { allowFailure: true });
addCheck("append-only delete enforcement", deleteAttempt.status !== 0, { stderr: deleteAttempt.stderr.trim() });

const requiredIndexes = [
  "idx_platform_organizations_code",
  "idx_platform_tenants_parent_code",
  "idx_platform_brands_parent_code",
  "idx_platform_markets_parent_code",
  "idx_platform_markets_country_jurisdiction",
];
for (const indexName of requiredIndexes) {
  addCheck(`lookup index exists:${indexName}`, existsRegclass(`platform.${indexName}`));
}

addCheck("lookup by hierarchy code returns expected market", rowCount(`
select count(*)
from platform.organizations o
join platform.tenants t on t.organization_id = o.id
join platform.brands b on b.tenant_id = t.id
join platform.markets m on m.brand_id = b.id
where o.organization_code = ${sqlString(organizationCode)}
  and t.tenant_code = ${sqlString(tenantCode)}
  and b.brand_code = ${sqlString(brandCode)}
  and m.market_code = ${sqlString(marketCode)};
`) === 1, { organizationCode, tenantCode, brandCode, marketCode });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failed.length,
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
