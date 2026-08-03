import type { ServiceName } from "./service-boundary.types";

export const CROSS_SERVICE_CONTRACT_VERSION = "1.0.0";

export type CrossServiceTransport = "HTTP" | "POSTGRES" | "OUTBOX_RABBITMQ";

export type CrossServiceContract = {
  readonly contractId: string;
  readonly version: typeof CROSS_SERVICE_CONTRACT_VERSION;
  readonly owner: ServiceName;
  readonly consumer: ServiceName;
  readonly transport: CrossServiceTransport;
  readonly request: string;
  readonly response: string;
  readonly event: string | null;
  readonly idempotency: string;
  readonly correlation: string;
  readonly causation: string;
  readonly source: string;
  readonly readiness: string;
};

const contract = (
  value: Omit<CrossServiceContract, "version">
): CrossServiceContract => ({ ...value, version: CROSS_SERVICE_CONTRACT_VERSION });

export const crossServiceContracts: readonly CrossServiceContract[] = [
  contract({ contractId: "auth.session.v1", owner: "AUTH_SERVICE", consumer: "PLATFORM_SERVICE", transport: "HTTP", request: "Auth session/token command", response: "Authenticated identity/session evidence", event: null, idempotency: "session or refresh-token identity", correlation: "x-correlation-id", causation: "originating request correlation", source: "services/auth-service/src/AuthService.Api/Program.cs", readiness: "/health/ready" }),
  contract({ contractId: "game-engine.settlement-input.v1", owner: "GAME_ENGINE_SERVICE", consumer: "SETTLEMENT_SERVICE", transport: "POSTGRES", request: "Immutable SettlementInput reference/hash", response: "SettlementInput ingestion record", event: "settlement.requested", idempotency: "settlement request id", correlation: "canonical draw correlation id", causation: "outcome version id", source: "services/game-engine/src/GameEngine.Domain/Model/SettlementInputModels.cs", readiness: "/health/ready" }),
  contract({ contractId: "settlement.ledger-posting.v1", owner: "LEDGER_SERVICE", consumer: "SETTLEMENT_SERVICE", transport: "HTTP", request: "CreateLedgerEntryRequest", response: "LedgerEntryResponse", event: "ledger.entry.posted", idempotency: "Idempotency-Key", correlation: "x-correlation-id", causation: "settlement financial instruction id", source: "services/ledger-service/Contracts/LedgerContracts.cs", readiness: "/v1/ledger/health" }),
  contract({ contractId: "settlement.wallet-operation.v1", owner: "WALLET_SERVICE", consumer: "SETTLEMENT_SERVICE", transport: "HTTP", request: "CanonicalWalletOperationRequest", response: "CanonicalWalletOperationResponse", event: "wallet.settlement.applied", idempotency: "Idempotency-Key", correlation: "x-correlation-id", causation: "settlement financial instruction id", source: "services/credit-wallet-service/Contracts/CanonicalWalletOperationContracts.cs", readiness: "/v1/credit-wallets/health" }),
  contract({ contractId: "ticket.financial-authority.v1", owner: "TICKET_SERVICE", consumer: "WALLET_SERVICE", transport: "POSTGRES", request: "Canonical ticket reservation/funding evidence", response: "Canonical wallet operation evidence", event: "ticket.accepted", idempotency: "ticket acceptance idempotency key", correlation: "ticket correlation id", causation: "ticket command id", source: "scripts/migrations/local/083_add_canonical_ticket_lifecycle.sql", readiness: "ticket_authority.ticket_platform_readiness" }),
  contract({ contractId: "financial.ledger-authority.v1", owner: "LEDGER_SERVICE", consumer: "PLATFORM_SERVICE", transport: "HTTP", request: "CreateLedgerEntryRequest or ReverseLedgerEntryRequest", response: "LedgerEntryResponse", event: "ledger.entry.posted", idempotency: "Idempotency-Key", correlation: "x-correlation-id", causation: "financial instruction id", source: "src/domains/financial-authority/financial-authority-ledger.ts", readiness: "/v1/ledger/health" }),
  contract({ contractId: "financial.wallet-authority.v1", owner: "WALLET_SERVICE", consumer: "PLATFORM_SERVICE", transport: "HTTP", request: "CanonicalWalletOperationRequest", response: "CanonicalWalletOperationResponse", event: "wallet.balance.changed", idempotency: "Idempotency-Key", correlation: "x-correlation-id", causation: "financial instruction id", source: "src/domains/credit/credit-wallet-service-client.ts", readiness: "/v1/credit-wallets/health" }),
  contract({ contractId: "operational.governance-command.v1", owner: "OPERATIONAL_SERVICE", consumer: "GAME_ENGINE_SERVICE", transport: "POSTGRES", request: "Governed command and approval evidence", response: "Execution authorization evidence", event: null, idempotency: "operational command id", correlation: "command correlation id", causation: "change request or initiating command id", source: "scripts/migrations/local/108_add_operational_governance_authority.sql", readiness: "operational_governance.readiness" }),
  contract({ contractId: "outbox.rabbitmq-event.v1", owner: "WORKER_SERVICE", consumer: "WORKER_SERVICE", transport: "OUTBOX_RABBITMQ", request: "Canonical QueueMessage envelope", response: "Broker acknowledgement", event: "*", idempotency: "outbox event id", correlation: "outbox correlation id", causation: "payload causationId or null", source: "src/lib/queue/queue.types.ts", readiness: "compiled worker runtime readiness" }),
] as const;

export type CanonicalEventContract = {
  readonly eventType: string;
  readonly owner: ServiceName;
  readonly publisher: string;
  readonly version: typeof CROSS_SERVICE_CONTRACT_VERSION;
};

const event = (
  eventType: string,
  owner: ServiceName,
  publisher: string
): CanonicalEventContract => ({
  eventType,
  owner,
  publisher,
  version: CROSS_SERVICE_CONTRACT_VERSION,
});

export const canonicalEventContracts: readonly CanonicalEventContract[] = [
  event("cashier.transaction.completed", "CASHIER_SERVICE", "cashier transaction authority"),
  event("credit.exposure.released", "WALLET_SERVICE", "Credit Wallet Authority"),
  event("credit.exposure.reserved", "WALLET_SERVICE", "Credit Wallet Authority"),
  event("credit.settlement.applied", "WALLET_SERVICE", "Credit Wallet Authority"),
  event("ledger.entry.posted", "LEDGER_SERVICE", "Ledger Authority"),
  event("settlement.requested", "GAME_ENGINE_SERVICE", "Canonical Outcome Authority"),
  event("ticket.accepted", "TICKET_SERVICE", "Ticket Acceptance Authority"),
  event("ticket.cancelled", "TICKET_SERVICE", "Ticket Lifecycle Authority"),
  event("wallet.reservation.cancelled", "WALLET_SERVICE", "Funding Instrument Authority"),
  event("wallet.reservation.captured", "WALLET_SERVICE", "Funding Instrument Authority"),
  event("wallet.reservation.created", "WALLET_SERVICE", "Funding Instrument Authority"),
  event("wallet.reservation.released", "WALLET_SERVICE", "Funding Instrument Authority"),
  event("wallet.settlement.applied", "WALLET_SERVICE", "Funding Instrument Authority"),
  event("wallet.settlement.reversed", "WALLET_SERVICE", "Funding Instrument Authority"),
] as const;

export type RuntimeImplementationKind = "REPOSITORY" | "WORKER" | "SQL_AUTHORITY";

export type RuntimeImplementationOwnership = {
  readonly implementationId: string;
  readonly kind: RuntimeImplementationKind;
  readonly owner: ServiceName;
  readonly source: string;
};

const implementation = (
  implementationId: string,
  kind: RuntimeImplementationKind,
  owner: ServiceName,
  source: string
): RuntimeImplementationOwnership => ({ implementationId, kind, owner, source });

export const runtimeImplementationOwnership: readonly RuntimeImplementationOwnership[] = [
  implementation("auth.identity.repository", "REPOSITORY", "AUTH_SERVICE", "services/auth-service/src/AuthService.Infrastructure/PostgresAuthenticationAuthorityRepository.cs"),
  implementation("game-engine.catalog.repository", "REPOSITORY", "GAME_ENGINE_SERVICE", "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCatalogPersistence.cs"),
  implementation("game-engine.outcome.repository", "REPOSITORY", "GAME_ENGINE_SERVICE", "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs"),
  implementation("settlement.execution.repository", "REPOSITORY", "SETTLEMENT_SERVICE", "services/settlement-service/Infrastructure/SettlementExecutionRepository.cs"),
  implementation("settlement.instruction.repository", "REPOSITORY", "SETTLEMENT_SERVICE", "services/settlement-service/Infrastructure/FinancialInstructionRepository.cs"),
  implementation("ledger.posting.repository", "REPOSITORY", "LEDGER_SERVICE", "services/ledger-service/Infrastructure/DurableLedgerRepository.cs"),
  implementation("ledger.journal.repository", "REPOSITORY", "LEDGER_SERVICE", "services/ledger-service/Infrastructure/LedgerJournalRepository.cs"),
  implementation("wallet.operation.repository", "REPOSITORY", "WALLET_SERVICE", "services/credit-wallet-service/Infrastructure/CanonicalWalletOperationRepository.cs"),
  implementation("ticket.lifecycle.repository", "REPOSITORY", "TICKET_SERVICE", "src/domains/tickets/canonical-ticket.repository.ts"),
  implementation("platform.management.repository", "REPOSITORY", "PLATFORM_SERVICE", "src/domains/platform-management/platform-management.repository.ts"),
  implementation("operational.governance.repository", "REPOSITORY", "OPERATIONAL_SERVICE", "src/domains/operational-governance/operational-governance.repository.ts"),
  implementation("outbox.event.repository", "REPOSITORY", "WORKER_SERVICE", "src/domains/outbox/outbox.postgres.repository.ts"),
  implementation("worker.observability.repository", "REPOSITORY", "WORKER_SERVICE", "src/domains/operations/worker-observability.repository.ts"),
  implementation("compensation.repository", "REPOSITORY", "COMMISSION_SERVICE", "src/domains/compensation/compensation.repository.ts"),
  implementation("outbox.dispatcher", "WORKER", "WORKER_SERVICE", "scripts/workers/dispatch-outbox.ts"),
  ...[
    "critical-financial",
    "ticket-lifecycle",
    "settlement",
    "accounting",
    "commission",
    "reconciliation",
    "operational-access",
    "reporting",
  ].map((name) => implementation(`queue.${name}.worker`, "WORKER", "WORKER_SERVICE", "scripts/workers/consume-workload.ts")),
  implementation("game-engine.outcome-recovery.worker", "WORKER", "GAME_ENGINE_SERVICE", "services/game-engine/src/GameEngine.Api/Infrastructure/CanonicalOutcomeRecoveryHostedService.cs"),
  implementation("wallet.startup-recovery.worker", "WORKER", "WALLET_SERVICE", "services/credit-wallet-service/Application/CreditWalletStartupRecoveryHostedService.cs"),
  implementation("platform.hierarchy.sql", "SQL_AUTHORITY", "PLATFORM_SERVICE", "scripts/migrations/local/081_add_canonical_platform_hierarchy.sql"),
  implementation("ticket.lifecycle.sql", "SQL_AUTHORITY", "TICKET_SERVICE", "scripts/migrations/local/107_add_ticket_platform_final_readiness.sql"),
  implementation("game-engine.outcome.sql", "SQL_AUTHORITY", "GAME_ENGINE_SERVICE", "scripts/migrations/local/098_add_canonical_outcome_authority.sql"),
  implementation("game-engine.activation.sql", "SQL_AUTHORITY", "GAME_ENGINE_SERVICE", "scripts/migrations/local/100_add_game_engine_production_activation.sql"),
  implementation("settlement.execution.sql", "SQL_AUTHORITY", "SETTLEMENT_SERVICE", "scripts/migrations/local/078_add_settlement_scope_and_evidence_governance.sql"),
  implementation("ledger.posting.sql", "SQL_AUTHORITY", "LEDGER_SERVICE", "scripts/migrations/local/066_add_ledger_authority_verifications.sql"),
  implementation("wallet.operation.sql", "SQL_AUTHORITY", "WALLET_SERVICE", "scripts/migrations/local/075_add_credit_wallet_verification_remediation.sql"),
  implementation("compensation.sql", "SQL_AUTHORITY", "COMMISSION_SERVICE", "scripts/migrations/local/090_bind_compensation_scope_metadata.sql"),
  implementation("operational.governance.sql", "SQL_AUTHORITY", "OPERATIONAL_SERVICE", "scripts/migrations/local/112_add_operational_change_authority.sql"),
] as const;

export function getCrossServiceContractReadiness() {
  const contractIds = crossServiceContracts.map((item) => item.contractId);
  const eventTypes = canonicalEventContracts.map((item) => item.eventType);
  const uniqueContracts = new Set(contractIds).size === contractIds.length;
  const uniqueEvents = new Set(eventTypes).size === eventTypes.length;
  const singleVersion = crossServiceContracts.every(
    (item) => item.version === CROSS_SERVICE_CONTRACT_VERSION
  ) && canonicalEventContracts.every(
    (item) => item.version === CROSS_SERVICE_CONTRACT_VERSION
  );
  const implementationIds = runtimeImplementationOwnership.map(
    (item) => item.implementationId
  );
  const uniqueImplementations =
    new Set(implementationIds).size === implementationIds.length;
  const repositoryCount = runtimeImplementationOwnership.filter(
    (item) => item.kind === "REPOSITORY"
  ).length;
  const workerCount = runtimeImplementationOwnership.filter(
    (item) => item.kind === "WORKER"
  ).length;
  const sqlAuthorityCount = runtimeImplementationOwnership.filter(
    (item) => item.kind === "SQL_AUTHORITY"
  ).length;
  return {
    ready: uniqueContracts && uniqueEvents && singleVersion && uniqueImplementations,
    healthy: uniqueContracts && uniqueEvents && uniqueImplementations,
    contractVersion: CROSS_SERVICE_CONTRACT_VERSION,
    authorityOwner: "SERVICE_BOUNDARY_REGISTRY",
    contractCount: crossServiceContracts.length,
    eventCount: canonicalEventContracts.length,
    repositoryCount,
    workerCount,
    sqlAuthorityCount,
    uniqueContracts,
    uniqueEvents,
    uniqueImplementations,
    singleVersion,
  };
}
