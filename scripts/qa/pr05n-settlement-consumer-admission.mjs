import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks = [];

function check(name, passed, evidence = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", evidence });
  if (!passed) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
}

function read(path) {
  return readFileSync(path, "utf8");
}

try {
  const localCompose = read("docker-compose.yml");
  const productionCompose = read("docker-compose.production.yml");
  const consumer = read("src/lib/queue/rabbitmq/rabbitmq.consumer.ts");
  const handler = read("src/domains/workers/canonical-settlement-request-handler.ts");
  const sourcePath =
    "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs";
  const csprngHash = createHash("sha256").update(read(sourcePath)).digest("hex");

  for (const [name, compose] of [["local", localCompose], ["production", productionCompose]]) {
    const workers = compose.match(/^  worker-settlement(?:-secondary)?:$/gm) ?? [];
    check(`${name} keeps exactly two Settlement consumers`, workers.length === 2, { workers });
    const prefetch = compose.match(/WORKER_RABBITMQ_PREFETCH_SETTLEMENT:.*:-16}/g) ?? [];
    const concurrency = compose.match(/WORKER_EXECUTION_CONCURRENCY_SETTLEMENT:.*:-8}/g) ?? [];
    check(`${name} uses bounded 16-message prefetch`, prefetch.length === 2, { count: prefetch.length });
    check(`${name} aligns bounded 8-handler execution with downstream connection budgets`, concurrency.length === 2,
      { count: concurrency.length });
  }

  check("consumer records execution admission boundaries",
    consumer.includes("transportExecutionSlotRequestedAt") &&
      consumer.includes("transportExecutionSlotAcquiredAt") &&
      consumer.includes("transportActiveHandlersAtStart") &&
      consumer.includes("transportWaitingHandlersAtStart"));
  check("canonical handler persists consumer admission evidence",
    handler.includes("consumer_callback_entered_at") &&
      handler.includes("consumer_execution_concurrency") &&
      handler.includes("active_handlers_at_start"));

  const expectedColumns = [
    "consumer_callback_entered_at",
    "execution_slot_requested_at",
    "execution_slot_acquired_at",
    "handler_started_at",
    "consumer_instance_id",
    "consumer_prefetch",
    "consumer_execution_concurrency",
    "active_handlers_at_start",
    "waiting_handlers_at_start",
  ];
  const columns = (await pool.query(`
select column_name
from information_schema.columns
where table_schema='game_engine'
  and table_name='canonical_settlement_event_processing_evidence'
  and column_name=any($1::text[])
order by column_name
`, [expectedColumns])).rows.map((row) => row.column_name);
  check("migration 150 consumer evidence columns are applied",
    columns.length === expectedColumns.length, { expectedColumns, columns });

  check("qualified CSPRNG remains frozen",
    csprngHash === "2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c",
    { sourcePath, csprngHash });

  console.log(JSON.stringify({
    status: "PR_05N_CONSUMER_ADMISSION_QA_PASS",
    checks,
  }, null, 2));
} finally {
  await pool.end();
}
