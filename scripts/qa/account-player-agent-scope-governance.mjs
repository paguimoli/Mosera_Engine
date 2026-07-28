import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@localhost:55432/lottery_local";
const checks = [];

function check(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

async function expectRejected(name, operation, pattern) {
  try {
    await operation();
    check(name, false, { reason: "operation unexpectedly succeeded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), { message });
  }
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const scopes = await client.query(`
    select
      platform.id as platform_id,
      organization.id as organization_id,
      tenant.id as tenant_id,
      brand.id as brand_id,
      market.id as market_id
    from platform.markets market
    join platform.brands brand on brand.id = market.brand_id
    join platform.tenants tenant on tenant.id = brand.tenant_id
    join platform.organizations organization on organization.id = tenant.organization_id
    join platform.platforms platform on platform.id = organization.platform_id
    where market.status = 'Active'
      and brand.status = 'Active'
      and tenant.status = 'Active'
      and organization.status = 'Active'
      and platform.status = 'Active'
    order by tenant.id, brand.id, market.id
  `);
  const scopeA = scopes.rows[0];
  const scopeB = scopes.rows.find(
    (scope) =>
      scope.tenant_id !== scopeA?.tenant_id &&
      scope.brand_id !== scopeA?.brand_id &&
      scope.market_id !== scopeA?.market_id
  );

  if (!scopeA || !scopeB) {
    throw new Error("Two independent active canonical Platform scopes are required.");
  }

  const suffix = randomUUID().slice(0, 8);
  const ids = {
    superA: randomUUID(),
    masterA: randomUUID(),
    masterA2: randomUUID(),
    agentA: randomUUID(),
    playerA: randomUUID(),
    superB: randomUUID(),
    masterB: randomUUID(),
    agentB: randomUUID(),
    playerB: randomUUID(),
  };

  async function insertAccount({
    id,
    type,
    parentId = null,
    scope = scopeA,
    status = "ACTIVE",
  }) {
    return client.query(
      `insert into public.accounts (
         id,
         account_type,
         account_code,
         display_name,
         parent_account_id,
         canonical_tenant_id,
         canonical_brand_id,
         canonical_market_id,
         status,
         governance_managed,
         idempotency_key,
         canonical_request_hash
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11)
       returning id`,
      [
        id,
        type,
        `scope-qa-${suffix}-${type.toLowerCase()}-${id.slice(0, 4)}`,
        `${type} ${suffix}`,
        parentId,
        scope.tenant_id,
        scope.brand_id,
        scope.market_id,
        status,
        `scope-qa:${id}`,
        `sha256:${id.replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`,
      ]
    );
  }

  await insertAccount({ id: ids.superA, type: "SUPER_MASTER" });
  await insertAccount({
    id: ids.masterA,
    type: "MASTER_AGENT",
    parentId: ids.superA,
  });
  await insertAccount({
    id: ids.masterA2,
    type: "MASTER_AGENT",
    parentId: ids.superA,
  });
  await insertAccount({
    id: ids.agentA,
    type: "AGENT",
    parentId: ids.masterA,
  });
  await insertAccount({
    id: ids.playerA,
    type: "PLAYER",
    parentId: ids.agentA,
  });
  check("create account, master agent, agent, and player", true);

  await insertAccount({ id: ids.superB, type: "SUPER_MASTER", scope: scopeB });
  await insertAccount({
    id: ids.masterB,
    type: "MASTER_AGENT",
    parentId: ids.superB,
    scope: scopeB,
  });
  await insertAccount({
    id: ids.agentB,
    type: "AGENT",
    parentId: ids.masterB,
    scope: scopeB,
  });
  await insertAccount({
    id: ids.playerB,
    type: "PLAYER",
    parentId: ids.agentB,
    scope: scopeB,
  });
  check("second independent hierarchy persists", true);

  await expectRejected(
    "cross-tenant scope is rejected",
    () =>
      client.query(
        `insert into public.accounts (
           account_type, account_code, display_name, parent_account_id,
           canonical_tenant_id, canonical_brand_id, canonical_market_id,
           status, governance_managed
         )
         values ('AGENT', $1, 'cross tenant', $2, $3, $4, $5, 'ACTIVE', true)`,
        [
          `cross-tenant-${suffix}`,
          ids.masterA,
          scopeB.tenant_id,
          scopeA.brand_id,
          scopeA.market_id,
        ]
      ),
    /derived from the canonical market hierarchy|cross canonical scope/
  );

  await expectRejected(
    "cross-brand scope is rejected",
    () =>
      client.query(
        `insert into public.accounts (
           account_type, account_code, display_name, parent_account_id,
           canonical_tenant_id, canonical_brand_id, canonical_market_id,
           status, governance_managed
         )
         values ('AGENT', $1, 'cross brand', $2, $3, $4, $5, 'ACTIVE', true)`,
        [
          `cross-brand-${suffix}`,
          ids.masterA,
          scopeA.tenant_id,
          scopeB.brand_id,
          scopeA.market_id,
        ]
      ),
    /derived from the canonical market hierarchy|cross canonical scope/
  );

  await expectRejected(
    "cross-market hierarchy is rejected",
    () =>
      client.query(
        `update public.accounts
         set parent_account_id = $1
         where id = $2`,
        [ids.masterB, ids.agentA]
      ),
    /cross canonical scope/
  );

  await expectRejected(
    "orphan hierarchy is rejected",
    () =>
      client.query(
        `insert into public.accounts (
           account_type, account_code, display_name,
           canonical_tenant_id, canonical_brand_id, canonical_market_id,
           status, governance_managed
         )
         values ('AGENT', $1, 'orphan', $2, $3, $4, 'ACTIVE', true)`,
        [
          `orphan-${suffix}`,
          scopeA.tenant_id,
          scopeA.brand_id,
          scopeA.market_id,
        ]
      ),
    /require a parent account/
  );

  await expectRejected(
    "disabled parent with active child is rejected",
    () =>
      client.query(
        "update public.accounts set status = 'DISABLED' where id = $1",
        [ids.masterA]
      ),
    /active children/
  );

  await expectRejected(
    "hierarchy cycle is rejected",
    async () => {
      await client.query(
        "update public.accounts set parent_account_id = $1 where id = $2",
        [ids.masterA, ids.masterA2]
      );
      await client.query(
        "update public.accounts set parent_account_id = $1 where id = $2",
        [ids.masterA2, ids.masterA]
      );
    },
    /cycle/
  );

  await client.query(
    "update public.accounts set parent_account_id = $1 where id = $2",
    [ids.masterA2, ids.agentA]
  );
  const reassignment = await client.query(
    `select count(*)::int as count
     from platform.account_governance_events
     where account_id = $1 and event_type = 'REASSIGNED'`,
    [ids.agentA]
  );
  check(
    "hierarchy reassignment preserves immutable ownership evidence",
    reassignment.rows[0]?.count === 1
  );

  await client.query(
    "update public.accounts set status = 'DISABLED' where id = $1",
    [ids.playerA]
  );
  await client.query(
    "update public.accounts set status = 'ACTIVE' where id = $1",
    [ids.playerA]
  );
  const lifecycle = await client.query(
    `select event_type
     from platform.account_governance_events
     where account_id = $1
     order by created_at, event_id`,
    [ids.playerA]
  );
  check(
    "disable and restore are audited",
    lifecycle.rows.some((row) => row.event_type === "STATUS_CHANGED") &&
      lifecycle.rows.some((row) => row.event_type === "RESTORED")
  );

  const profileId = randomUUID();
  await client.query(
    `insert into public.player_profiles (
       id, account_id, display_name, status
     )
     values ($1, $2, $3, 'ACTIVE')`,
    [profileId, ids.playerA, `Player ${suffix}`]
  );
  check("player profile derives canonical scope from its account", true);

  await expectRejected(
    "player profile cannot cross tenant, brand, or market",
    () =>
      client.query(
        "update public.player_profiles set account_id = $1 where id = $2",
        [ids.playerB, profileId]
      ),
    /cannot cross canonical scope/
  );

  const duplicateKey = `scope-qa:${ids.playerA}`;
  await expectRejected(
    "duplicate governed request is constrained",
    () =>
      client.query(
        `insert into public.accounts (
           account_type, account_code, display_name, parent_account_id,
           canonical_tenant_id, canonical_brand_id, canonical_market_id,
           status, governance_managed, idempotency_key
         )
         values ('PLAYER', $1, 'duplicate', $2, $3, $4, $5, 'ACTIVE', true, $6)`,
        [
          `duplicate-${suffix}`,
          ids.agentA,
          scopeA.tenant_id,
          scopeA.brand_id,
          scopeA.market_id,
          duplicateKey,
        ]
      ),
    /duplicate key|ux_accounts_governed_idempotency/
  );

  const eventId = (
    await client.query(
      `select event_id
       from platform.account_governance_events
       where account_id = $1
       limit 1`,
      [ids.agentA]
    )
  ).rows[0]?.event_id;
  await expectRejected(
    "governance evidence is append-only",
    () =>
      client.query(
        "update platform.account_governance_events set reason = 'tampered' where event_id = $1",
        [eventId]
      ),
    /append-only/
  );

  const readiness = await client.query(
    "select check_name, ready, issue_count from platform.account_scope_governance_readiness()"
  );
  check(
    "scope and hierarchy readiness fail closed",
    readiness.rows
      .filter((row) => row.check_name !== "migration_state")
      .every((row) => row.ready),
    { readiness: readiness.rows }
  );

  const accountRoutes = [
    "app/api/accounts/route.ts",
    "app/api/accounts/[accountId]/route.ts",
    "app/api/accounts/[accountId]/children/route.ts",
    "app/api/accounts/[accountId]/commission-assignment/route.ts",
    "app/api/accounts/[accountId]/ledger/route.ts",
    "app/api/accounts/[accountId]/wallets/route.ts",
    "app/api/accounts/[accountId]/wallets/provision/route.ts",
    "app/api/accounts/[accountId]/cashier/transactions/route.ts",
    "app/api/credit/players/[playerId]/summary/route.ts",
  ];
  check(
    "account resource APIs require canonical scope governance",
    accountRoutes.every((path) => {
      const source = readFileSync(path, "utf8");
      return (
        source.includes("requireScopedAccount") ||
        source.includes("filterAccountsByScope")
      );
    })
  );
  check(
    "player resource APIs require canonical scope governance",
    [
      "app/api/players/route.ts",
      "app/api/players/[playerProfileId]/route.ts",
    ].every((path) => {
      const source = readFileSync(path, "utf8");
      return (
        source.includes("requireScopedAccount") ||
        source.includes("canAccessAccountScope")
      );
    })
  );
} finally {
  await client.end();
}

const failed = checks.filter((item) => item.status !== "PASS");
console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "PASS" : "FAIL",
      checkCount: checks.length,
      failedCount: failed.length,
      checks,
    },
    null,
    2
  )
);
if (failed.length > 0) process.exitCode = 1;
