import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for canonical Draw Orchestrator QA.");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks: Array<{ name: string; status: "PASS" }> = [];

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(name);
  checks.push({ name, status: "PASS" });
}

async function scalar(statement: string, values: unknown[] = []) {
  const result = await pool.query(statement, values);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

async function main() {
  try {
    const drawId = randomUUID();
    const firstLease = randomUUID();
    const secondLease = randomUUID();
    assert(await scalar(
      "select game_engine.claim_canonical_draw_execution_lease($1, $2, 'qa:first', interval '30 seconds')",
      [drawId, firstLease],
    ) === true, "first execution lease is acquired");
    assert(await scalar(
      "select game_engine.claim_canonical_draw_execution_lease($1, $2, 'qa:second', interval '30 seconds')",
      [drawId, secondLease],
    ) === false, "concurrent execution lease is rejected");
    assert(await scalar(
      "select game_engine.release_canonical_draw_execution_lease($1, $2)", [drawId, firstLease],
    ) === true, "execution lease releases deterministically");
    assert(await scalar(
      "select game_engine.claim_canonical_draw_execution_lease($1, $2, 'qa:second', interval '30 seconds')",
      [drawId, secondLease],
    ) === true, "released draw can be reclaimed");
    await scalar("select game_engine.release_canonical_draw_execution_lease($1, $2)", [drawId, secondLease]);

    const authority = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeAuthority.cs", "utf8",
    );
    const settlementHandler = readFileSync(
      "src/domains/workers/canonical-settlement-request-handler.ts", "utf8",
    );
    assert(
      authority.includes("public sealed class CanonicalOutcomeAuthority") &&
        authority.includes("CanonicalOutcomeProviderAuthority") &&
        !authority.includes("fallbackProvider"),
      "one canonical Outcome Authority owns provider-neutral publication",
    );
    assert(
      settlementHandler.includes("Authoritative Settlement acknowledgement is not available") &&
        settlementHandler.includes("canonical_draw_completion_evidence"),
      "draw completion still requires authoritative Settlement acknowledgement",
    );
    assert(Number(await scalar(`select count(*) from pg_trigger
      where tgrelid in (
        'game_engine.outcome_settlement_acknowledgements'::regclass,
        'game_engine.canonical_draw_completion_evidence'::regclass)
        and not tgisinternal and tgname like 'trg_prevent_%'`)) >= 4,
    "Settlement acknowledgement and draw completion evidence remain append-only");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: "FAIL", error: error instanceof Error ? error.message : String(error), checks,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
