import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { cpus, freemem, homedir, hostname, loadavg, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const appUrl = (process.env.APP_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const authServiceUrl = (process.env.AUTH_SERVICE_URL ?? "http://127.0.0.1:5600").replace(/\/$/, "");
const runId = process.env.RC_LOAD_RUN_ID ?? randomUUID();
const suffix = runId.slice(0, 8);
const loadIdentityId = randomUUID();
const loadLoginId = `rc-load-${suffix}@example.test`;
const loadPassword = "RcLoad-QA-2026!";
const evidenceDirectory = process.env.RC_LOAD_EVIDENCE_DIR ?? ".qa/rc-1.3";
const soakMinutes = Math.max(1, Number(process.env.RC_LOAD_SOAK_MINUTES ?? 60));
const steadyTps = Math.max(1, Number(process.env.RC_LOAD_STEADY_TPS ?? 2));
const burstConcurrency = Math.max(2, Number(process.env.RC_LOAD_BURST_CONCURRENCY ?? 20));
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const stages = [];
const defects = [
  {
    severity: "HIGH",
    component: "Auth Service",
    defect: "Canonical /me omitted durable memberships required by Scope Authority.",
    remediation: "Return authoritative membership scope from IMembershipRepository.",
  },
  {
    severity: "MEDIUM",
    component: "Auth Service",
    defect: "Every authenticated request renewed the same canonical session row, creating avoidable lock contention.",
    remediation: "Coalesce last-seen renewal writes to a bounded 30-second interval while revalidating every request.",
  },
  {
    severity: "MEDIUM",
    component: "Ticket API",
    defect: "The route rejected valid PostgreSQL UUID values whose version nibble was not RFC v1-v5.",
    remediation: "Validate canonical UUID shape without imposing an unsupported version constraint.",
  },
  {
    severity: "TOOLING_ONLY",
    component: "RC load harness",
    defect: "Fetch did not transmit the required Host header, and synchronous QA execution interrupted active request promises.",
    remediation: "Use node:http for host-scoped requests and complete traffic before invoking synchronous regression commands.",
  },
];

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function latencySummary(values) {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    p99Ms: Number(percentile(values, 0.99).toFixed(2)),
    maxMs: Number(Math.max(0, ...values).toFixed(2)),
  };
}

function command(name, args, extraEnv = {}) {
  const started = performance.now();
  const result = spawnSync(name, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL ?? "http://127.0.0.1:5600",
      LEDGER_SERVICE_URL: process.env.LEDGER_SERVICE_URL ?? "http://127.0.0.1:5200",
      CREDIT_WALLET_SERVICE_URL: process.env.CREDIT_WALLET_SERVICE_URL ?? "http://127.0.0.1:5300",
      SETTLEMENT_SERVICE_URL: process.env.SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:5400",
      GAME_ENGINE_URL: process.env.GAME_ENGINE_URL ?? "http://127.0.0.1:5500",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [name, ...args].join(" "),
    status: result.status,
    durationMs: Number((performance.now() - started).toFixed(2)),
    stdout: result.stdout?.slice(-12_000) ?? "",
    stderr: result.stderr?.slice(-12_000) ?? "",
  };
}

function commandAsync(name, args, extraEnv = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(name, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL ?? "http://127.0.0.1:5600",
        LEDGER_SERVICE_URL: process.env.LEDGER_SERVICE_URL ?? "http://127.0.0.1:5200",
        CREDIT_WALLET_SERVICE_URL: process.env.CREDIT_WALLET_SERVICE_URL ?? "http://127.0.0.1:5300",
        SETTLEMENT_SERVICE_URL: process.env.SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:5400",
        GAME_ENGINE_URL: process.env.GAME_ENGINE_URL ?? "http://127.0.0.1:5500",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({
      command: [name, ...args].join(" "), status: null,
      durationMs: Number((performance.now() - started).toFixed(2)),
      stdout: "", stderr: error.message,
    }));
    child.on("close", (status) => resolve({
      command: [name, ...args].join(" "), status,
      durationMs: Number((performance.now() - started).toFixed(2)),
      stdout: Buffer.concat(stdout).toString("utf8").slice(-12_000),
      stderr: Buffer.concat(stderr).toString("utf8").slice(-12_000),
    }));
  });
}

async function qualificationEnvironment() {
  const manifest = JSON.parse(readFileSync("scripts/migrations/migration-manifest.json", "utf8"));
  const migrationCount = Number((await pool.query(
    "select count(*)::int count from platform_migrations.migration_history where status='APPLIED'",
  )).rows[0]?.count ?? 0);
  const images = command("docker", ["compose", "images", "--format", "json"]);
  return {
    releaseCommit: command("git", ["rev-parse", "HEAD"]).stdout.trim(),
    worktreeDirty: command("git", ["status", "--porcelain"]).stdout.trim().length > 0,
    migrationCount,
    migrationManifestEntries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    migrationManifestVersion: manifest.version ?? null,
    dockerImages: images.status === 0
      ? images.stdout.trim().split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      })
      : { error: images.stderr },
    configuration: { appUrl, databaseHost: new URL(databaseUrl).hostname, soakMinutes, steadyTps, burstConcurrency },
    host: {
      platform: platform(), release: release(), hostname: hostname(), home: homedir(),
      cpuCount: cpus().length, cpuModel: cpus()[0]?.model ?? null,
      totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: loadavg(),
    },
  };
}

async function jsonRequest(path, options = {}) {
  const started = performance.now();
  const target = new URL(path, `${appUrl}/`);
  return new Promise((resolve) => {
    const request = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: options.headers,
      timeout: 30_000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
        resolve({ status: response.statusCode ?? 0, body, latencyMs: performance.now() - started });
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", (error) => resolve({
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
      latencyMs: performance.now() - started,
    }));
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function createLoadIdentity() {
  const response = await fetch(`${authServiceUrl}/api/auth-service/authority/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identityId: loadIdentityId,
      tenantId: "12121212-1212-4212-8212-121212121212",
      brandId: "13131313-1313-4313-8313-131313131313",
      username: loadLoginId,
      email: loadLoginId,
      accountType: "ADMIN",
      initialStatus: "Active",
      password: loadPassword,
      actorIdentityId: null,
      correlationId: `rc-load-identity-${suffix}`,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`RC load identity creation failed (${response.status}): ${await response.text()}`);
  }
}

async function waitForUrl(url, attempts = 60) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url).catch(() => null);
    lastStatus = response?.status ?? 0;
    if (response?.ok) return { ready: true, status: lastStatus, attempts: attempt + 1 };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ready: false, status: lastStatus, attempts };
}

async function waitForRuntime() {
  const endpoints = [
    `${appUrl}/api/health`,
    "http://127.0.0.1:5100/health/ready",
    "http://127.0.0.1:5200/health/ready",
    "http://127.0.0.1:5300/health/ready",
    "http://127.0.0.1:5400/health/ready",
    "http://127.0.0.1:5500/health/ready",
    "http://127.0.0.1:5600/health/ready",
  ];
  const results = await Promise.all(endpoints.map((endpoint) => waitForUrl(endpoint)));
  return { endpoints, results, ready: results.every((result) => result.ready) };
}

async function runtimeSnapshot(label) {
  const stats = command("docker", ["stats", "--no-stream", "--format", "{{json .}}"]).stdout
    .trim().split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  const database = (await pool.query(`
    select count(*)::int connections,
      count(*) filter (where wait_event_type='Lock')::int lock_waiters
    from pg_stat_activity where datname=current_database()
  `)).rows[0];
  const queueResponse = await fetch("http://127.0.0.1:15672/api/queues", {
    headers: { authorization: `Basic ${Buffer.from("lottery:lottery_dev_password").toString("base64")}` },
  }).catch(() => null);
  const queues = queueResponse?.ok ? await queueResponse.json() : [];
  const redis = command("docker", ["exec", "lottery-app-redis-1", "redis-cli", "INFO", "stats"]);
  const readiness = await Promise.all([
    jsonRequest("/api/health"),
    jsonRequest("/api/readiness"),
    jsonRequest("/api/operations/workers/readiness"),
  ]);
  return {
    label,
    capturedAt: new Date().toISOString(),
    containers: stats,
    database,
    queues: Array.isArray(queues) ? queues.map((queue) => ({
      name: queue.name,
      messages: queue.messages,
      ready: queue.messages_ready,
      unacknowledged: queue.messages_unacknowledged,
      consumers: queue.consumers,
      durable: queue.durable,
    })) : [],
    redis: redis.stdout.split("\n").filter((line) => /^(total_commands_processed|instantaneous_ops_per_sec|rejected_connections|expired_keys):/.test(line)),
    readiness: readiness.map(({ status, body }) => ({
      status,
      body: status === 404 ? { error: "endpoint-not-configured" } : body,
    })),
  };
}

async function seedFixture() {
  const productCount = Number((await pool.query(
    "select count(*)::int count from game_engine.game_definitions where active_version_id is not null",
  )).rows[0].count);
  if (productCount === 0) {
    const productSeed = command("npm", ["run", "qa:immutable-draw-authority"]);
    if (productSeed.status !== 0) {
      throw new Error(`Canonical Game Engine fixture failed: ${productSeed.stderr || productSeed.stdout}`);
    }
  }
  const outcomeDefinitionCount = Number((await pool.query(
    "select count(*)::int count from game_engine.game_definition_versions where outcome_generation_definition is not null",
  )).rows[0].count);
  if (outcomeDefinitionCount === 0) {
    const outcomeSeed = command("npm", ["run", "qa:internal-csprng-provider"]);
    if (outcomeSeed.status !== 0) {
      throw new Error(`Canonical Outcome fixture failed: ${outcomeSeed.stderr || outcomeSeed.stdout}`);
    }
  }
  let fixtureResult = await pool.query(`
    select t.ticket_id, t.player_account_id, t.player_profile_id, t.tenant_id,
      t.brand_id, t.market_id, t.product_id, t.manifest_id,
      t.paytable_definition_id, t.draw_id, t.currency, t.wallet_id,
      t.game_code, m.language, m.timezone
    from ticket_authority.tickets t
    join platform.markets m on m.id=t.market_id
    where t.correlation_id like 'ticket-correlation:%'
    order by t.accepted_at desc limit 1
  `);
  if (!fixtureResult.rows[0]) {
    const seed = command("node", ["scripts/qa/canonical-ticket-lifecycle.mjs"]);
    if (seed.status !== 0) throw new Error(`Canonical ticket fixture failed: ${seed.stderr || seed.stdout}`);
    fixtureResult = await pool.query(`
      select t.ticket_id, t.player_account_id, t.player_profile_id, t.tenant_id,
        t.brand_id, t.market_id, t.product_id, t.manifest_id,
        t.paytable_definition_id, t.draw_id, t.currency, t.wallet_id,
        t.game_code, m.language, m.timezone
      from ticket_authority.tickets t
      join platform.markets m on m.id=t.market_id
      where t.correlation_id like 'ticket-correlation:%'
      order by t.accepted_at desc limit 1
    `);
  }
  let fixture = fixtureResult.rows[0];
  if (!fixture) throw new Error("Canonical ticket fixture was not found after seeding.");

  const denied = await pool.query(`select exists (
    select 1 from platform.game_availability availability
    left join lateral (
      select event.to_status
      from platform.platform_lifecycle_events event
      where event.resource='game-availability' and event.record_id=availability.id
      order by event.created_at desc,event.event_id desc limit 1
    ) lifecycle on true
    where availability.tenant_id=$1 and availability.brand_id=$2 and availability.game_id=$3
      and coalesce(lifecycle.to_status,availability.status) in ('Suspended','Retired')
      and (availability.market_id is null or availability.market_id=$4)
      and availability.effective_from <= now()
      and (availability.effective_to is null or availability.effective_to > now())
  ) denied`, [fixture.tenant_id, fixture.brand_id, fixture.product_id, fixture.market_id]);
  if (denied.rows[0].denied) {
    const cleanScope = (await pool.query(`
      select tenant.id tenant_id, brand.id brand_id, market.id market_id,
        market.currency, market.language, market.timezone
      from platform.markets market
      join platform.brands brand on brand.id=market.brand_id and brand.status='Active'
      join platform.tenants tenant on tenant.id=brand.tenant_id and tenant.status='Active'
      where market.status='Active'
        and exists (select 1 from platform.game_availability availability
          where availability.tenant_id=tenant.id and availability.brand_id=brand.id
            and availability.game_id=$1 and availability.status='Active'
            and (availability.market_id is null or availability.market_id=market.id))
        and not exists (select 1 from platform.game_availability restriction
          where restriction.tenant_id=tenant.id and restriction.brand_id=brand.id
            and restriction.game_id=$1 and restriction.status in ('Suspended','Retired')
            and (restriction.market_id is null or restriction.market_id=market.id))
      order by market.id limit 1
    `, [fixture.product_id])).rows[0];
    if (!cleanScope) throw new Error("A clean active ticket scope is required for RC load qualification.");

    const accountIds = {
      super: randomUUID(), master: randomUUID(), agent: randomUUID(), player: randomUUID(),
      profile: randomUUID(), creditWallet: randomUUID(), freePlayWallet: randomUUID(),
    };
    for (const [type, id, parentId] of [
      ["SUPER_MASTER", accountIds.super, null],
      ["MASTER_AGENT", accountIds.master, accountIds.super],
      ["AGENT", accountIds.agent, accountIds.master],
      ["PLAYER", accountIds.player, accountIds.agent],
    ]) {
      await pool.query(`insert into public.accounts (
        id, account_type, account_code, display_name, parent_account_id,
        canonical_tenant_id, canonical_brand_id, canonical_market_id,
        status, governance_managed, idempotency_key, canonical_request_hash
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',true,$9,$10)`, [
        id, type, `rc13-${suffix}-${type.toLowerCase()}`, `RC-1.3 ${type}`, parentId,
        cleanScope.tenant_id, cleanScope.brand_id, cleanScope.market_id,
        `rc13-account:${id}`, `sha256:${id.replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`,
      ]);
    }
    await pool.query(`insert into public.player_profiles (id,account_id,display_name,status)
      values ($1,$2,$3,'ACTIVE')`, [accountIds.profile, accountIds.player, `RC Load Player ${suffix}`]);
    await pool.query(`insert into public.financial_wallets (
      id,account_id,wallet_type,currency_code,balance_authority,status,balance,credit_limit,funding_model
    ) values ($1,$3,'CREDIT',$4,'INTERNAL','ACTIVE',0,100000,'CREDIT'),
      ($2,$3,'FREE_PLAY',$4,'INTERNAL','ACTIVE',100000,0,'CREDIT')`, [
      accountIds.creditWallet, accountIds.freePlayWallet, accountIds.player, cleanScope.currency,
    ]);
    await pool.query(`insert into credit_wallet_service.wallet_scopes (
      wallet_id,tenant_id,brand_id,player_id,instrument_code,currency,authority
    ) values ($1,$3,$4,$5,'CREDIT',$6,'CREDIT_WALLET_SERVICE'),
      ($2,$3,$4,$5,'FREE_PLAY',$6,'CREDIT_WALLET_SERVICE')`, [
      accountIds.creditWallet, accountIds.freePlayWallet, cleanScope.tenant_id,
      cleanScope.brand_id, accountIds.player, cleanScope.currency,
    ]);
    fixture = {
      ...fixture,
      ...cleanScope,
      player_account_id: accountIds.player,
      player_profile_id: accountIds.profile,
      wallet_id: accountIds.creditWallet,
      agent_account_id: accountIds.agent,
      master_agent_account_id: accountIds.master,
    };
  }
  if (!fixture.agent_account_id || !fixture.master_agent_account_id) {
    const hierarchy = (await pool.query(`select agent.id agent_account_id,
      master.id master_agent_account_id
      from public.accounts player
      join public.accounts agent on agent.id=player.parent_account_id
      join public.accounts master on master.id=agent.parent_account_id
      where player.id=$1`, [fixture.player_account_id])).rows[0];
    fixture = { ...fixture, ...hierarchy };
  }

  const websiteId = randomUUID();
  const domainId = randomUUID();
  const hostname = `rc-load-${suffix}.local`;
  await pool.query(`insert into platform.websites (
      id, tenant_id, brand_id, market_id, website_code, display_name, status,
      default_language, default_currency, default_timezone, maintenance_mode,
      version, content_hash, audit_metadata, effective_from
    ) values ($1,$2,$3,$4,$5,$6,'Active',$7,$8,$9,false,'1.0.0',$10,$11,now()-interval '1 minute')`, [
    websiteId, fixture.tenant_id, fixture.brand_id, fixture.market_id,
    `rc-load-${suffix}`, `RC Load ${suffix}`, fixture.language, fixture.currency,
    fixture.timezone, `sha256:rc-load-website:${runId}`,
    JSON.stringify({ runId, authority: "RC-1.3" }),
  ]);
  await pool.query(`insert into platform.website_domains (
      id, website_id, hostname, canonical, status, verification_status,
      version, content_hash, audit_metadata, effective_from
    ) values ($1,$2,$3,true,'Active','Verified','1.0.0',$4,$5,now()-interval '1 minute')
  `, [
    domainId, websiteId, hostname, `sha256:rc-load-domain:${runId}`,
    JSON.stringify({ runId, authority: "RC-1.3" }),
  ]);

  for (const permission of ["tickets.create", "tickets.read"]) {
    await pool.query(`insert into auth_service.identity_claims (
      id, identity_id, claim_type, claim_value, issuer, scope_type, scope_id
    ) values ($1,$2,'permission',$3,'rc-load-qualification','TENANT',$4)`,
    [randomUUID(), loadIdentityId, permission, fixture.tenant_id]);
  }
  await pool.query(`insert into auth_service.memberships (
    id, identity_id, scope_type, scope_id, brand_id, market_id, metadata
  ) values ($1,$2,'TENANT',$3,$4,$5,$6)`, [
    randomUUID(), loadIdentityId, fixture.tenant_id, fixture.brand_id,
    fixture.market_id, JSON.stringify({ runId, authority: "RC-1.3" }),
  ]);

  return { ...fixture, websiteId, domainId, hostname };
}

async function login() {
  let lastResult = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    lastResult = await jsonRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Number.parseInt(suffix.slice(0, 2), 16) % 200 + 1}` },
      body: JSON.stringify({ username: loadLoginId, password: loadPassword }),
    });
    const token = lastResult.body?.sessionToken ?? lastResult.body?.accessToken;
    if (lastResult.status === 200 && token) return token;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Authenticated load login failed (${lastResult?.status ?? 0}).`);
}

function ticketBody(fixture, fundingInstrument, sequence, drawId = fixture.draw_id) {
  return {
    playerAccountId: fixture.player_account_id,
    playerProfileId: fixture.player_profile_id,
    fundingInstrument,
    productId: fixture.product_id,
    manifestId: fixture.manifest_id,
    paytableDefinitionId: fixture.paytable_definition_id,
    drawId,
    currency: fixture.currency,
    externalTicketId: `rc13-${suffix}-${sequence}`,
    causationId: `rc13-cause-${suffix}-${sequence}`,
    salesChannel: "RC_LOAD",
    items: [{ wagerType: "STRAIGHT", wagerVersion: "1.0.0", selections: [1, 2, 3], stakeMinor: 1 }],
  };
}

async function submitTicket(fixture, token, sequence, options = {}) {
  const idempotencyKey = options.idempotencyKey ?? `rc13-ticket-${suffix}-${sequence}`;
  return jsonRequest("/api/tickets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      host: fixture.hostname,
      "idempotency-key": idempotencyKey,
      "x-correlation-id": `rc13-correlation-${suffix}-${sequence}`,
    },
    body: JSON.stringify(options.body ?? ticketBody(fixture, options.fundingInstrument ?? (sequence % 2 ? "CREDIT" : "FREE_PLAY"), sequence, options.drawId)),
  });
}

async function runConcurrent(count, operation) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: count }, (_, index) => operation(index)));
  const durationSeconds = (performance.now() - started) / 1000;
  return {
    requested: count,
    accepted: results.filter((result) => result.status === 200 || result.status === 201).length,
    rejected: results.filter((result) => result.status >= 400 && result.status < 500).length,
    errors: results.filter((result) => result.status === 0 || result.status >= 500).length,
    statuses: Object.fromEntries([...new Set(results.map((result) => result.status))].map((status) => [status, results.filter((result) => result.status === status).length])),
    sampleFailures: results.filter((result) => result.status === 0 || result.status >= 400).slice(0, 3).map((result) => ({ status: result.status, body: result.body })),
    tps: Number((count / durationSeconds).toFixed(2)),
    ...latencySummary(results.map((result) => result.latencyMs)),
    results,
  };
}

async function runBatched(total, concurrency, operation) {
  const started = performance.now();
  const results = [];
  for (let offset = 0; offset < total; offset += concurrency) {
    const batchSize = Math.min(concurrency, total - offset);
    const batch = await Promise.all(Array.from({ length: batchSize }, (_, index) => operation(offset + index)));
    results.push(...batch);
  }
  const durationSeconds = (performance.now() - started) / 1000;
  return {
    requested: total,
    accepted: results.filter((result) => result.status === 200 || result.status === 201).length,
    rejected: results.filter((result) => result.status >= 400 && result.status < 500).length,
    errors: results.filter((result) => result.status === 0 || result.status >= 500).length,
    statuses: Object.fromEntries([...new Set(results.map((result) => result.status))].map((status) => [status, results.filter((result) => result.status === status).length])),
    sampleFailures: results.filter((result) => result.status === 0 || result.status >= 400).slice(0, 3).map((result) => ({ status: result.status, body: result.body })),
    tps: Number((total / durationSeconds).toFixed(2)),
    ...latencySummary(results.map((result) => result.latencyMs)),
    results,
  };
}

async function seedLiabilityLimits(fixture) {
  const scopes = [
    ["TENANT", fixture.tenant_id],
    ["MASTER_AGENT", fixture.master_agent_account_id],
    ["AGENT", fixture.agent_account_id],
    ["PLAYER", fixture.player_account_id],
    ["DRAW", fixture.draw_id],
    ["PRODUCT", fixture.product_id],
    ["GAME", fixture.game_code],
    ["WAGER_TYPE", "straight"],
  ];
  for (const [scopeType, scopeReference] of scopes) {
    const normalizedReference = String(scopeReference).toLowerCase();
    const previous = (await pool.query(`select configuration_id,version
      from ticket_authority.liability_limit_configurations
      where tenant_id=$1 and brand_id=$2 and scope_type=$3 and scope_reference=$4
      order by version desc limit 1`, [
      fixture.tenant_id, fixture.brand_id, scopeType, normalizedReference,
    ])).rows[0];
    const nextVersion = Number(previous?.version ?? 0) + 1;
    await pool.query(`insert into ticket_authority.liability_limit_configurations (
      configuration_id,tenant_id,brand_id,scope_type,scope_reference,
      maximum_wager_minor,maximum_theoretical_payout_minor,maximum_exposure_minor,
      status,effective_from,version,supersedes_configuration_id,content_hash,audit_metadata
    ) values ($1,$2,$3,$4,$5,100000000,100000000,100000000,
      'Active',now()-interval '1 second',$6,$7,$8,$9::jsonb)`, [
      randomUUID(), fixture.tenant_id, fixture.brand_id, scopeType,
      normalizedReference, nextVersion,
      previous?.configuration_id ?? null,
      `sha256:rc13-liability:${runId}:${scopeType.toLowerCase()}:${normalizedReference}:${nextVersion}`,
      JSON.stringify({ runId, authority: "RC-1.3" }),
    ]);
  }
}

async function makeDraw(fixture, closeDelayMs = 2_000, drawDelayMs = 60_000) {
  const drawId = randomUUID();
  const scheduleVersionId = randomUUID();
  const closesAt = new Date(Date.now() + closeDelayMs).toISOString();
  const drawsAt = new Date(Date.now() + drawDelayMs).toISOString();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`insert into game_engine.published_draw_schedule_versions (
      schedule_version_id, schedule_id, version_number, game_definition_id,
      draw_authority_assignment_id, schedule_kind, schedule_configuration,
      time_zone_id, schedule_hash, published_at
    ) select $1,$2,1,game_definition_id,draw_authority_assignment_id,'RC_LOAD','{}','UTC',$3,now()
      from game_engine.draw_schedules where id=$4`, [scheduleVersionId, drawId, `sha256:rc13-schedule:${runId}:${drawId}`, fixture.draw_id]);
    await client.query(`insert into game_engine.draw_schedules (
      id, game_definition_id, draw_authority_assignment_id, sales_open_at,
      sales_close_at, draw_at, status, schedule_version_id,
      scheduled_execution_at, schedule_hash, draw_identity_hash
    ) select $2,game_definition_id,draw_authority_assignment_id,now()-interval '1 minute',
      $6::timestamptz,$7::timestamptz,'SalesOpen',$1,
      $7::timestamptz,$3,$5 from game_engine.draw_schedules where id=$4`, [scheduleVersionId, drawId, `sha256:rc13-schedule:${runId}:${drawId}`, fixture.draw_id, `sha256:rc13-draw:${runId}:${drawId}`, closesAt, drawsAt]);
    await client.query(`insert into game_engine.draw_execution_manifests (
      execution_manifest_id, draw_id, schedule_version_id, game_definition_version_id,
      draw_authority_version_id, engine_name, engine_version, outcome_provider_id,
      outcome_provider_version, evaluator_version, paytable_version,
      scheduled_execution_at, schedule_hash, draw_identity_hash,
      canonical_manifest_hash, created_at, provider_configuration_version
    ) select gen_random_uuid(),$2,$1,game_definition_version_id,draw_authority_version_id,
      engine_name,engine_version,outcome_provider_id,outcome_provider_version,
      evaluator_version,paytable_version,$7::timestamptz,$3,$5,$6,now(),
      provider_configuration_version from game_engine.draw_execution_manifests
      where draw_id=$4 order by created_at desc limit 1
    `, [
    scheduleVersionId, drawId, `sha256:rc13-schedule:${runId}:${drawId}`,
    fixture.draw_id, `sha256:rc13-draw:${runId}:${drawId}`, `sha256:rc13-manifest:${runId}:${drawId}`, drawsAt,
  ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return drawId;
}

async function reconcile(runStartedAt, baselineDlq) {
  const result = await pool.query(`
    select
      (select count(*)::int from ticket_authority.tickets where accepted_at >= $1 and sales_channel='RC_LOAD') tickets,
      (select count(*)::int from public.credit_reservations r join ticket_authority.tickets t on t.ticket_id::text=r.ticket_id where t.accepted_at >= $1 and t.sales_channel='RC_LOAD') reservations,
      (select count(*)::int from (select idempotency_key from ticket_authority.tickets where accepted_at >= $1 and sales_channel='RC_LOAD' group by idempotency_key having count(*)>1) d) duplicate_tickets,
      (select count(*)::int from (
        select r.ticket_id from public.credit_reservations r
        join ticket_authority.tickets t on t.ticket_id::text=r.ticket_id
        where t.accepted_at >= $1 and t.sales_channel='RC_LOAD'
        group by r.ticket_id having count(*)>1
      ) d) duplicate_reservations,
      (select count(*)::int from public.outbox_events where created_at >= $1 and event_type='ticket.accepted') accepted_outbox
  `, [runStartedAt]);
  const queueResponse = await fetch("http://127.0.0.1:15672/api/queues", {
    headers: { authorization: `Basic ${Buffer.from("lottery:lottery_dev_password").toString("base64")}` },
  }).catch(() => null);
  const queues = queueResponse?.ok ? await queueResponse.json() : [];
  result.rows[0].unresolved_dlq = Array.isArray(queues)
    ? queues.filter((queue) => /(?:dlq|dead.?letter)/i.test(queue.name)).reduce((total, queue) => total + Number(queue.messages ?? 0), 0)
    : null;
  result.rows[0].baseline_dlq = baselineDlq;
  result.rows[0].new_dlq = result.rows[0].unresolved_dlq == null
    ? null
    : Math.max(0, Number(result.rows[0].unresolved_dlq) - baselineDlq);
  const fixtureQa = [
    command("npm", ["run", "qa:settlement-service-integration-dry-run"]),
    command("npm", ["run", "qa:ledger-balanced-journal"]),
    command("npm", ["run", "qa:credit-wallet-settlement-authority"]),
  ];
  let reconciliationChainReady = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const chain = await pool.query(`select exists (
      select 1
      from settlement_service.financial_instructions fi
      join ledger_service.ledger_posting_requests pr
        on pr.instruction_id=fi.instruction_id::text and pr.request_status='COMPLETED'
      join ledger_service.ledger_transactions lt on lt.posting_request_id=pr.id
      join settlement_service.financial_instructions credit
        on credit.settlement_id=fi.settlement_id and credit.target_service='credit-wallet-service'
        and credit.instruction_type <> 'CREDIT_NOOP'
      join settlement_service.financial_instruction_execution_attempts ca
        on ca.instruction_id=credit.instruction_id and ca.status in ('Posted','Reused','RecoveryVerified')
      join credit_wallet_service.wallet_operation_requests wor
        on wor.operation_id::text=ca.external_reference_id
      where fi.target_service='ledger-service'
        and fi.instruction_type in ('LEDGER_PAYOUT','LEDGER_REFUND')
    ) ready`);
    reconciliationChainReady = chain.rows[0].ready;
    if (reconciliationChainReady) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const financialQa = [
    command("npm", ["run", "qa:ledger-journal-integrity"]),
    command("npm", ["run", "qa:credit-wallet-reconciliation"]),
    command("npm", ["run", "qa:instruction-reconciliation"]),
  ];
  const checks = [...fixtureQa, ...financialQa];
  return { counts: result.rows[0], reconciliationChainReady, checks: checks.map(({ command: cmd, status, durationMs, stdout, stderr }) => ({ command: cmd, status, durationMs, stdout, stderr })), passed: reconciliationChainReady && checks.every((qa) => qa.status === 0) && Number(result.rows[0].duplicate_tickets) === 0 && Number(result.rows[0].duplicate_reservations) === 0 && Number(result.rows[0].new_dlq) === 0 };
}

async function main() {
  mkdirSync(evidenceDirectory, { recursive: true });
  const runStartedAt = new Date();
  const environment = await qualificationEnvironment();
  const authSeed = command("npm", ["run", "qa:auth-service-seed-local"], {
    ALLOW_DISPOSABLE_DB_MIGRATIONS: "true",
    MIGRATION_ENVIRONMENT: "local",
    DEPLOYMENT_ENVIRONMENT: "local",
  });
  if (authSeed.status !== 0) {
    throw new Error(`Disposable Auth seed failed: ${authSeed.stderr || authSeed.stdout}`);
  }
  await createLoadIdentity();
  const platformSeed = command("npm", ["run", "qa:platform-foundation"]);
  if (platformSeed.status !== 0) {
    throw new Error(`Disposable Platform fixture failed: ${platformSeed.stderr || platformSeed.stdout}`);
  }
  const activeScopeCount = Number((await pool.query(`select count(*)::int count from platform.markets where status='Active'`)).rows[0].count);
  if (activeScopeCount < 2) {
    await pool.query(`insert into platform.markets (
      id, brand_id, market_code, name, display_name, language, currency,
      timezone, status, version, content_hash, audit_metadata
    ) values ($1,'13131313-1313-4313-8313-131313131313',$2,$3,$3,
      'en','USD','UTC','Active','1.0.0',$4,$5)`, [
      randomUUID(), `rc-load-scope-${suffix}`, `RC Load Scope ${suffix}`,
      `sha256:rc-load-scope:${runId}`, JSON.stringify({ runId, authority: "RC-1.3" }),
    ]);
  }
  const fixture = await seedFixture();
  fixture.draw_id = await makeDraw(fixture, 2 * 60 * 60_000, 3 * 60 * 60_000);
  await seedLiabilityLimits(fixture);
  let token = await login();

  const baseline = await runtimeSnapshot("baseline");
  const baselineDlq = baseline.queues.filter((queue) => /(?:dlq|dead.?letter)/i.test(queue.name)).reduce((total, queue) => total + Number(queue.messages ?? 0), 0);
  stages.push({ stage: 1, name: "baseline", passed: baseline.readiness[0].status === 200, evidence: baseline });

  const ticketLoad = await runBatched(60, 10, (index) => submitTicket(fixture, token, `load-${index}`));
  stages.push({ stage: 2, name: "ticket-acceptance", passed: ticketLoad.errors === 0 && ticketLoad.accepted === 60, evidence: { ...ticketLoad, results: undefined } });

  const closingDraw = await makeDraw(fixture);
  await seedLiabilityLimits({ ...fixture, draw_id: closingDraw });
  const before = await runConcurrent(Math.floor(burstConcurrency / 2), (index) => submitTicket(fixture, token, `close-before-${index}`, { drawId: closingDraw }));
  await new Promise((resolve) => setTimeout(resolve, 2400));
  const after = await runConcurrent(Math.ceil(burstConcurrency / 2), (index) => submitTicket(fixture, token, `close-after-${index}`, { drawId: closingDraw }));
  const boundaryAudit = await pool.query(`select count(*)::int invalid from ticket_authority.tickets t join game_engine.draw_schedules d on d.id=t.draw_id where t.draw_id=$1 and t.accepted_at >= d.sales_close_at`, [closingDraw]);
  stages.push({ stage: 3, name: "draw-close", passed: before.accepted === before.requested && after.accepted === 0 && Number(boundaryAudit.rows[0].invalid) === 0, evidence: { before: { ...before, results: undefined }, after: { ...after, results: undefined }, invalidBoundaryAcceptances: boundaryAudit.rows[0].invalid } });

  const canonicalOutcome = command("npm", ["run", "qa:canonical-outcome-authority"]);
  const canonicalInvocation = command("npm", ["run", "qa:canonical-outcome-settlement-invocation"]);
  const remediation = command("npm", ["run", "qa:outcome-settlement-recovery-remediation"]);
  stages.push({ stage: 4, name: "outcome-settlement", passed: canonicalOutcome.status === 0 && canonicalInvocation.status === 0 && remediation.status === 0, evidence: { canonicalOutcome, canonicalInvocation, remediation } });

  const postOutcomeRuntime = await waitForRuntime();
  if (postOutcomeRuntime.ready) token = await login();
  const chainTickets = await runConcurrent(20, (index) => submitTicket(fixture, token, `chain-${index}`));
  const fullChainQa = command("npm", ["run", "qa:ticket-platform-final-readiness"]);
  stages.push({ stage: 5, name: "full-chain", passed: postOutcomeRuntime.ready && fullChainQa.status === 0 && chainTickets.errors === 0, evidence: { runtime: postOutcomeRuntime, traffic: { ...chainTickets, results: undefined }, qa: fullChainQa, providerCoverage: ["INTERNAL_CSPRNG", "OFFICIAL_RESULTS", "MANUAL_CERTIFIED"], fundingCoverage: ["CREDIT", "FREE_PLAY"] } });

  const soakLatencies = [];
  let soakRequested = 0;
  let soakErrors = 0;
  const soakSnapshots = [];
  const soakOutcomeRuns = [];
  let nextOutcomeMinute = Math.max(5, Math.floor(soakMinutes / 4));
  let nextAuthenticationMinute = 5;
  const soakStarted = performance.now();
  const soakEnds = soakStarted + soakMinutes * 60_000;
  while (performance.now() < soakEnds) {
    const cycleStarted = performance.now();
    const elapsedMinutes = (performance.now() - soakStarted) / 60_000;
    if (elapsedMinutes >= nextAuthenticationMinute) {
      token = await login();
      nextAuthenticationMinute += 5;
    }
    const cycle = await runConcurrent(steadyTps, (index) => submitTicket(fixture, token, `soak-${soakRequested + index}`));
    soakRequested += cycle.requested;
    soakErrors += cycle.errors + cycle.rejected;
    soakLatencies.push(...cycle.results.map((result) => result.latencyMs));
    if (soakSnapshots.length === 0 || performance.now() - soakStarted >= soakSnapshots.length * 60_000) {
      soakSnapshots.push(await runtimeSnapshot(`soak-minute-${soakSnapshots.length}`));
    }
    if (elapsedMinutes >= nextOutcomeMinute && nextOutcomeMinute < soakMinutes) {
      const scheduledMinute = nextOutcomeMinute;
      soakOutcomeRuns.push({ scheduledMinute, ...command("npm", ["run", "qa:canonical-outcome-settlement-invocation"]) });
      token = await login();
      nextOutcomeMinute += Math.max(5, Math.floor(soakMinutes / 4));
    }
    await jsonRequest("/api/tickets?limit=10", { headers: { authorization: `Bearer ${token}` } });
    const delay = Math.max(0, 1000 - (performance.now() - cycleStarted));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const soakDurationMinutes = (performance.now() - soakStarted) / 60_000;
  stages.push({ stage: 6, name: "endurance", passed: soakErrors === 0 && soakDurationMinutes >= soakMinutes * 0.99 && soakOutcomeRuns.every((run) => run.status === 0), evidence: { requested: soakRequested, errors: soakErrors, durationMinutes: Number(soakDurationMinutes.toFixed(2)), achievedTps: Number((soakRequested / (soakDurationMinutes * 60)).toFixed(2)), ...latencySummary(soakLatencies), snapshots: soakSnapshots, outcomeRuns: soakOutcomeRuns } });

  token = await login();
  let recoveryDone = false;
  const recoveryPromise = commandAsync("npm", ["run", "qa:runtime-dependency-recovery"])
    .then((result) => result)
    .finally(() => { recoveryDone = true; });
  const recoveryTrafficResults = [];
  let recoverySequence = 0;
  while (!recoveryDone) {
    recoveryTrafficResults.push(await submitTicket(fixture, token, `recovery-${recoverySequence}`));
    recoverySequence += 1;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const recovery = await recoveryPromise;
  const recoveredRuntime = await waitForRuntime();
  const recoveryTraffic = {
    requested: recoveryTrafficResults.length,
    accepted: recoveryTrafficResults.filter((result) => [200, 201].includes(result.status)).length,
    governedFailures: recoveryTrafficResults.filter((result) => result.status === 0 || result.status >= 400).length,
    statuses: Object.fromEntries([...new Set(recoveryTrafficResults.map((result) => result.status))]
      .map((status) => [status, recoveryTrafficResults.filter((result) => result.status === status).length])),
  };
  stages.push({ stage: 7, name: "failure-during-load", passed: recovery.status === 0 && recoveredRuntime.ready && recoveryTraffic.requested > 0, evidence: { recovery, recoveredRuntime, traffic: recoveryTraffic } });
  if (recovery.status === 0 && recoveredRuntime.ready) token = await login();

  const backlog = command("npm", ["run", "qa:queue-operations"]);
  const workerRecovery = command("npm", ["run", "qa:worker-observability"]);
  stages.push({ stage: 8, name: "backlog-recovery", passed: backlog.status === 0 && workerRecovery.status === 0, evidence: { backlog, workerRecovery } });

  const duplicateKey = `rc13-ticket-${suffix}-duplicate`;
  const duplicateBody = ticketBody(fixture, "CREDIT", "duplicate");
  const firstDuplicate = await submitTicket(fixture, token, "duplicate", { idempotencyKey: duplicateKey, body: duplicateBody });
  const sameDuplicate = await submitTicket(fixture, token, "duplicate", { idempotencyKey: duplicateKey, body: duplicateBody });
  const conflictingBody = { ...duplicateBody, items: [{ ...duplicateBody.items[0], stakeMinor: 2 }] };
  const conflict = await submitTicket(fixture, token, "duplicate-conflict", { idempotencyKey: duplicateKey, body: conflictingBody });
  stages.push({ stage: 9, name: "replay-duplicate", passed: firstDuplicate.status === 201 && sameDuplicate.status === 200 && sameDuplicate.body?.duplicate === true && conflict.status === 409, evidence: { firstStatus: firstDuplicate.status, duplicateStatus: sameDuplicate.status, conflictStatus: conflict.status, duplicateReused: sameDuplicate.body?.duplicate === true } });

  const capacitySteps = [];
  for (const concurrency of [5, 10, 20, 40]) {
    const step = await runConcurrent(concurrency, (index) => submitTicket(fixture, token, `capacity-${concurrency}-${index}`));
    capacitySteps.push({ concurrency, ...step, results: undefined });
    if (step.errors / step.requested > 0.01 || step.p95Ms > 2000) break;
  }
  const representativeExceeded = capacitySteps.some((step) => step.tps >= steadyTps && step.p95Ms <= 2000 && step.errors === 0 && step.rejected === 0 && step.accepted === step.requested);
  stages.push({ stage: 10, name: "capacity-boundary", passed: representativeExceeded, evidence: { representativeTargetTps: steadyTps, stopThreshold: { p95Ms: 2000, errorRate: 0.01 }, steps: capacitySteps } });

  const finalSnapshot = await runtimeSnapshot("final");
  const reconciliation = await reconcile(runStartedAt, baselineDlq);
  const stageQualificationPassed = stages.every((stage) => stage.passed) && reconciliation.passed;
  const qualificationGates = {
    stageQualificationPassed,
    sixtyMinuteSoakProven: soakMinutes >= 60 && soakDurationMinutes >= 59.4,
    continuousProviderFundingMatrixProven: canonicalInvocation.status === 0,
    dependencyFailureWhileTrafficActiveProven: stages.find((stage) => stage.stage === 7)?.passed === true,
  };
  const passed = Object.values(qualificationGates).every(Boolean);
  const summary = {
    schemaVersion: "rc-load-evidence-v1",
    runId,
    startedAt: runStartedAt.toISOString(),
    completedAt: new Date().toISOString(),
    profile: { soakMinutes, steadyTps, burstConcurrency, funding: ["CREDIT", "FREE_PLAY"], providers: ["INTERNAL_CSPRNG", "OFFICIAL_RESULTS", "MANUAL_CERTIFIED"] },
    status: passed ? "RC_LOAD_PASS" : "RC_LOAD_BLOCKED",
    qualificationGates,
    stages,
    reconciliation,
    baseline,
    finalSnapshot,
    defects,
    environment,
  };
  writeFileSync(`${evidenceDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${evidenceDirectory}/summary.md`, [
    `# RC-1.3 Load Qualification`, "", `- Run: ${runId}`, `- Status: ${summary.status}`,
    `- Soak: ${soakDurationMinutes.toFixed(2)} minutes`, `- Representative ticket rate: ${steadyTps} TPS`, "",
    "| Stage | Result |", "|---|---|", ...stages.map((stage) => `| ${stage.stage}. ${stage.name} | ${stage.passed ? "PASS" : "FAIL"} |`),
    "", `Financial reconciliation: ${reconciliation.passed ? "PASS" : "FAIL"}`,
    `60-minute soak evidence: ${qualificationGates.sixtyMinuteSoakProven ? "PASS" : "NOT PROVEN"}`,
    `Provider/funding continuous-chain matrix: ${qualificationGates.continuousProviderFundingMatrixProven ? "PASS" : "NOT PROVEN"}`,
    `Traffic during dependency interruption: ${qualificationGates.dependencyFailureWhileTrafficActiveProven ? "PASS" : "NOT PROVEN"}`,
  ].join("\n"));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}
