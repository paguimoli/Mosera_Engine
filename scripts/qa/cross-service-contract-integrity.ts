import { access, readFile } from "node:fs/promises";

import {
  canonicalEventContracts,
  CROSS_SERVICE_CONTRACT_VERSION,
  crossServiceContracts,
  getCrossServiceContractReadiness,
} from "../../src/architecture/service-boundaries/cross-service-contracts";

type Check = {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly metadata?: Record<string, unknown>;
};

const checks: Check[] = [];

function check(
  name: string,
  passed: boolean,
  metadata: Record<string, unknown> = {}
) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

async function source(file: string) {
  return readFile(file, "utf8");
}

async function main() {
  const contractIds = crossServiceContracts.map((item) => item.contractId);
  const eventTypes = canonicalEventContracts.map((item) => item.eventType);
  const requiredOwners = [
    "AUTH_SERVICE",
    "GAME_ENGINE_SERVICE",
    "SETTLEMENT_SERVICE",
    "LEDGER_SERVICE",
    "WALLET_SERVICE",
    "TICKET_SERVICE",
    "OPERATIONAL_SERVICE",
    "WORKER_SERVICE",
  ];
  const representedServices = new Set(
    crossServiceContracts.flatMap((item) => [item.owner, item.consumer])
  );
  check(
    "cross-service contracts have one identity, owner, and version",
    new Set(contractIds).size === contractIds.length &&
      crossServiceContracts.every(
        (item) =>
          item.version === CROSS_SERVICE_CONTRACT_VERSION &&
          (item.owner !== item.consumer || item.transport === "OUTBOX_RABBITMQ") &&
          item.request.length > 0 &&
          item.response.length > 0 &&
          item.idempotency.length > 0 &&
          item.correlation.length > 0 &&
          item.causation.length > 0
      ) &&
      requiredOwners.every((owner) => representedServices.has(owner as typeof crossServiceContracts[number]["owner"])),
    { contractIds, representedServices: [...representedServices] }
  );

  const missingSources: string[] = [];
  for (const item of crossServiceContracts) {
    try {
      await access(item.source);
    } catch {
      missingSources.push(item.source);
    }
  }
  check("all contract owners resolve to existing canonical sources", missingSources.length === 0, {
    missingSources,
  });

  check(
    "published event names have one owner, publisher, and version",
    new Set(eventTypes).size === eventTypes.length &&
      canonicalEventContracts.every(
        (item) =>
          item.owner.length > 0 &&
          item.publisher.length > 0 &&
          item.version === CROSS_SERVICE_CONTRACT_VERSION
      ),
    { eventTypes }
  );

  const contractFiles = [
    "services/ledger-service/Contracts/LedgerContracts.cs",
    "services/credit-wallet-service/Contracts/CreditWalletContracts.cs",
    "services/settlement-service/Contracts/SettlementPersistenceContracts.cs",
  ];
  const dtoOwners = new Map<string, string[]>();
  for (const file of contractFiles) {
    const contents = await source(file);
    for (const match of contents.matchAll(/public sealed record ([A-Za-z0-9_]+)/g)) {
      const name = match[1];
      dtoOwners.set(name, [...(dtoOwners.get(name) ?? []), file]);
    }
  }
  const duplicateDtos = [...dtoOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => ({ name, owners }));
  check("public service wire DTO names are ownership-qualified and unique", duplicateDtos.length === 0, {
    duplicateDtos,
  });

  const queueFactory = await source("src/lib/queue/queue.publisher-factory.ts");
  const queueTypes = await source("src/lib/queue/queue.types.ts");
  const publisher = await source("src/lib/queue/rabbitmq/rabbitmq.publisher.ts");
  const consumer = await source("src/lib/queue/rabbitmq/rabbitmq.consumer.ts");
  let obsoleteNoopPublisherPresent = true;
  try {
    await access("src/lib/queue/queue.publisher.ts");
  } catch {
    obsoleteNoopPublisherPresent = false;
  }
  check(
    "RabbitMQ is the sole fail-closed production event publisher",
    !obsoleteNoopPublisherPresent &&
      !queueFactory.includes("NoopQueuePublisher") &&
      queueFactory.includes("RABBITMQ_URL is required") &&
      queueTypes.includes('CANONICAL_EVENT_CONTRACT_VERSION = "1.0.0"') &&
      publisher.includes("Canonical event envelope is incomplete or unsupported") &&
      consumer.includes("Canonical event envelope is incomplete or unsupported")
  );

  const dispatcher = await source("src/domains/workers/outbox-dispatcher.service.ts");
  const outboxService = await source("src/domains/outbox/outbox.service.ts");
  check(
    "outbox and worker execution share one versioned idempotency envelope",
    dispatcher.includes("contractVersion: CANONICAL_EVENT_CONTRACT_VERSION") &&
      dispatcher.includes("idempotencyKey: event.id") &&
      dispatcher.includes("occurredAt: event.createdAt") &&
      outboxService.includes("createPostgresOutboxEvent(input)") &&
      outboxService.includes("listRecentPostgresOutboxEvents(input)")
  );

  const settlementLedgerClient = await source(
    "services/settlement-service/Infrastructure/SettlementLedgerServiceClient.cs"
  );
  const settlementWalletClient = await source(
    "services/settlement-service/Infrastructure/SettlementCreditWalletServiceClient.cs"
  );
  check(
    "Settlement clients use canonical target contracts and identities",
    settlementLedgerClient.includes('"/v1/ledger/entries"') &&
      settlementLedgerClient.includes('"Idempotency-Key"') &&
      settlementLedgerClient.includes('"x-correlation-id"') &&
      settlementWalletClient.includes('"Idempotency-Key"') &&
      settlementWalletClient.includes('"x-correlation-id"')
  );

  const readinessFiles = [
    "services/auth-service/src/AuthService.Api/Program.cs",
    "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs",
    "services/ledger-service/Controllers/HealthEndpoints.cs",
    "services/credit-wallet-service/Controllers/HealthEndpoints.cs",
    "services/settlement-service/Controllers/HealthEndpoints.cs",
  ];
  const incompleteReadiness: string[] = [];
  for (const file of readinessFiles) {
    const contents = await source(file);
    if (!contents.includes("contractVersion") || !contents.includes("authorityOwner")) {
      incompleteReadiness.push(file);
    }
  }
  const readiness = getCrossServiceContractReadiness();
  check(
    "service readiness reports contract version and authority owner once",
    incompleteReadiness.length === 0 &&
      readiness.ready &&
      readiness.contractVersion === CROSS_SERVICE_CONTRACT_VERSION &&
      readiness.contractCount === crossServiceContracts.length &&
      readiness.eventCount === canonicalEventContracts.length,
    { incompleteReadiness, readiness }
  );

  const appReadiness = await source("app/api/health/ready/route.ts");
  check(
    "platform readiness exposes one cross-service contract source",
    appReadiness.includes("getCrossServiceContractReadiness") &&
      appReadiness.includes("crossServiceContractIntegrity") &&
      appReadiness.includes("contractIntegrity")
  );

  const failed = checks.filter((item) => item.status === "FAIL");
  console.log(JSON.stringify({
    status: failed.length === 0 ? "PASS" : "FAIL",
    checkCount: checks.length,
    failedCount: failed.length,
    checks,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
