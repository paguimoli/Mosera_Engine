import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const gameEngineUrl = (process.env.GAME_ENGINE_URL ?? "http://127.0.0.1:5500").replace(/\/$/, "");
if (!databaseUrl) throw new Error("DATABASE_URL is required for Game Engine production activation QA.");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks = [];
const pass = (name) => checks.push({ name, status: "PASS" });
const assert = (condition, name) => {
  if (!condition) throw new Error(name);
  pass(name);
};

async function expectSavepointFailure(client, name, action) {
  await client.query("savepoint expected_failure");
  try {
    await action();
    throw new Error(`${name}: operation unexpectedly succeeded.`);
  } catch {
    await client.query("rollback to savepoint expected_failure");
    pass(name);
  }
}

async function appendStage(client, target, stage, suffix) {
  await client.query(
    `insert into game_engine.game_engine_production_activation_events (
       activation_event_id, provider_id, provider_version, configuration_version,
       stage, actor_reference, reason_code, approval_reference,
       signing_provider_id, signing_provider_version, signing_key_version,
       canonical_request_hash, evidence_hash, idempotency_key, created_at)
     values ($1,$2,$3,$4,$5,'qa:bf-4.9','QA_ACTIVATION','qa:approval',
       'mosera-software-signing','1.0.0','key-v1',$6,$7,$8,clock_timestamp())`,
    [
      randomUUID(), target.provider_id, target.provider_version, target.configuration_version, stage,
      `sha256:${suffix.padEnd(64, "0").slice(0, 64)}`,
      `sha256:${`${suffix}e`.padEnd(64, "0").slice(0, 64)}`,
      `qa-bf-4.9:${suffix}:${stage}`,
    ],
  );
}

async function main() {
  try {
    const migration = await pool.query(
      `select status from platform_migrations.migration_history
       where migration_id = '100_add_game_engine_production_activation'`,
    );
    assert(migration.rows[0]?.status === "APPLIED", "migration 100 is applied");

    const targetResult = await pool.query(
      `select provider_id, provider_version, configuration_version
       from game_engine.game_engine_production_activation_events
       where provider_id = 'mosera-internal-csprng' and provider_version = '2.0.0'
       order by created_at desc, activation_event_id desc limit 1`,
    );
    assert(targetResult.rows[0]?.configuration_version === "1", "Internal CSPRNG is registered exactly once for governed activation");
    const target = targetResult.rows[0];

    const source = readFileSync(
      "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomeProviderRepository.cs",
      "utf8",
    );
    assert(
      source.includes("game_engine.game_engine_production_activation_events") &&
        !source.includes("from game_engine.outcome_provider_activation_events"),
      "runtime provider resolution has one production activation source",
    );

    const legacy = await pool.query(
      `select tgname from pg_trigger
       where tgrelid = 'game_engine.outcome_provider_activation_events'::regclass
         and tgname = 'trg_reject_legacy_provider_enablement' and not tgisinternal`,
    );
    assert(legacy.rowCount === 1, "legacy provider enablement is rejected");

    const client = await pool.connect();
    try {
      await client.query("begin");
      await expectSavepointFailure(client, "activation state cannot skip READY", () =>
        appendStage(client, target, "APPROVED", "skip-approved"),
      );
      await appendStage(client, target, "READY", "ready");
      await appendStage(client, target, "APPROVED", "approved");
      await appendStage(client, target, "PRODUCTION_ACTIVE", "active");
      const current = await client.query(
        `select stage from game_engine.game_engine_production_activation_events
         where provider_id=$1 and provider_version=$2 and configuration_version=$3
         order by created_at desc, activation_event_id desc limit 1`,
        [target.provider_id, target.provider_version, target.configuration_version],
      );
      assert(current.rows[0]?.stage === "PRODUCTION_ACTIVE", "registered provider advances through Ready and Approved to ProductionActive");
      await expectSavepointFailure(client, "duplicate production activation is rejected", () =>
        appendStage(client, target, "PRODUCTION_ACTIVE", "duplicate-active"),
      );
      await expectSavepointFailure(client, "activation evidence is append-only", () =>
        client.query(
          `update game_engine.game_engine_production_activation_events set reason_code='tampered'
           where provider_id=$1 and provider_version=$2 and configuration_version=$3`,
          [target.provider_id, target.provider_version, target.configuration_version],
        ),
      );
      await client.query("rollback");
    } finally {
      client.release();
    }

    const readinessResponse = await fetch(
      `${gameEngineUrl}/api/game-engine/production-activation/readiness?providerId=mosera-internal-csprng&providerVersion=2.0.0&configurationVersion=1`,
    );
    const readiness = await readinessResponse.json();
    assert(readinessResponse.ok && readiness.success === true, "authoritative production readiness endpoint responds");
    assert(
      readiness.readiness.currentStage === "Registered" &&
        readiness.readiness.activationExplicitlyEnabled === false &&
        readiness.readiness.productionActive === false &&
        readiness.automaticActivationEnabled === false,
      "production activation remains explicit and disabled by default",
    );
    assert(
      readiness.readiness.signing.signingEnabled === false &&
        readiness.readiness.blockers.some((blocker) => blocker.includes("GAME_ENGINE_PRODUCTION_ACTIVATION_ENABLED")),
      "missing activation and signing configuration fail closed",
    );

    const unknown = await fetch(
      `${gameEngineUrl}/api/game-engine/production-activation/readiness?providerId=unknown&providerVersion=1&configurationVersion=1`,
    );
    const unknownBody = await unknown.json();
    assert(
      unknown.ok && unknownBody.readiness.target === null && unknownBody.readiness.activationAllowed === false,
      "unknown provider readiness fails closed",
    );

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
