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

function insertOrganizationSql({ id, code, contentHash }) {
  return `
insert into platform.organizations (
  id, organization_code, name, status, governance_metadata, global_defaults, version, content_hash, audit_metadata
) values (
  '${id}',
  ${sqlString(code)},
  'Website QA Organization',
  'Active',
  ${sqlJson({ governanceModel: "website-domain-foundation-v1" })},
  ${sqlJson({ defaultLocale: "en" })},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:website-domain-management", reason: "P0-006.2" })}
);`;
}

function insertTenantSql({ id, organizationId, code, contentHash }) {
  return `
insert into platform.tenants (
  id, organization_id, tenant_code, name, status, operator_metadata, default_language, default_currency,
  default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata
) values (
  '${id}',
  '${organizationId}',
  ${sqlString(code)},
  'Website QA Tenant',
  'Active',
  ${sqlJson({ operatorType: "internal-qa" })},
  'en',
  'USD',
  'America/Costa_Rica',
  true,
  false,
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:website-domain-management", reason: "P0-006.2" })}
);`;
}

function insertBrandSql({ id, tenantId, code, contentHash, status = "Active" }) {
  return `
insert into platform.brands (
  id, tenant_id, brand_code, name, display_name, status, theme_reference_placeholder,
  asset_reference_placeholder, website_reference_placeholder, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  ${sqlString(code)},
  'Website QA Brand',
  'Website QA Brand',
  ${sqlString(status)},
  ${sqlJson({ deferred: true })},
  ${sqlJson({ deferred: true })},
  ${sqlJson([])},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:website-domain-management", reason: "P0-006.2" })}
);`;
}

function insertMarketSql({ id, brandId, code, contentHash, status = "Active" }) {
  return `
insert into platform.markets (
  id, brand_id, market_code, name, display_name, country, jurisdiction, language, currency,
  timezone, future_game_availability_placeholder, status, version, content_hash, audit_metadata
) values (
  '${id}',
  '${brandId}',
  ${sqlString(code)},
  'Website QA Market',
  'Website QA Market',
  null,
  null,
  'en',
  'USD',
  'America/Costa_Rica',
  ${sqlJson({ deferred: true })},
  ${sqlString(status)},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:website-domain-management", reason: "P0-006.2" })}
);`;
}

function insertWebsiteSql({
  id,
  tenantId,
  brandId,
  marketId = null,
  code,
  contentHash,
  status = "Active",
  maintenanceMode = false,
}) {
  return `
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status, default_language,
  default_currency, default_timezone, maintenance_mode, future_theme_reference_placeholder,
  future_homepage_config_placeholder, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  '${brandId}',
  ${marketId === null ? "null" : `'${marketId}'`},
  ${sqlString(code)},
  'Website QA Site',
  ${sqlString(status)},
  'en',
  'USD',
  'America/Costa_Rica',
  ${maintenanceMode ? "true" : "false"},
  ${sqlJson({ deferred: true })},
  ${sqlJson({ deferred: true })},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:website-domain-management", reason: "P0-006.2" })}
);`;
}

function insertDomainSql({
  id,
  websiteId,
  hostname,
  contentHash,
  canonical = false,
  status = "Active",
  verificationStatus = "Verified",
}) {
  return `
insert into platform.website_domains (
  id, website_id, hostname, canonical, status, verification_status, tls_mode_placeholder,
  cloudflare_proxy_metadata_placeholder, effective_from, effective_to, version, content_hash, audit_metadata
) values (
  '${id}',
  '${websiteId}',
  ${sqlString(hostname)},
  ${canonical ? "true" : "false"},
  ${sqlString(status)},
  ${sqlString(verificationStatus)},
  ${sqlJson({ mode: "placeholder" })},
  ${sqlJson({ provider: "cloudflare-placeholder" })},
  now() - interval '1 minute',
  null,
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:website-domain-management", reason: "P0-006.2" })}
);`;
}

const runId = randomUUID();
const organizationId = randomUUID();
const tenantId = randomUUID();
const brandId = randomUUID();
const marketId = randomUUID();
const websiteId = randomUUID();
const maintenanceWebsiteId = randomUUID();
const suspendedWebsiteId = randomUUID();
const canonicalDomainId = randomUUID();
const aliasDomainId = randomUUID();
const maintenanceDomainId = randomUUID();
const suspendedDomainId = randomUUID();
const websiteCode = `site-${runId}`;
const baseHostname = `p0-006-2-${runId}.example.test`;
const aliasHostname = `alias-p0-006-2-${runId}.example.test`;
const maintenanceHostname = `maintenance-p0-006-2-${runId}.example.test`;
const suspendedHostname = `suspended-p0-006-2-${runId}.example.test`;

addCheck("websites table exists", existsRegclass("platform.websites"));
addCheck("website domains table exists", existsRegclass("platform.website_domains"));
addCheck("active host resolution view exists", existsRegclass("platform.active_host_resolutions"));

runSql(insertOrganizationSql({
  id: organizationId,
  code: `org-web-${runId}`,
  contentHash: `sha256:p0-006-2-org:${runId}`,
}));
runSql(insertTenantSql({
  id: tenantId,
  organizationId,
  code: `tenant-web-${runId}`,
  contentHash: `sha256:p0-006-2-tenant:${runId}`,
}));
runSql(insertBrandSql({
  id: brandId,
  tenantId,
  code: `brand-web-${runId}`,
  contentHash: `sha256:p0-006-2-brand:${runId}`,
}));
runSql(insertMarketSql({
  id: marketId,
  brandId,
  code: `market-web-${runId}`,
  contentHash: `sha256:p0-006-2-market:${runId}`,
}));

runSql(insertWebsiteSql({
  id: websiteId,
  tenantId,
  brandId,
  marketId: null,
  code: websiteCode,
  contentHash: `sha256:p0-006-2-website:${runId}`,
}));
addCheck("create website", rowCount(`
select count(*) from platform.websites
where id = '${websiteId}' and tenant_id = '${tenantId}' and brand_id = '${brandId}' and website_code = ${sqlString(websiteCode)};
`) === 1, { websiteId });

addCheck("website without market allowed", rowCount(`
select count(*) from platform.websites
where id = '${websiteId}' and market_id is null;
`) === 1, { websiteId });

runSql(insertDomainSql({
  id: canonicalDomainId,
  websiteId,
  hostname: baseHostname,
  canonical: true,
  contentHash: `sha256:p0-006-2-domain-canonical:${runId}`,
}));
addCheck("create domain", rowCount(`
select count(*) from platform.website_domains
where id = '${canonicalDomainId}' and website_id = '${websiteId}' and hostname = ${sqlString(baseHostname)} and canonical = true;
`) === 1, { canonicalDomainId });

runSql(insertDomainSql({
  id: aliasDomainId,
  websiteId,
  hostname: aliasHostname,
  canonical: false,
  contentHash: `sha256:p0-006-2-domain-alias:${runId}`,
}));

const duplicateHostname = runSql(insertDomainSql({
  id: randomUUID(),
  websiteId,
  hostname: baseHostname,
  contentHash: `sha256:p0-006-2-duplicate-hostname:${runId}`,
}), { allowFailure: true });
addCheck("duplicate hostname rejected", duplicateHostname.status !== 0, { stderr: duplicateHostname.stderr.trim() });

const duplicateCanonical = runSql(insertDomainSql({
  id: randomUUID(),
  websiteId,
  hostname: `second-canonical-p0-006-2-${runId}.example.test`,
  canonical: true,
  contentHash: `sha256:p0-006-2-duplicate-canonical:${runId}`,
}), { allowFailure: true });
addCheck("duplicate canonical domain rejected", duplicateCanonical.status !== 0, { stderr: duplicateCanonical.stderr.trim() });

const duplicateWebsiteCode = runSql(insertWebsiteSql({
  id: randomUUID(),
  tenantId,
  brandId,
  marketId,
  code: websiteCode,
  contentHash: `sha256:p0-006-2-duplicate-website:${runId}`,
}), { allowFailure: true });
addCheck("duplicate website code within brand rejected", duplicateWebsiteCode.status !== 0, {
  stderr: duplicateWebsiteCode.stderr.trim(),
});

addCheck("active host resolves correctly", rowCount(`
select count(*) from platform.active_host_resolutions
where hostname = ${sqlString(baseHostname)}
  and tenant_id = '${tenantId}'
  and brand_id = '${brandId}'
  and market_id is null
  and website_id = '${websiteId}'
  and canonical = true
  and canonical_redirect_target is null
  and maintenance_mode = false;
`) === 1, { baseHostname });

addCheck("alias host resolves with canonical redirect target", rowCount(`
select count(*) from platform.active_host_resolutions
where hostname = ${sqlString(aliasHostname)}
  and website_id = '${websiteId}'
  and canonical = false
  and canonical_redirect_target = ${sqlString(baseHostname)};
`) === 1, { aliasHostname, baseHostname });

runSql(insertWebsiteSql({
  id: maintenanceWebsiteId,
  tenantId,
  brandId,
  marketId,
  code: `maintenance-site-${runId}`,
  contentHash: `sha256:p0-006-2-website-maintenance:${runId}`,
  maintenanceMode: true,
}));
runSql(insertDomainSql({
  id: maintenanceDomainId,
  websiteId: maintenanceWebsiteId,
  hostname: maintenanceHostname,
  canonical: true,
  contentHash: `sha256:p0-006-2-domain-maintenance:${runId}`,
}));
addCheck("maintenance mode is returned in resolution", rowCount(`
select count(*) from platform.active_host_resolutions
where hostname = ${sqlString(maintenanceHostname)}
  and maintenance_mode = true;
`) === 1, { maintenanceHostname });

runSql(insertWebsiteSql({
  id: suspendedWebsiteId,
  tenantId,
  brandId,
  marketId,
  code: `suspended-site-${runId}`,
  contentHash: `sha256:p0-006-2-website-suspended:${runId}`,
  status: "Suspended",
}));
runSql(insertDomainSql({
  id: suspendedDomainId,
  websiteId: suspendedWebsiteId,
  hostname: suspendedHostname,
  canonical: true,
  contentHash: `sha256:p0-006-2-domain-suspended:${runId}`,
}));
addCheck("suspended host does not resolve as active", rowCount(`
select count(*) from platform.active_host_resolutions
where hostname = ${sqlString(suspendedHostname)};
`) === 0, { suspendedHostname });

const retiredDomainId = randomUUID();
const retiredHostname = `retired-p0-006-2-${runId}.example.test`;
runSql(insertDomainSql({
  id: retiredDomainId,
  websiteId: maintenanceWebsiteId,
  hostname: retiredHostname,
  canonical: false,
  status: "Retired",
  contentHash: `sha256:p0-006-2-domain-retired:${runId}`,
}));
addCheck("retired host does not resolve as active", rowCount(`
select count(*) from platform.active_host_resolutions
where hostname = ${sqlString(retiredHostname)};
`) === 0, { retiredHostname });

const invalidBrandTenant = runSql(insertWebsiteSql({
  id: randomUUID(),
  tenantId: randomUUID(),
  brandId,
  code: `wrong-tenant-${runId}`,
  contentHash: `sha256:p0-006-2-wrong-tenant:${runId}`,
}), { allowFailure: true });
addCheck("website tenant must match brand tenant", invalidBrandTenant.status !== 0, {
  stderr: invalidBrandTenant.stderr.trim(),
});

const updateAttempt = runSql(`
update platform.websites
set display_name = 'Changed'
where id = '${websiteId}';
`, { allowFailure: true });
addCheck("website update blocked", updateAttempt.status !== 0, { stderr: updateAttempt.stderr.trim() });

const deleteAttempt = runSql(`
delete from platform.website_domains
where id = '${aliasDomainId}';
`, { allowFailure: true });
addCheck("domain delete blocked", deleteAttempt.status !== 0, { stderr: deleteAttempt.stderr.trim() });

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
