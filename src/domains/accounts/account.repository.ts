import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type {
  Account,
  AccountBalanceAuthority,
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  CreateAccountInput,
  PersistedAccountStatus,
  PersistedAccountType,
  PlayerAccount,
  UpdateAccountInput,
} from "./account.types";
import {
  normalizeAccountCode,
  normalizeCreateAccountInput,
  normalizeUpdateAccountInput,
} from "./account.validation";

export type CanonicalAccountScope = {
  platformId: string;
  organizationId: string;
  tenantId: string;
  brandId: string;
  marketId: string;
};

export type AccountGovernanceContext = {
  operatorId: string;
  reason: string;
};

export type AccountScopeReadinessCheck = {
  checkName: string;
  ready: boolean;
  issueCount: number;
};

export type CanonicalAccountHierarchy = {
  hierarchyAccountIds: string[];
  agentAccountId: string | null;
  masterAgentAccountId: string | null;
};

type AccountRow = {
  id: string;
  account_type: PersistedAccountType;
  account_code: string;
  display_name: string;
  parent_account_id?: string | null;
  platform_id: string;
  organization_id: string;
  canonical_tenant_id: string;
  canonical_brand_id: string;
  canonical_market_id: string;
  status: PersistedAccountStatus;
  funding_model?: AccountFundingModel | null;
  operating_mode?: AccountOperatingMode | null;
  balance_authority?: AccountBalanceAuthority | null;
  default_funding_source?: AccountDefaultFundingSource | null;
  weekly_accounting_mode?: AccountWeeklyAccountingMode | null;
  settlement_mode?: AccountSettlementMode | null;
  governance_managed: true;
  idempotency_key?: string | null;
  canonical_request_hash?: string | null;
  created_at: string;
  updated_at?: string | null;
};

const ACCOUNT_SELECT = `
  account.id,
  account.account_type,
  account.account_code,
  account.display_name,
  account.parent_account_id,
  platform.id as platform_id,
  organization.id as organization_id,
  account.canonical_tenant_id,
  account.canonical_brand_id,
  account.canonical_market_id,
  account.status,
  account.funding_model,
  account.operating_mode,
  account.balance_authority,
  account.default_funding_source,
  account.weekly_accounting_mode,
  account.settlement_mode,
  account.governance_managed,
  account.idempotency_key,
  account.canonical_request_hash,
  account.created_at,
  account.updated_at
`;

const ACCOUNT_FROM = `
  from public.accounts account
  join platform.markets market
    on market.id = account.canonical_market_id
    and market.brand_id = account.canonical_brand_id
  join platform.brands brand
    on brand.id = account.canonical_brand_id
    and brand.tenant_id = account.canonical_tenant_id
  join platform.tenants tenant on tenant.id = account.canonical_tenant_id
  join platform.organizations organization on organization.id = tenant.organization_id
  join platform.platforms platform on platform.id = organization.platform_id
  where account.governance_managed
`;

let pool: Pool | null = null;

export class AccountRepositoryError extends Error {
  constructor(message = "Account persistence operation failed.") {
    super(message);
    this.name = "AccountRepositoryError";
  }
}

export class AccountIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key is already bound to a different account request.");
    this.name = "AccountIdempotencyConflictError";
  }
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new AccountRepositoryError("Account database is not configured.");
  }

  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 5_000,
  });

  return pool;
}

function mapAccountRow(row: AccountRow | null): Account | null {
  if (!row) return null;

  return {
    id: row.id,
    accountType: row.account_type,
    accountCode: row.account_code,
    displayName: row.display_name,
    parentAccountId: row.parent_account_id ?? null,
    platformId: row.platform_id,
    organizationId: row.organization_id,
    tenantId: row.canonical_tenant_id,
    brandId: row.canonical_brand_id,
    marketId: row.canonical_market_id,
    status: row.status,
    fundingModel: row.funding_model ?? null,
    operatingMode: row.operating_mode ?? null,
    balanceAuthority: row.balance_authority ?? null,
    defaultFundingSource: row.default_funding_source ?? null,
    weeklyAccountingMode: row.weekly_accounting_mode ?? null,
    settlementMode: row.settlement_mode ?? null,
    governanceManaged: true,
    idempotencyKey: row.idempotency_key ?? null,
    canonicalRequestHash: row.canonical_request_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function resolveCanonicalMarketScope(
  marketId: string
): Promise<CanonicalAccountScope | null> {
  const result = await databasePool().query<CanonicalAccountScope>(
    `select
       platform.id as "platformId",
       organization.id as "organizationId",
       tenant.id as "tenantId",
       brand.id as "brandId",
       market.id as "marketId"
     from platform.markets market
     join platform.brands brand on brand.id = market.brand_id
     join platform.tenants tenant on tenant.id = brand.tenant_id
     join platform.organizations organization on organization.id = tenant.organization_id
     join platform.platforms platform on platform.id = organization.platform_id
     where market.id = $1
       and market.status = 'Active'
       and brand.status = 'Active'
       and tenant.status = 'Active'
       and organization.status = 'Active'
       and platform.status = 'Active'`,
    [marketId]
  );

  return result.rows[0] ?? null;
}

export async function resolveCanonicalAccountHierarchy(
  accountId: string
): Promise<CanonicalAccountHierarchy> {
  const result = await databasePool().query<{
    id: string;
    account_type: PersistedAccountType;
    depth: number;
  }>(
    `with recursive hierarchy as (
       select id, account_type, parent_account_id, 0 as depth
       from public.accounts
       where id = $1 and governance_managed
       union all
       select parent.id, parent.account_type, parent.parent_account_id, hierarchy.depth + 1
       from public.accounts parent
       join hierarchy on hierarchy.parent_account_id = parent.id
       where parent.governance_managed
     )
     select id, account_type, depth
     from hierarchy
     order by depth asc`,
    [accountId]
  );

  return {
    hierarchyAccountIds: result.rows.map((row) => row.id),
    agentAccountId:
      result.rows.find((row) => row.account_type === "AGENT")?.id ?? null,
    masterAgentAccountId:
      result.rows.find((row) => row.account_type === "MASTER_AGENT")?.id ?? null,
  };
}

function canonicalCreateHash(
  input: CreateAccountInput,
  scope: CanonicalAccountScope
) {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        accountType: input.accountType,
        accountCode: input.accountCode,
        displayName: input.displayName,
        parentAccountId: input.parentAccountId ?? null,
        tenantId: scope.tenantId,
        brandId: scope.brandId,
        marketId: scope.marketId,
        status: input.status ?? "ACTIVE",
        fundingModel: input.fundingModel ?? null,
        operatingMode: input.operatingMode ?? null,
        balanceAuthority: input.balanceAuthority ?? null,
        defaultFundingSource: input.defaultFundingSource ?? null,
        weeklyAccountingMode: input.weeklyAccountingMode ?? null,
        settlementMode: input.settlementMode ?? null,
      })
    )
    .digest("hex")}`;
}

async function configureGovernanceContext(
  client: PoolClient,
  context: AccountGovernanceContext
) {
  await client.query("select set_config('app.account_governance_actor', $1, true)", [
    context.operatorId,
  ]);
  await client.query("select set_config('app.account_governance_reason', $1, true)", [
    context.reason,
  ]);
}

export async function createAccount(
  input: CreateAccountInput,
  scope: CanonicalAccountScope,
  context: AccountGovernanceContext
): Promise<Account> {
  const normalized = normalizeCreateAccountInput(input);
  const requestHash = canonicalCreateHash(normalized, scope);

  if (normalized.idempotencyKey) {
    const existing = await findAccountByIdempotencyKey(normalized.idempotencyKey);
    if (existing) {
      if (existing.canonicalRequestHash !== requestHash) {
        throw new AccountIdempotencyConflictError();
      }
      return existing;
    }
  }

  const client = await databasePool().connect();
  try {
    await client.query("begin");
    await configureGovernanceContext(client, context);
    const inserted = await client.query<{ id: string }>(
      `insert into public.accounts (
         account_type,
         account_code,
         display_name,
         parent_account_id,
         canonical_tenant_id,
         canonical_brand_id,
         canonical_market_id,
         status,
         funding_model,
         operating_mode,
         balance_authority,
         default_funding_source,
         weekly_accounting_mode,
         settlement_mode,
         governance_managed,
         idempotency_key,
         canonical_request_hash
       )
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         true, $15, $16
       )
       returning id`,
      [
        normalized.accountType,
        normalized.accountCode,
        normalized.displayName,
        normalized.parentAccountId ?? null,
        scope.tenantId,
        scope.brandId,
        scope.marketId,
        normalized.status ?? "ACTIVE",
        normalized.fundingModel ?? null,
        normalized.operatingMode ?? null,
        normalized.balanceAuthority ?? null,
        normalized.defaultFundingSource ?? null,
        normalized.weeklyAccountingMode ?? null,
        normalized.settlementMode ?? null,
        normalized.idempotencyKey ?? null,
        requestHash,
      ]
    );
    await client.query("commit");
    return (await findAccountById(inserted.rows[0]!.id))!;
  } catch (error) {
    await client.query("rollback");
    if (
      normalized.idempotencyKey &&
      error instanceof Error &&
      "code" in error &&
      error.code === "23505"
    ) {
      const existing = await findAccountByIdempotencyKey(normalized.idempotencyKey);
      if (existing?.canonicalRequestHash === requestHash) return existing;
      if (existing) throw new AccountIdempotencyConflictError();
    }
    throw new AccountRepositoryError(
      error instanceof Error ? error.message : undefined
    );
  } finally {
    client.release();
  }
}

export function findAccountById(
  accounts: PlayerAccount[],
  accountId: string
): PlayerAccount | undefined;
export function findAccountById(id: string): Promise<Account | null>;
export function findAccountById(
  accountsOrId: PlayerAccount[] | string,
  accountId?: string
): PlayerAccount | undefined | Promise<Account | null> {
  if (Array.isArray(accountsOrId)) {
    return accountsOrId.find((account) => account.id === accountId);
  }
  return findPersistedAccountById(accountsOrId);
}

async function findPersistedAccountById(id: string): Promise<Account | null> {
  const result = await databasePool().query<AccountRow>(
    `select ${ACCOUNT_SELECT} ${ACCOUNT_FROM} and account.id = $1`,
    [id]
  );
  return mapAccountRow(result.rows[0] ?? null);
}

async function findAccountByIdempotencyKey(key: string) {
  const result = await databasePool().query<AccountRow>(
    `select ${ACCOUNT_SELECT} ${ACCOUNT_FROM} and account.idempotency_key = $1`,
    [key]
  );
  return mapAccountRow(result.rows[0] ?? null);
}

export function findAccountByUsername(accounts: PlayerAccount[], username: string) {
  return accounts.find(
    (account) =>
      account.username.trim().toLowerCase() === username.trim().toLowerCase()
  );
}

export async function findAccountByCode(
  accountCode: string
): Promise<Account | null> {
  const result = await databasePool().query<AccountRow>(
    `select ${ACCOUNT_SELECT} ${ACCOUNT_FROM} and account.account_code = $1`,
    [normalizeAccountCode(accountCode)]
  );
  return mapAccountRow(result.rows[0] ?? null);
}

export async function listAccounts(): Promise<Account[]> {
  const result = await databasePool().query<AccountRow>(
    `select ${ACCOUNT_SELECT} ${ACCOUNT_FROM} order by account.account_code`
  );
  return result.rows.map(mapAccountRow).filter((account): account is Account => Boolean(account));
}

export function listAccountsByParentId(
  accounts: PlayerAccount[],
  parentId: string | null
) {
  return accounts.filter((account) => account.parentId === parentId);
}

export async function listChildren(parentAccountId: string): Promise<Account[]> {
  const result = await databasePool().query<AccountRow>(
    `select ${ACCOUNT_SELECT} ${ACCOUNT_FROM}
     and account.parent_account_id = $1
     order by account.account_code`,
    [parentAccountId]
  );
  return result.rows.map(mapAccountRow).filter((account): account is Account => Boolean(account));
}

export function saveAccount(accounts: PlayerAccount[], account: PlayerAccount) {
  return [...accounts, account];
}

export function updateAccount(
  accounts: PlayerAccount[],
  account: PlayerAccount
): PlayerAccount[];
export function updateAccount(
  id: string,
  input: UpdateAccountInput,
  scope?: CanonicalAccountScope,
  context?: AccountGovernanceContext
): Promise<Account>;
export function updateAccount(
  accountsOrId: PlayerAccount[] | string,
  accountOrInput: PlayerAccount | UpdateAccountInput,
  scope?: CanonicalAccountScope,
  context?: AccountGovernanceContext
): PlayerAccount[] | Promise<Account> {
  if (Array.isArray(accountsOrId)) {
    const account = accountOrInput as PlayerAccount;
    return accountsOrId.map((createdAccount) =>
      createdAccount.id === account.id ? account : createdAccount
    );
  }
  return updatePersistedAccount(
    accountsOrId,
    accountOrInput as UpdateAccountInput,
    scope,
    context ?? { operatorId: "system", reason: "account update" }
  );
}

async function updatePersistedAccount(
  id: string,
  input: UpdateAccountInput,
  scope: CanonicalAccountScope | undefined,
  context: AccountGovernanceContext
): Promise<Account> {
  const normalized = normalizeUpdateAccountInput(input);
  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (normalized.accountType !== undefined) set("account_type", normalized.accountType);
  if (normalized.accountCode !== undefined) set("account_code", normalized.accountCode);
  if (normalized.displayName !== undefined) set("display_name", normalized.displayName);
  if (normalized.parentAccountId !== undefined) {
    set("parent_account_id", normalized.parentAccountId ?? null);
  }
  if (scope) {
    set("canonical_tenant_id", scope.tenantId);
    set("canonical_brand_id", scope.brandId);
    set("canonical_market_id", scope.marketId);
  }
  if (normalized.status !== undefined) set("status", normalized.status);
  if (normalized.fundingModel !== undefined) set("funding_model", normalized.fundingModel);
  if (normalized.operatingMode !== undefined) set("operating_mode", normalized.operatingMode);
  if (normalized.balanceAuthority !== undefined) {
    set("balance_authority", normalized.balanceAuthority);
  }
  if (normalized.defaultFundingSource !== undefined) {
    set("default_funding_source", normalized.defaultFundingSource);
  }
  if (normalized.weeklyAccountingMode !== undefined) {
    set("weekly_accounting_mode", normalized.weeklyAccountingMode);
  }
  if (normalized.settlementMode !== undefined) {
    set("settlement_mode", normalized.settlementMode);
  }

  if (assignments.length === 0) {
    const existing = await findAccountById(id);
    if (!existing) throw new AccountRepositoryError("Account not found.");
    return existing;
  }

  const client = await databasePool().connect();
  try {
    await client.query("begin");
    await configureGovernanceContext(client, context);
    values.push(id);
    const result = await client.query<{ id: string }>(
      `update public.accounts
       set ${assignments.join(", ")}
       where id = $${values.length}
         and governance_managed
       returning id`,
      values
    );
    if (!result.rows[0]) throw new AccountRepositoryError("Account not found.");
    await client.query("commit");
    return (await findAccountById(result.rows[0].id))!;
  } catch (error) {
    await client.query("rollback");
    throw error instanceof AccountRepositoryError
      ? error
      : new AccountRepositoryError(error instanceof Error ? error.message : undefined);
  } finally {
    client.release();
  }
}

export async function disableAccount(
  id: string,
  context?: AccountGovernanceContext
): Promise<Account> {
  return updatePersistedAccount(
    id,
    { status: "DISABLED" },
    undefined,
    context ?? { operatorId: "system", reason: "account disabled" }
  );
}

export async function getAccountScopeReadiness(): Promise<
  AccountScopeReadinessCheck[]
> {
  const result = await databasePool().query<{
    check_name: string;
    ready: boolean;
    issue_count: string | number;
  }>(
    `select 'account_scope:' || check_name as check_name, ready, issue_count
     from platform.account_scope_governance_readiness()
     union all
     select 'platform_authority:' || check_name, ready, issue_count
     from platform.canonical_hierarchy_readiness()`
  );
  return result.rows.map((row) => ({
    checkName: row.check_name,
    ready: row.ready,
    issueCount: Number(row.issue_count),
  }));
}

export function deleteAccount(accounts: PlayerAccount[], accountId: string) {
  return accounts.filter((account) => account.id !== accountId);
}
