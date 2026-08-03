import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import {
  getCrossServiceContractReadiness,
  runtimeImplementationOwnership,
} from "../../src/architecture/service-boundaries/cross-service-contracts";

type Check = {
  name: string;
  status: "PASS" | "FAIL";
  metadata?: Record<string, unknown>;
};

const root = process.cwd();
const checks: Check[] = [];

function check(
  name: string,
  passed: boolean,
  metadata: Record<string, unknown> = {}
) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

async function source(file: string) {
  return readFile(path.join(root, file), "utf8");
}

async function exists(file: string) {
  try {
    await access(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const implementationIds = runtimeImplementationOwnership.map(
    (item) => item.implementationId
  );
  const missingSources: string[] = [];
  for (const item of runtimeImplementationOwnership) {
    if (!(await exists(item.source))) {
      missingSources.push(item.source);
    }
  }
  check(
    "runtime implementations have one identity, owner, and existing source",
    new Set(implementationIds).size === implementationIds.length &&
      missingSources.length === 0,
    { implementationCount: implementationIds.length, missingSources }
  );

  const ticketRoute = await source("app/api/tickets/route.ts");
  const workloadWorker = await source("scripts/workers/consume-workload.ts");
  check(
    "legacy ticket repository is isolated from production routes and workers",
    ticketRoute.includes("canonical-ticket.repository") &&
      !ticketRoute.includes('from "@/src/domains/tickets/ticket.repository"') &&
      !ticketRoute.includes('from "@/src/domains/tickets/ticket.service"') &&
      !workloadWorker.includes('from "@/src/domains/tickets/ticket.repository"') &&
      !workloadWorker.includes('from "@/src/domains/tickets/ticket.service"')
  );

  const manualDispatcherRoute = "app/api/workers/outbox-dispatch/route.ts";
  const localCompose = await source("docker-compose.yml");
  const productionCompose = await source("docker-compose.production.yml");
  const dispatcherSource = await source("scripts/workers/dispatch-outbox.ts");
  check(
    "Outbox has one production dispatcher execution path",
    !(await exists(manualDispatcherRoute)) &&
      (localCompose.match(/\n  outbox-dispatcher:/g) ?? []).length === 1 &&
      (productionCompose.match(/\n  outbox-dispatcher:/g) ?? []).length === 1 &&
      dispatcherSource.includes("dispatchPendingOutboxEvents"),
    { manualDispatcherRoutePresent: await exists(manualDispatcherRoute) }
  );

  const remediation = await source(
    "src/domains/ledger-reference-remediation/ledger-reference-remediation.service.ts"
  );
  const publisherFactory = await source("src/lib/queue/queue.publisher-factory.ts");
  check(
    "Outbox producers use the canonical persistence selector and publisher",
    remediation.includes('../outbox/outbox.service"') &&
      !remediation.includes('../outbox/outbox.repository"') &&
      publisherFactory.includes("RabbitMqQueuePublisher") &&
      !publisherFactory.includes("NoopQueuePublisher")
  );

  const workloadSource = await source("scripts/workers/consume-workload.ts");
  const expectedCategories = [
    "CRITICAL_FINANCIAL",
    "TICKET_LIFECYCLE",
    "SETTLEMENT",
    "ACCOUNTING",
    "COMMISSION",
    "RECONCILIATION",
    "OPERATIONAL_ACCESS",
    "REPORTING_LOW_PRIORITY",
  ];
  check(
    "workload categories share one consumer and one routing implementation",
    expectedCategories.every(
      (category) =>
        workloadSource.includes(`"${category}"`) &&
        localCompose.includes(`consume-workload.js", "${category}"`) &&
        productionCompose.includes(`consume-workload.js ${category}`)
    ),
    { expectedCategories }
  );

  const readiness = getCrossServiceContractReadiness();
  check(
    "repository, worker, and SQL ownership use one readiness source",
    readiness.ready &&
      readiness.uniqueImplementations &&
      readiness.repositoryCount > 0 &&
      readiness.workerCount > 0 &&
      readiness.sqlAuthorityCount > 0,
    { readiness }
  );

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for SQL authority validation.");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const duplicateSignatures = await pool.query<{
      schema_name: string;
      routine_name: string;
      identity_arguments: string;
      routine_count: number;
    }>(`
select
  namespace.nspname as schema_name,
  procedure.proname as routine_name,
  pg_get_function_identity_arguments(procedure.oid) as identity_arguments,
  count(*)::int as routine_count
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname in (
  'game_engine',
  'settlement_service',
  'ledger_service',
  'credit_wallet_service',
  'ticket_authority',
  'ticket_completion_authority',
  'platform',
  'compensation',
  'operational_governance',
  'operational_security',
  'operational_change'
)
group by namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid)
having count(*) > 1;
`);
    check(
      "deployed authoritative SQL has unique routine signatures",
      duplicateSignatures.rows.length === 0,
      { duplicateSignatures: duplicateSignatures.rows }
    );
  } finally {
    await pool.end();
  }

  const failed = checks.filter((item) => item.status === "FAIL");
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
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        message:
          error instanceof Error
            ? error.message
            : "Repository, worker, and SQL consolidation QA failed.",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
