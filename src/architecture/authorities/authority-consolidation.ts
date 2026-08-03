export type CoreAuthorityName =
  | "SCOPE"
  | "HIERARCHY"
  | "FINANCIAL"
  | "FUNDING_INSTRUMENT"
  | "COMPENSATION"
  | "DRAW"
  | "DRAW_ORCHESTRATOR"
  | "OUTCOME_PROVIDER"
  | "INTERNAL_CSPRNG_PROVIDER"
  | "OFFICIAL_RESULTS_PROVIDER"
  | "MANUAL_CERTIFIED_PROVIDER"
  | "OUTCOME"
  | "OUTCOME_LIFECYCLE"
  | "GAME_ENGINE_PRODUCTION_ACTIVATION"
  | "TICKET_ACCEPTANCE"
  | "EFFECTIVE_AVAILABILITY"
  | "TICKET_LIABILITY"
  | "TICKET_LIFECYCLE"
  | "COMPLETION"
  | "TICKET_EXCEPTION"
  | "OPERATIONAL_GOVERNANCE"
  | "OPERATIONAL_SECURITY"
  | "OPERATIONAL_CHANGE";

export type AuthoritySource = {
  readonly file: string;
  readonly symbol: string;
};

export type CoreAuthorityOwnership = {
  readonly authority: CoreAuthorityName;
  readonly serviceOwner: string;
  readonly canonicalOwner: string;
  readonly registration: AuthoritySource;
  readonly execution: AuthoritySource;
  readonly readiness: AuthoritySource;
  readonly productionCapable: boolean;
  readonly governed: boolean;
  readonly auditable: boolean;
  readonly retainedCompatibility: readonly string[];
};

export type AuthorityConsolidationCheck = {
  readonly checkName: string;
  readonly ready: boolean;
  readonly issueCount: number;
  readonly authority: CoreAuthorityName;
  readonly registered: boolean;
  readonly healthy: boolean;
  readonly productionCapable: boolean;
  readonly governed: boolean;
  readonly auditable: boolean;
};

const source = (file: string, symbol: string): AuthoritySource => ({ file, symbol });

export const coreAuthorityOwnership: readonly CoreAuthorityOwnership[] = [
  {
    authority: "SCOPE",
    serviceOwner: "PLATFORM_SERVICE",
    canonicalOwner: "Canonical Scope Resolver",
    registration: source("src/domains/auth/auth-middleware.ts", "resolveCanonicalScope"),
    execution: source("src/domains/scope/canonical-scope-resolver.ts", "resolveCanonicalScope"),
    readiness: source("src/domains/accounts/account.repository.ts", "getAccountScopeReadiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "HIERARCHY",
    serviceOwner: "PLATFORM_SERVICE",
    canonicalOwner: "Canonical Hierarchy Authority",
    registration: source("src/domains/platform-management/platform-management.repository.ts", "canonical-hierarchy-authority"),
    execution: source("src/domains/hierarchy/canonical-hierarchy-authority.ts", "resolveAccountAncestors"),
    readiness: source("src/domains/hierarchy/canonical-hierarchy-authority.ts", "hierarchyAuthorityReadiness"),
    productionCapable: true, governed: true, auditable: true,
    retainedCompatibility: ["Client-only hierarchy presentation helpers"],
  },
  {
    authority: "FINANCIAL",
    serviceOwner: "LEDGER_SERVICE",
    canonicalOwner: "Canonical Financial Authority",
    registration: source("src/domains/financial-authority/financial-authority.entrypoints.ts", "financial authority facade"),
    execution: source("src/domains/financial-authority/financial-authority.entrypoints.ts", "Sole production boundary"),
    readiness: source("src/domains/financial-authority/financial-authority.service.ts", "getFinancialAuthorityReadiness"),
    productionCapable: true, governed: true, auditable: true,
    retainedCompatibility: ["Guarded service promotion and comparison evidence"],
  },
  {
    authority: "FUNDING_INSTRUMENT",
    serviceOwner: "WALLET_SERVICE",
    canonicalOwner: "Funding Instrument Authority",
    registration: source("src/domains/financial-authority/financial-authority.entrypoints.ts", "funding-instrument-authority export"),
    execution: source("src/domains/financial-authority/funding-instrument-authority.ts", "resolveFundingInstrument"),
    readiness: source("src/domains/financial-authority/funding-instrument-authority.ts", "fundingInstrumentReadiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "COMPENSATION",
    serviceOwner: "COMMISSION_SERVICE",
    canonicalOwner: "Compensation Authority",
    registration: source("src/domains/financial-authority/financial-authority.entrypoints.ts", "compensation service exports"),
    execution: source("src/domains/compensation/compensation.service.ts", "executeWeeklyCompensation"),
    readiness: source("src/domains/compensation/compensation.repository.ts", "compensationPersistenceReadiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "DRAW",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Immutable Draw Authority",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "Postgres canonical draw repositories"),
    execution: source("scripts/migrations/local/093_add_immutable_draw_authority.sql", "published draw schedule and execution manifest"),
    readiness: source("services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs", "ReadinessResponse.draw persistence"),
    productionCapable: true, governed: true, auditable: true,
    retainedCompatibility: ["Read-only Phase 22.6 registry and scheduler diagnostics"],
  },
  {
    authority: "DRAW_ORCHESTRATOR",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Canonical Draw Orchestrator",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "ICanonicalOutcomePipelineRepository"),
    execution: source("services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs", "claim_canonical_draw_execution_lease"),
    readiness: source("services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OUTCOME_PROVIDER",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Canonical Outcome Provider Authority",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "CanonicalOutcomeProviderAuthority"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeProviderAuthority.cs", "ClaimExecutionAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeProviderAuthority.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "INTERNAL_CSPRNG_PROVIDER",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Internal CSPRNG Provider",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "InternalCsprngOutcomeProvider"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs", "GenerateAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OFFICIAL_RESULTS_PROVIDER",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Official Results Provider",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "OfficialResultsProvider"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/OfficialResultsProvider.cs", "IngestAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/OfficialResultsProvider.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "MANUAL_CERTIFIED_PROVIDER",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Manual Certified Provider",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "ManualCertifiedProvider"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/ManualCertifiedProvider.cs", "SubmitAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/ManualCertifiedProvider.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OUTCOME",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Canonical Outcome Authority",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "CanonicalOutcomeAuthority"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeAuthority.cs", "PublishAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeAuthority.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OUTCOME_LIFECYCLE",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Canonical Outcome Lifecycle Authority",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "CanonicalOutcomeLifecycleAuthority"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeLifecycleAuthority.cs", "CorrectAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeAuthority.cs", "CheckReadinessAsync.lifecycle"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "GAME_ENGINE_PRODUCTION_ACTIVATION",
    serviceOwner: "GAME_ENGINE_SERVICE",
    canonicalOwner: "Game Engine Production Activation Authority",
    registration: source("services/game-engine/src/GameEngine.Api/Program.cs", "GameEngineProductionActivationAuthority"),
    execution: source("services/game-engine/src/GameEngine.Application/Services/GameEngineProductionActivationAuthority.cs", "AdvanceAsync"),
    readiness: source("services/game-engine/src/GameEngine.Application/Services/GameEngineProductionActivationAuthority.cs", "CheckReadinessAsync"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "TICKET_ACCEPTANCE",
    serviceOwner: "TICKET_SERVICE",
    canonicalOwner: "Ticket Acceptance Authority",
    registration: source("src/domains/tickets/canonical-ticket.repository.ts", "acceptCanonicalTicket"),
    execution: source("scripts/migrations/local/083_add_canonical_ticket_lifecycle.sql", "ticket_authority.accept_ticket"),
    readiness: source("scripts/migrations/local/107_add_ticket_platform_final_readiness.sql", "acceptance_authority"),
    productionCapable: true, governed: true, auditable: true,
    retainedCompatibility: ["Client-only ticket demonstration state"],
  },
  {
    authority: "EFFECTIVE_AVAILABILITY",
    serviceOwner: "TICKET_SERVICE",
    canonicalOwner: "Effective Availability Authority",
    registration: source("scripts/migrations/local/101_add_draw_close_fence_effective_availability.sql", "availability_decisions"),
    execution: source("scripts/migrations/local/101_add_draw_close_fence_effective_availability.sql", "ticket_authority.resolve_effective_availability"),
    readiness: source("scripts/migrations/local/107_add_ticket_platform_final_readiness.sql", "effective_availability_authority"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "TICKET_LIABILITY",
    serviceOwner: "TICKET_SERVICE",
    canonicalOwner: "Ticket Liability Authority",
    registration: source("scripts/migrations/local/102_add_ticket_liability_authority.sql", "liability_decisions"),
    execution: source("scripts/migrations/local/102_add_ticket_liability_authority.sql", "ticket_authority.evaluate_liability"),
    readiness: source("scripts/migrations/local/107_add_ticket_platform_final_readiness.sql", "liability_authority"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "TICKET_LIFECYCLE",
    serviceOwner: "TICKET_SERVICE",
    canonicalOwner: "Typed Ticket Lifecycle Authority",
    registration: source("src/domains/tickets/canonical-ticket.repository.ts", "canonical ticket lifecycle functions"),
    execution: source("scripts/migrations/local/103_add_typed_ticket_lifecycle_authority.sql", "ticket_authority.append_lifecycle_transition"),
    readiness: source("scripts/migrations/local/107_add_ticket_platform_final_readiness.sql", "typed_lifecycle_authority"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "COMPLETION",
    serviceOwner: "TICKET_SERVICE",
    canonicalOwner: "Financial Completion Authority",
    registration: source("src/domains/workers/financial-worker-handlers.ts", "ticket completion handler"),
    execution: source("scripts/migrations/local/104_add_financial_completion_authority.sql", "ticket_completion_authority.complete_ticket"),
    readiness: source("scripts/migrations/local/107_add_ticket_platform_final_readiness.sql", "financial_completion_authority"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "TICKET_EXCEPTION",
    serviceOwner: "TICKET_SERVICE",
    canonicalOwner: "Ticket Exception Authority",
    registration: source("scripts/migrations/local/106_add_ticket_exception_authority.sql", "ticket_exception_authority.operations"),
    execution: source("scripts/migrations/local/106_add_ticket_exception_authority.sql", "ticket_exception_authority.request_operation"),
    readiness: source("scripts/migrations/local/106_add_ticket_exception_authority.sql", "ticket_exception_authority.readiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OPERATIONAL_GOVERNANCE",
    serviceOwner: "OPERATIONAL_SERVICE",
    canonicalOwner: "Operational Governance Authority",
    registration: source("src/domains/operational-governance/operational-governance.service.ts", "executeGovernedOperation"),
    execution: source("scripts/migrations/local/108_add_operational_governance_authority.sql", "operational_governance.authorize_command"),
    readiness: source("scripts/migrations/local/108_add_operational_governance_authority.sql", "operational_governance.readiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OPERATIONAL_SECURITY",
    serviceOwner: "OPERATIONAL_SERVICE",
    canonicalOwner: "Operational Security Authority",
    registration: source("src/domains/operational-security/operational-security.service.ts", "authorizeOperationalExecution"),
    execution: source("scripts/migrations/local/109_add_operational_security_authority.sql", "operational_governance.validate_command_security"),
    readiness: source("src/domains/operational-security/operational-security.repository.ts", "checkOperationalSecurityReadiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
  {
    authority: "OPERATIONAL_CHANGE",
    serviceOwner: "OPERATIONAL_SERVICE",
    canonicalOwner: "Operational Change Authority",
    registration: source("src/domains/operational-change/operational-change.service.ts", "executeOperationalChange"),
    execution: source("scripts/migrations/local/112_add_operational_change_authority.sql", "operational_governance.begin_change_execution"),
    readiness: source("scripts/migrations/local/112_add_operational_change_authority.sql", "operational_governance.operational_change_readiness"),
    productionCapable: true, governed: true, auditable: true, retainedCompatibility: [],
  },
] as const;

export function getAuthorityConsolidationReadiness(): AuthorityConsolidationCheck[] {
  const authorityNames = new Set(coreAuthorityOwnership.map((item) => item.authority));
  const executionPaths = new Set(
    coreAuthorityOwnership.map((item) => `${item.execution.file}#${item.execution.symbol}`)
  );
  const oneOwnerPerAuthority = authorityNames.size === coreAuthorityOwnership.length;
  const oneExecutionPathPerAuthority = executionPaths.size === coreAuthorityOwnership.length;

  return coreAuthorityOwnership.map((ownership) => {
    const registered = Boolean(ownership.registration.file && ownership.registration.symbol);
    const healthy = Boolean(ownership.readiness.file && ownership.readiness.symbol);
    const ready =
      oneOwnerPerAuthority &&
      oneExecutionPathPerAuthority &&
      registered &&
      healthy &&
      ownership.productionCapable &&
      ownership.governed &&
      ownership.auditable;
    return {
      checkName: `authority_integrity:${ownership.authority.toLowerCase()}`,
      ready,
      issueCount: ready ? 0 : 1,
      authority: ownership.authority,
      registered,
      healthy,
      productionCapable: ownership.productionCapable,
      governed: ownership.governed,
      auditable: ownership.auditable,
    };
  });
}
