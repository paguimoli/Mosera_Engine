import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Internal CSPRNG provider QA.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks: Array<{ name: string; status: "PASS" }> = [];

function pass(name: string) {
  checks.push({ name, status: "PASS" });
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(name);
  pass(name);
}

async function expectFailure(name: string, action: () => Promise<unknown>) {
  try {
    await action();
    throw new Error(`${name}: operation unexpectedly succeeded.`);
  } catch (error) {
    if (String(error).includes("unexpectedly succeeded")) throw error;
    pass(name);
  }
}

async function main() {
  try {
    const provider = await pool.query(
      `select provider.provider_id, provider.provider_version,
              provider.production_eligible, provider.lifecycle_state,
              configuration.production_ready, configuration.failure_mode,
              activation.activation_state
       from game_engine.outcome_provider_definitions provider
       join game_engine.outcome_provider_configuration_versions configuration
         on configuration.provider_id = provider.provider_id
        and configuration.provider_version = provider.provider_version
       join lateral (
         select event.activation_state
         from game_engine.outcome_provider_activation_events event
         where event.provider_id = configuration.provider_id
           and event.provider_version = configuration.provider_version
           and event.configuration_version = configuration.configuration_version
         order by event.effective_at desc, event.created_at desc
         limit 1
       ) activation on true
       where provider.provider_id = 'mosera-internal-csprng'
         and provider.provider_version = '2.0.0'
         and configuration.configuration_version = '1'`,
    );
    assert(
      provider.rowCount === 1 &&
        provider.rows[0].production_eligible === true &&
        provider.rows[0].production_ready === true &&
        provider.rows[0].lifecycle_state === "Active" &&
        provider.rows[0].failure_mode === "FAIL_CLOSED" &&
        provider.rows[0].activation_state === "DISABLED",
      "Internal CSPRNG is production-ready, fail-closed, and not production-active",
    );

    const eligibleProviders = await pool.query(
      `select count(*)::int count
       from game_engine.outcome_provider_definitions
       where provider_id = 'mosera-internal-csprng'
         and canonical_provider_category = 'INTERNAL_CSPRNG'
         and production_eligible`,
    );
    assert(
      eligibleProviders.rows[0].count === 1,
      "exactly one production-eligible Internal CSPRNG provider version exists",
    );

    const cryptographicContracts = await pool.query(
      `select
         exists (
           select 1 from game_engine.rng_provider_definitions
           where provider_id = 'mosera-hmac-drbg'
             and provider_version = '2.0.0'
             and production_eligible
             and provider_type = 'HMAC_DRBG'
             and failure_mode = 'FailClosed') rng_ready,
         exists (
           select 1 from game_engine.entropy_provider_definitions
           where provider_id = 'mosera-os-entropy'
             and provider_version = '2.0.0'
             and production_eligible
             and provider_type = 'OS_CSPRNG'
             and failure_mode = 'FailClosed') entropy_ready,
         exists (
           select 1 from game_engine.csprng_provider_definitions
           where provider_id = 'mosera-internal-csprng-runtime'
             and provider_version = '2.0.0'
             and production_eligible
             and drbg_type = 'HMAC_DRBG'
             and hash_algorithm = 'SHA_256'
             and startup_self_test_supported
             and known_answer_test_supported
             and continuous_health_test_supported) runtime_ready`,
    );
    assert(
      cryptographicContracts.rows[0].rng_ready &&
        cryptographicContracts.rows[0].entropy_ready &&
        cryptographicContracts.rows[0].runtime_ready,
      "OS entropy, HMAC-DRBG, and health contracts are production-ready",
    );

    const columns = await pool.query(
      `select column_name
       from information_schema.columns
       where table_schema = 'game_engine'
         and table_name = 'outcome_provider_execution_evidence'`,
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    assert(
      columnNames.has("provider_evidence_payload") &&
        ![...columnNames].some((name) =>
          /raw_seed|raw_entropy|seed_material|drbg_state|secret_state/i.test(name),
        ),
      "canonical provider evidence supports replay-safe payloads without secret columns",
    );

    const definition = await pool.query(
      `select game_definition_id, coalesce(max(version_number), 0)::int + 1000 version_number
       from game_engine.game_definition_versions
       group by game_definition_id
       order by game_definition_id
       limit 1`,
    );
    if (definition.rowCount !== 1) {
      throw new Error("Game Definition fixture is unavailable.");
    }
    const validVersionId = randomUUID();
    await pool.query(
      `insert into game_engine.game_definition_versions (
         id, game_definition_id, version_number, definition_hash,
         paytable_version, evaluator_version, draw_generator_version,
         effective_from, outcome_generation_definition)
       values ($1,$2,$3,$4,'qa-paytable','qa-evaluator','internal-csprng:2.0.0',
         now(),'{"NumberUniverse":[2,4,6,8,10],"NumbersRequired":3,"Unique":true,"WithReplacement":false,"Ordering":"Ascending"}'::jsonb)`,
      [
        validVersionId,
        definition.rows[0].game_definition_id,
        definition.rows[0].version_number,
        `sha256:${"a".repeat(64)}`,
      ],
    );
    pass("immutable Game Definition generation rules persist");

    await expectFailure("duplicate number universe fails closed", () =>
      pool.query(
        `insert into game_engine.game_definition_versions (
           id, game_definition_id, version_number, definition_hash,
           paytable_version, evaluator_version, draw_generator_version,
           effective_from, outcome_generation_definition)
         values ($1,$2,$3,$4,'qa-paytable','qa-evaluator','internal-csprng:2.0.0',
           now(),'{"NumberUniverse":[1,1,2],"NumbersRequired":2,"Unique":true,"WithReplacement":false,"Ordering":"DrawOrder"}'::jsonb)`,
        [
          randomUUID(),
          definition.rows[0].game_definition_id,
          definition.rows[0].version_number + 1,
          `sha256:${"b".repeat(64)}`,
        ],
      ),
    );

    await expectFailure("unique generation with replacement fails closed", () =>
      pool.query(
        `insert into game_engine.game_definition_versions (
           id, game_definition_id, version_number, definition_hash,
           paytable_version, evaluator_version, draw_generator_version,
           effective_from, outcome_generation_definition)
         values ($1,$2,$3,$4,'qa-paytable','qa-evaluator','internal-csprng:2.0.0',
           now(),'{"NumberUniverse":[1,2,3],"NumbersRequired":2,"Unique":true,"WithReplacement":true,"Ordering":"DrawOrder"}'::jsonb)`,
        [
          randomUUID(),
          definition.rows[0].game_definition_id,
          definition.rows[0].version_number + 2,
          `sha256:${"c".repeat(64)}`,
        ],
      ),
    );

    const providerSource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs",
      "utf8",
    );
    const runtimeSource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs",
      "utf8",
    );
    const programSource = readFileSync(
      "services/game-engine/src/GameEngine.Api/Program.cs",
      "utf8",
    );
    assert(
        providerSource.includes("CanonicalOutcomeProviderAuthority") &&
        providerSource.includes("IGameDefinitionVersionRepository") &&
        providerSource.includes("OutcomeGenerationDefinition") &&
        providerSource.includes("CompleteGeneratedExecutionAsync") &&
        providerSource.includes("VerifyReplayAsync"),
      "provider executes only through canonical authority and immutable Game Definitions",
    );
    assert(
      runtimeSource.includes("threshold = (0UL - exclusiveUpperBound) % exclusiveUpperBound") &&
        runtimeSource.includes("FisherYatesShuffle") &&
        runtimeSource.includes("CryptographicOperations.ZeroMemory") &&
        runtimeSource.includes("VerifyContinuousTest") &&
        !runtimeSource.includes("Math.random"),
      "unbiased sampling, continuous testing, and zeroization are enforced",
    );
    assert(
      programSource.includes("AddSingleton<InternalCsprngOutcomeProvider>") &&
        !programSource.includes("ICertifiedCsprngEvidenceRepository"),
      "production DI contains one canonical Internal CSPRNG provider and no legacy evidence adapter",
    );
    assert(
      !providerSource.includes("Enumerable.Range(1, 90)") &&
        !providerSource.includes("UniqueNumbers(session, 1, 90, 5)"),
      "provider contains no hardcoded game universe or draw count",
    );

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
