export type CoreAuthorityName =
  | "FINANCIAL"
  | "DRAW"
  | "TICKET"
  | "HIERARCHY"
  | "SCOPE"
  | "OPERATIONAL";

export type CoreAuthorityOwnership = {
  authority: CoreAuthorityName;
  canonicalOwner: string;
  productionBoundary: readonly string[];
  retainedCompatibility: readonly string[];
};

export type AuthorityConsolidationCheck = {
  checkName: string;
  ready: boolean;
  issueCount: number;
  authority: CoreAuthorityName;
};

export const coreAuthorityOwnership: readonly CoreAuthorityOwnership[] = [
  {
    authority: "FINANCIAL",
    canonicalOwner: "Canonical Financial Authority",
    productionBoundary: [
      "src/domains/financial-authority/financial-authority.entrypoints.ts",
    ],
    retainedCompatibility: [
      "Guarded service promotion, shadow comparison, and rollback evidence",
    ],
  },
  {
    authority: "DRAW",
    canonicalOwner: "Game Engine canonical outcome pipeline",
    productionBoundary: [
      "services/game-engine/src/GameEngine.Application/Services/CanonicalDrawOrchestrator.cs",
      "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs",
    ],
    retainedCompatibility: [
      "GET-only legacy projections and non-authoritative local demonstration state",
    ],
  },
  {
    authority: "TICKET",
    canonicalOwner: "ticket_authority PostgreSQL schema",
    productionBoundary: [
      "src/domains/tickets/canonical-ticket.repository.ts",
      "ticket_authority.accept_ticket",
      "ticket_authority.cancel_ticket",
      "ticket_authority.request_settlement",
      "ticket_completion_authority.complete_ticket",
    ],
    retainedCompatibility: [
      "Client-only local demonstration state; never imported by API or worker code",
    ],
  },
  {
    authority: "HIERARCHY",
    canonicalOwner: "Canonical Hierarchy Authority",
    productionBoundary: [
      "src/domains/hierarchy/canonical-hierarchy-authority.ts",
    ],
    retainedCompatibility: [
      "Client-only tree presentation and deprecated Brand and Market reads",
    ],
  },
  {
    authority: "SCOPE",
    canonicalOwner: "Canonical Scope Resolver",
    productionBoundary: [
      "src/domains/scope/canonical-scope-resolver.ts",
    ],
    retainedCompatibility: [],
  },
  {
    authority: "OPERATIONAL",
    canonicalOwner: "Authenticated operational command and approval services",
    productionBoundary: [
      "src/domains/operational-access/operational-access.service.ts",
      "src/domains/authority-approval/authority-approval.service.ts",
    ],
    retainedCompatibility: [
      "Read-only authority rehearsal, shadow, and promotion evidence",
    ],
  },
] as const;

export function getAuthorityConsolidationReadiness(): AuthorityConsolidationCheck[] {
  const uniqueAuthorities = new Set(
    coreAuthorityOwnership.map((ownership) => ownership.authority)
  );
  const allHaveOneOwner = coreAuthorityOwnership.every(
    (ownership) =>
      ownership.canonicalOwner.length > 0 && ownership.productionBoundary.length > 0
  );

  return coreAuthorityOwnership.map((ownership) => {
    const ready =
      uniqueAuthorities.size === coreAuthorityOwnership.length && allHaveOneOwner;
    return {
      checkName: `authority_consolidation:${ownership.authority.toLowerCase()}`,
      ready,
      issueCount: ready ? 0 : 1,
      authority: ownership.authority,
    };
  });
}
