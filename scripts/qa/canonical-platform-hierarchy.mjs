import { randomUUID } from "node:crypto";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];
const runId = randomUUID();
const platformId = "00000000-0000-4000-8000-000000000001";
const organizationId = randomUUID();
const tenantId = randomUUID();
const brandId = randomUUID();
const marketId = randomUUID();
const websiteId = randomUUID();

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function count(sql) {
  return Number(queryScalar(sql));
}

addCheck("canonical Platform root exists", count(`
  select count(*) from platform.platforms
  where id = '${platformId}' and platform_code = 'mosera' and status = 'Active';
`) === 1);

runSql(`
insert into platform.organizations (
  id, platform_id, organization_code, name, status, governance_metadata, global_defaults,
  version, content_hash, audit_metadata
) values (
  '${organizationId}', '${platformId}', ${sqlString(`canonical-org-${runId}`)},
  'Canonical Organization', 'Active', '{}'::jsonb, '{}'::jsonb, '1.0.0',
  ${sqlString(`sha256:p1-013-1:organization:${runId}`)}, '{"source":"qa:canonical-platform-hierarchy"}'::jsonb
);
insert into platform.tenants (
  id, organization_id, tenant_code, name, status, operator_metadata, default_language,
  default_currency, default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata
) values (
  '${tenantId}', '${organizationId}', ${sqlString(`canonical-tenant-${runId}`)},
  'Canonical Tenant', 'Active', '{}'::jsonb, 'en', 'USD', 'UTC', true, false, '1.0.0',
  ${sqlString(`sha256:p1-013-1:tenant:${runId}`)}, '{"source":"qa:canonical-platform-hierarchy"}'::jsonb
);
insert into platform.brands (
  id, tenant_id, brand_code, name, display_name, status, theme_reference_placeholder,
  asset_reference_placeholder, website_reference_placeholder, version, content_hash, audit_metadata
) values (
  '${brandId}', '${tenantId}', ${sqlString(`canonical-brand-${runId}`)},
  'Canonical Brand', 'Canonical Brand', 'Active', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '1.0.0',
  ${sqlString(`sha256:p1-013-1:brand:${runId}`)}, '{"source":"qa:canonical-platform-hierarchy"}'::jsonb
);
insert into platform.markets (
  id, brand_id, market_code, name, display_name, country, jurisdiction, language, currency,
  timezone, future_game_availability_placeholder, status, version, content_hash, audit_metadata
) values (
  '${marketId}', '${brandId}', ${sqlString(`canonical-market-${runId}`)},
  'Canonical Market', 'Canonical Market', null, null, 'es', 'CRC', 'America/Costa_Rica',
  '{}'::jsonb, 'Active', '1.0.0', ${sqlString(`sha256:p1-013-1:market:${runId}`)},
  '{"source":"qa:canonical-platform-hierarchy"}'::jsonb
);
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status,
  maintenance_mode, future_theme_reference_placeholder, future_homepage_config_placeholder,
  version, content_hash, audit_metadata
) values (
  '${websiteId}', '${tenantId}', '${brandId}', '${marketId}', ${sqlString(`canonical-site-${runId}`)},
  'Canonical Website', 'Active', false, '{}'::jsonb, '{}'::jsonb, '1.0.0',
  ${sqlString(`sha256:p1-013-1:website:${runId}`)}, '{"source":"qa:canonical-platform-hierarchy"}'::jsonb
);
`);

addCheck("canonical hierarchy persists one exact parent chain", count(`
  select count(*)
  from platform.platforms platform
  join platform.organizations organization on organization.platform_id = platform.id
  join platform.tenants tenant on tenant.organization_id = organization.id
  join platform.brands brand on brand.tenant_id = tenant.id
  join platform.markets market on market.brand_id = brand.id
  join platform.websites website
    on website.market_id = market.id
   and website.brand_id = brand.id
   and website.tenant_id = tenant.id
  where platform.id = '${platformId}'
    and organization.id = '${organizationId}'
    and tenant.id = '${tenantId}'
    and brand.id = '${brandId}'
    and market.id = '${marketId}'
    and website.id = '${websiteId}';
`) === 1);

addCheck("Market owns website locale configuration", count(`
  select count(*)
  from platform.websites website
  join platform.markets market on market.id = website.market_id
  where website.id = '${websiteId}'
    and row(website.default_language, website.default_currency, website.default_timezone)
      = row(market.language, market.currency, market.timezone);
`) === 1);

const missingMarket = runSql(`
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status,
  version, content_hash, audit_metadata
) values (
  '${randomUUID()}', '${tenantId}', '${brandId}', null, ${sqlString(`orphan-site-${runId}`)},
  'Orphan Website', 'Draft', '1.0.0', ${sqlString(`sha256:p1-013-1:orphan:${runId}`)}, '{}'::jsonb
);`, { allowFailure: true });
addCheck("website without Market fails closed", missingMarket.status !== 0, {
  stderr: missingMarket.stderr.trim(),
});

const wrongMarket = runSql(`
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status,
  version, content_hash, audit_metadata
) values (
  '${randomUUID()}', '${tenantId}', '${brandId}', '${randomUUID()}', ${sqlString(`wrong-market-${runId}`)},
  'Wrong Market Website', 'Draft', '1.0.0', ${sqlString(`sha256:p1-013-1:wrong-market:${runId}`)}, '{}'::jsonb
);`, { allowFailure: true });
addCheck("invalid parent reference fails closed", wrongMarket.status !== 0, {
  stderr: wrongMarket.stderr.trim(),
});

const disabledMarketId = randomUUID();
runSql(`
insert into platform.markets (
  id, brand_id, market_code, name, display_name, language, currency, timezone,
  future_game_availability_placeholder, status, version, content_hash, audit_metadata
) values (
  '${disabledMarketId}', '${brandId}', ${sqlString(`disabled-market-${runId}`)},
  'Disabled Market', 'Disabled Market', 'en', 'USD', 'UTC', '{}'::jsonb,
  'Suspended', '1.0.0', ${sqlString(`sha256:p1-013-1:disabled-market:${runId}`)}, '{}'::jsonb
);`);
const disabledParent = runSql(`
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status,
  version, content_hash, audit_metadata
) values (
  '${randomUUID()}', '${tenantId}', '${brandId}', '${disabledMarketId}',
  ${sqlString(`disabled-parent-site-${runId}`)}, 'Disabled Parent Website', 'Active',
  '1.0.0', ${sqlString(`sha256:p1-013-1:disabled-parent-site:${runId}`)}, '{}'::jsonb
);`, { allowFailure: true });
addCheck("Active child under disabled parent fails closed", disabledParent.status !== 0, {
  stderr: disabledParent.stderr.trim(),
});

const localeMismatch = runSql(`
insert into platform.websites (
  id, tenant_id, brand_id, market_id, website_code, display_name, status,
  default_language, default_currency, default_timezone, version, content_hash, audit_metadata
) values (
  '${randomUUID()}', '${tenantId}', '${brandId}', '${marketId}',
  ${sqlString(`locale-mismatch-${runId}`)}, 'Locale Mismatch Website', 'Draft',
  'en', 'USD', 'UTC', '1.0.0', ${sqlString(`sha256:p1-013-1:locale-mismatch:${runId}`)}, '{}'::jsonb
);`, { allowFailure: true });
addCheck("Website cannot override Market-owned locale", localeMismatch.status !== 0, {
  stderr: localeMismatch.stderr.trim(),
});

const readinessIssues = count(`
  select count(*) from platform.canonical_hierarchy_readiness() where ready = false;
`);
addCheck("canonical hierarchy readiness passes", readinessIssues === 0, { readinessIssues });

for (const checkName of [
  "auth_scope_references",
  "wallet_scope_references",
  "ledger_scope_references",
  "settlement_scope_references",
  "outcome_scope_references",
]) {
  addCheck(`authority reference ready:${checkName}`, count(`
    select count(*) from platform.canonical_hierarchy_readiness()
    where check_name = ${sqlString(checkName)} and ready = true;
  `) === 1);
}

const updateAttempt = runSql(`
update platform.platforms set name = 'Changed' where id = '${platformId}';
`, { allowFailure: true });
addCheck("Platform root remains append-only", updateAttempt.status !== 0, {
  stderr: updateAttempt.stderr.trim(),
});

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failed.length,
  checks,
});

if (failed.length > 0) {
  process.exitCode = 1;
}
