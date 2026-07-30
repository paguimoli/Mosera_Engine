alter table compensation.entitlements
  add column tenant_id uuid not null references platform.tenants(id),
  add column brand_id uuid not null references platform.brands(id),
  add column market_id uuid not null references platform.markets(id);

create index idx_compensation_entitlement_scope
  on compensation.entitlements(
    tenant_id, brand_id, market_id, accounting_period_id, strategy
  );

comment on column compensation.entitlements.tenant_id is
  'Canonical tenant scope derived from the accounting period market hierarchy.';
comment on column compensation.entitlements.brand_id is
  'Canonical brand scope derived from the accounting period market hierarchy.';
comment on column compensation.entitlements.market_id is
  'Canonical market scope bound to the closed accounting period.';

