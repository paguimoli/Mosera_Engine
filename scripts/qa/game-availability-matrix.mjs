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
  'Availability QA Organization',
  'Active',
  ${sqlJson({ governanceModel: "game-availability-matrix-v1" })},
  ${sqlJson({ defaultLocale: "en" })},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:game-availability-matrix", reason: "P0-006.4" })}
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
  'Availability QA Tenant',
  'Active',
  ${sqlJson({ operatorType: "internal-qa" })},
  'en',
  'USD',
  'America/Costa_Rica',
  true,
  false,
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:game-availability-matrix", reason: "P0-006.4" })}
);`;
}

function insertBrandSql({ id, tenantId, code, contentHash }) {
  return `
insert into platform.brands (
  id, tenant_id, brand_code, name, display_name, status, theme_reference_placeholder,
  asset_reference_placeholder, website_reference_placeholder, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  ${sqlString(code)},
  'Availability QA Brand',
  'Availability QA Brand',
  'Active',
  ${sqlJson({ deferred: true })},
  ${sqlJson({ deferred: true })},
  ${sqlJson([])},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:game-availability-matrix", reason: "P0-006.4" })}
);`;
}

function insertMarketSql({ id, brandId, code, contentHash }) {
  return `
insert into platform.markets (
  id, brand_id, market_code, name, display_name, country, jurisdiction, language, currency,
  timezone, future_game_availability_placeholder, status, version, content_hash, audit_metadata
) values (
  '${id}',
  '${brandId}',
  ${sqlString(code)},
  'Availability QA Market',
  'Availability QA Market',
  null,
  null,
  'en',
  'USD',
  'America/Costa_Rica',
  ${sqlJson({ deferred: true })},
  'Active',
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:game-availability-matrix", reason: "P0-006.4" })}
);`;
}

function insertWebsiteSql({ id, tenantId, brandId, marketId, code, contentHash }) {
  return `
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status, default_language,
  default_currency, default_timezone, maintenance_mode, future_theme_reference_placeholder,
  future_homepage_config_placeholder, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  '${brandId}',
  '${marketId}',
  ${sqlString(code)},
  'Availability QA Website',
  'Active',
  'en',
  'USD',
  'America/Costa_Rica',
  false,
  ${sqlJson({ deferred: true })},
  ${sqlJson({ deferred: true })},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:game-availability-matrix", reason: "P0-006.4" })}
);`;
}

function insertAvailabilitySql({
  id,
  tenantId,
  brandId,
  marketId = null,
  websiteId = null,
  agentId = null,
  gameId,
  gameCode,
  status = "Active",
  version = "1.0.0",
  contentHash,
  gameManifestReference = null,
  minWagerOverride = null,
  maxWagerOverride = null,
  languageOverride = null,
  currencyOverride = null,
  timezoneOverride = null,
}) {
  return `
insert into platform.game_availability (
  id, tenant_id, brand_id, market_id, website_id, agent_id, game_id, game_code,
  game_manifest_reference, jurisdiction, status, effective_from, effective_to,
  min_wager_override, max_wager_override, language_override, currency_override,
  timezone_override, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  '${brandId}',
  ${marketId === null ? "null" : `'${marketId}'`},
  ${websiteId === null ? "null" : `'${websiteId}'`},
  ${sqlString(agentId)},
  ${sqlString(gameId)},
  ${sqlString(gameCode)},
  ${sqlString(gameManifestReference)},
  null,
  ${sqlString(status)},
  now() - interval '1 minute',
  null,
  ${minWagerOverride === null ? "null" : minWagerOverride},
  ${maxWagerOverride === null ? "null" : maxWagerOverride},
  ${sqlString(languageOverride)},
  ${sqlString(currencyOverride)},
  ${sqlString(timezoneOverride)},
  ${sqlString(version)},
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:game-availability-matrix", reason: "P0-006.4" })}
);`;
}

const runId = randomUUID();
const organizationId = randomUUID();
const tenantId = randomUUID();
const brandId = randomUUID();
const marketId = randomUUID();
const websiteId = randomUUID();
const brandAvailabilityId = randomUUID();
const marketAvailabilityId = randomUUID();
const websiteAvailabilityId = randomUUID();
const gameId = `game:${runId}`;
const gameCode = `game-${runId}`;

addCheck("game availability table exists", existsRegclass("platform.game_availability"));
addCheck("game availability resolver exists", queryScalar(`
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'platform' and p.proname = 'resolve_game_availability'
);
`) === "t");

runSql(insertOrganizationSql({
  id: organizationId,
  code: `org-availability-${runId}`,
  contentHash: `sha256:p0-006-4-org:${runId}`,
}));
runSql(insertTenantSql({
  id: tenantId,
  organizationId,
  code: `tenant-availability-${runId}`,
  contentHash: `sha256:p0-006-4-tenant:${runId}`,
}));
runSql(insertBrandSql({
  id: brandId,
  tenantId,
  code: `brand-availability-${runId}`,
  contentHash: `sha256:p0-006-4-brand:${runId}`,
}));
runSql(insertMarketSql({
  id: marketId,
  brandId,
  code: `market-availability-${runId}`,
  contentHash: `sha256:p0-006-4-market:${runId}`,
}));
runSql(insertWebsiteSql({
  id: websiteId,
  tenantId,
  brandId,
  marketId,
  code: `website-availability-${runId}`,
  contentHash: `sha256:p0-006-4-website:${runId}`,
}));

runSql(insertAvailabilitySql({
  id: brandAvailabilityId,
  tenantId,
  brandId,
  gameId,
  gameCode,
  contentHash: `sha256:p0-006-4-brand-availability:${runId}`,
  maxWagerOverride: 100,
}));
addCheck("create brand-level availability", rowCount(`
select count(*) from platform.game_availability
where id = '${brandAvailabilityId}' and market_id is null and website_id is null and agent_id is null and status = 'Active';
`) === 1, { brandAvailabilityId });

addCheck("optional game manifest allowed", rowCount(`
select count(*) from platform.game_availability
where id = '${brandAvailabilityId}' and game_manifest_reference is null;
`) === 1, { brandAvailabilityId });

runSql(insertAvailabilitySql({
  id: marketAvailabilityId,
  tenantId,
  brandId,
  marketId,
  gameId,
  gameCode,
  version: "1.1.0",
  contentHash: `sha256:p0-006-4-market-availability:${runId}`,
  minWagerOverride: 5,
  maxWagerOverride: 50,
  languageOverride: "es",
}));
addCheck("create market-level override", rowCount(`
select count(*) from platform.game_availability
where id = '${marketAvailabilityId}' and market_id = '${marketId}' and website_id is null and status = 'Active';
`) === 1, { marketAvailabilityId });

runSql(insertAvailabilitySql({
  id: websiteAvailabilityId,
  tenantId,
  brandId,
  marketId,
  websiteId,
  gameId,
  gameCode,
  status: "Suspended",
  version: "1.2.0",
  contentHash: `sha256:p0-006-4-website-availability:${runId}`,
}));
addCheck("create website-level override", rowCount(`
select count(*) from platform.game_availability
where id = '${websiteAvailabilityId}' and website_id = '${websiteId}' and status = 'Suspended';
`) === 1, { websiteAvailabilityId });

addCheck("brand resolution returns inherited active game", rowCount(`
select count(*) from platform.resolve_game_availability('${tenantId}', '${brandId}', null, null, null)
where availability_id = '${brandAvailabilityId}' and is_available = true and specificity_rank = 2;
`) === 1, { brandAvailabilityId });

addCheck("resolution precedence works", rowCount(`
select count(*) from platform.resolve_game_availability('${tenantId}', '${brandId}', '${marketId}', null, null)
where availability_id = '${marketAvailabilityId}' and is_available = true and specificity_rank = 3 and min_wager_override = 5;
`) === 1, { marketAvailabilityId });

addCheck("suspended specific scope disables inherited active game", rowCount(`
select count(*) from platform.resolve_game_availability('${tenantId}', '${brandId}', '${marketId}', '${websiteId}', null)
where availability_id = '${websiteAvailabilityId}' and is_available = false and status = 'Suspended' and specificity_rank = 4;
`) === 1, { websiteAvailabilityId });

const invalidTenantBrand = runSql(insertAvailabilitySql({
  id: randomUUID(),
  tenantId: randomUUID(),
  brandId,
  gameId,
  gameCode: `invalid-${gameCode}`,
  contentHash: `sha256:p0-006-4-invalid-tenant-brand:${runId}`,
}), { allowFailure: true });
addCheck("invalid tenant/brand hierarchy rejected", invalidTenantBrand.status !== 0, {
  stderr: invalidTenantBrand.stderr.trim(),
});

const invalidMarketBrand = runSql(insertAvailabilitySql({
  id: randomUUID(),
  tenantId,
  brandId,
  marketId: randomUUID(),
  gameId,
  gameCode: `invalid-market-${gameCode}`,
  contentHash: `sha256:p0-006-4-invalid-market-brand:${runId}`,
}), { allowFailure: true });
addCheck("invalid market hierarchy rejected", invalidMarketBrand.status !== 0, {
  stderr: invalidMarketBrand.stderr.trim(),
});

const updateAttempt = runSql(`
update platform.game_availability
set status = 'Retired'
where id = '${brandAvailabilityId}';
`, { allowFailure: true });
addCheck("update blocked", updateAttempt.status !== 0, { stderr: updateAttempt.stderr.trim() });

const deleteAttempt = runSql(`
delete from platform.game_availability
where id = '${brandAvailabilityId}';
`, { allowFailure: true });
addCheck("delete blocked", deleteAttempt.status !== 0, { stderr: deleteAttempt.stderr.trim() });

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
