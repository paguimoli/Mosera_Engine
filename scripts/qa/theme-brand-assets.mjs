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
  'Theme QA Organization',
  'Active',
  ${sqlJson({ governanceModel: "theme-brand-assets-v1" })},
  ${sqlJson({ defaultLocale: "en" })},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:theme-brand-assets", reason: "P0-006.3" })}
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
  'Theme QA Tenant',
  'Active',
  ${sqlJson({ operatorType: "internal-qa" })},
  'en',
  'USD',
  'America/Costa_Rica',
  true,
  false,
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:theme-brand-assets", reason: "P0-006.3" })}
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
  'Theme QA Brand',
  'Theme QA Brand',
  'Active',
  ${sqlJson({ deferred: true })},
  ${sqlJson({ deferred: true })},
  ${sqlJson([])},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:theme-brand-assets", reason: "P0-006.3" })}
);`;
}

function insertThemeSql({
  id,
  tenantId,
  brandId,
  code,
  contentHash,
  isDefault = false,
  status = "Active",
}) {
  return `
insert into platform.brand_themes (
  id, tenant_id, brand_id, theme_code, display_name, status, is_default, color_tokens,
  typography_tokens, spacing_radius_tokens, component_token_placeholders, mode_support,
  version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  '${brandId}',
  ${sqlString(code)},
  'Theme QA Default',
  ${sqlString(status)},
  ${isDefault ? "true" : "false"},
  ${sqlJson({ primary: "#0057ff", surface: "#ffffff", text: "#101828" })},
  ${sqlJson({ body: "Inter", heading: "Inter" })},
  ${sqlJson({ radiusMd: 8, spaceMd: 16 })},
  ${sqlJson({ button: { borderRadius: "radiusMd" } })},
  ${sqlJson(["light", "dark"])},
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:theme-brand-assets", reason: "P0-006.3" })}
);`;
}

function insertAssetSql({
  id,
  tenantId,
  brandId,
  assetType = "LOGO",
  assetKey,
  version = "1.0.0",
  contentHash,
  checksumHash,
  storageReference = { objectKey: "placeholder/logo.svg", provider: "deferred-object-storage" },
}) {
  return `
insert into platform.brand_assets (
  id, tenant_id, brand_id, asset_type, asset_key, storage_reference_placeholder,
  mime_type, asset_checksum_hash, status, version, content_hash, audit_metadata
) values (
  '${id}',
  '${tenantId}',
  '${brandId}',
  ${sqlString(assetType)},
  ${sqlString(assetKey)},
  ${sqlJson(storageReference)},
  'image/svg+xml',
  ${sqlString(checksumHash)},
  'Active',
  ${sqlString(version)},
  ${sqlString(contentHash)},
  ${sqlJson({ createdBy: "qa:theme-brand-assets", reason: "P0-006.3" })}
);`;
}

const runId = randomUUID();
const organizationId = randomUUID();
const tenantId = randomUUID();
const brandId = randomUUID();
const themeId = randomUUID();
const assetId = randomUUID();
const themeCode = `theme-${runId}`;
const assetKey = `logo-${runId}`;

addCheck("brand themes table exists", existsRegclass("platform.brand_themes"));
addCheck("brand assets table exists", existsRegclass("platform.brand_assets"));

runSql(insertOrganizationSql({
  id: organizationId,
  code: `org-theme-${runId}`,
  contentHash: `sha256:p0-006-3-org:${runId}`,
}));
runSql(insertTenantSql({
  id: tenantId,
  organizationId,
  code: `tenant-theme-${runId}`,
  contentHash: `sha256:p0-006-3-tenant:${runId}`,
}));
runSql(insertBrandSql({
  id: brandId,
  tenantId,
  code: `brand-theme-${runId}`,
  contentHash: `sha256:p0-006-3-brand:${runId}`,
}));

runSql(insertThemeSql({
  id: themeId,
  tenantId,
  brandId,
  code: themeCode,
  contentHash: `sha256:p0-006-3-theme:${runId}`,
  isDefault: true,
}));
addCheck("create theme", rowCount(`
select count(*) from platform.brand_themes
where id = '${themeId}'
  and tenant_id = '${tenantId}'
  and brand_id = '${brandId}'
  and theme_code = ${sqlString(themeCode)}
  and is_default = true
  and status = 'Active';
`) === 1, { themeId });

runSql(insertAssetSql({
  id: assetId,
  tenantId,
  brandId,
  assetKey,
  contentHash: `sha256:p0-006-3-asset:${runId}`,
  checksumHash: `sha256:p0-006-3-asset-checksum:${runId}`,
}));
addCheck("create asset reference", rowCount(`
select count(*) from platform.brand_assets
where id = '${assetId}'
  and tenant_id = '${tenantId}'
  and brand_id = '${brandId}'
  and asset_type = 'LOGO'
  and asset_key = ${sqlString(assetKey)};
`) === 1, { assetId });

const duplicateTheme = runSql(insertThemeSql({
  id: randomUUID(),
  tenantId,
  brandId,
  code: themeCode,
  contentHash: `sha256:p0-006-3-duplicate-theme:${runId}`,
}), { allowFailure: true });
addCheck("duplicate theme code rejected", duplicateTheme.status !== 0, { stderr: duplicateTheme.stderr.trim() });

const duplicateDefaultTheme = runSql(insertThemeSql({
  id: randomUUID(),
  tenantId,
  brandId,
  code: `theme-second-default-${runId}`,
  contentHash: `sha256:p0-006-3-duplicate-default-theme:${runId}`,
  isDefault: true,
}), { allowFailure: true });
addCheck("default theme uniqueness enforced", duplicateDefaultTheme.status !== 0, {
  stderr: duplicateDefaultTheme.stderr.trim(),
});

const duplicateAsset = runSql(insertAssetSql({
  id: randomUUID(),
  tenantId,
  brandId,
  assetKey,
  contentHash: `sha256:p0-006-3-duplicate-asset:${runId}`,
  checksumHash: `sha256:p0-006-3-duplicate-asset-checksum:${runId}`,
}), { allowFailure: true });
addCheck("duplicate asset key/version rejected", duplicateAsset.status !== 0, {
  stderr: duplicateAsset.stderr.trim(),
});

const binaryAsset = runSql(insertAssetSql({
  id: randomUUID(),
  tenantId,
  brandId,
  assetKey: `binary-logo-${runId}`,
  contentHash: `sha256:p0-006-3-binary-asset:${runId}`,
  checksumHash: `sha256:p0-006-3-binary-asset-checksum:${runId}`,
  storageReference: { binaryBlob: "PHN2Zy8+", objectKey: "should-not-allow-inline-data" },
}), { allowFailure: true });
addCheck("binary blob in DB rejected", binaryAsset.status !== 0, { stderr: binaryAsset.stderr.trim() });

const invalidTenant = runSql(insertThemeSql({
  id: randomUUID(),
  tenantId: randomUUID(),
  brandId,
  code: `wrong-tenant-theme-${runId}`,
  contentHash: `sha256:p0-006-3-wrong-tenant-theme:${runId}`,
}), { allowFailure: true });
addCheck("theme tenant must match brand tenant", invalidTenant.status !== 0, { stderr: invalidTenant.stderr.trim() });

addCheck("lookup by brand/status works", rowCount(`
select count(*) from platform.brand_themes
where brand_id = '${brandId}' and status = 'Active';
`) === 1 && rowCount(`
select count(*) from platform.brand_assets
where brand_id = '${brandId}' and status = 'Active';
`) === 1, { brandId });

const updateAttempt = runSql(`
update platform.brand_themes
set display_name = 'Changed'
where id = '${themeId}';
`, { allowFailure: true });
addCheck("theme update blocked", updateAttempt.status !== 0, { stderr: updateAttempt.stderr.trim() });

const deleteAttempt = runSql(`
delete from platform.brand_assets
where id = '${assetId}';
`, { allowFailure: true });
addCheck("asset delete blocked", deleteAttempt.status !== 0, { stderr: deleteAttempt.stderr.trim() });

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
