import { access, readFile } from "node:fs/promises";

import {
  coreAuthorityOwnership,
  getAuthorityConsolidationReadiness,
  type CoreAuthorityName,
} from "../../src/architecture/authorities/authority-consolidation";
import { serviceOwnedResources } from "../../src/architecture/service-boundaries/service-ownership.map";

type Check = {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly metadata?: Record<string, unknown>;
};

const expectedAuthorities: readonly CoreAuthorityName[] = [
  "SCOPE",
  "HIERARCHY",
  "FINANCIAL",
  "FUNDING_INSTRUMENT",
  "COMPENSATION",
  "DRAW",
  "DRAW_ORCHESTRATOR",
  "OUTCOME_PROVIDER",
  "INTERNAL_CSPRNG_PROVIDER",
  "OFFICIAL_RESULTS_PROVIDER",
  "MANUAL_CERTIFIED_PROVIDER",
  "OUTCOME",
  "OUTCOME_LIFECYCLE",
  "GAME_ENGINE_PRODUCTION_ACTIVATION",
  "TICKET_ACCEPTANCE",
  "EFFECTIVE_AVAILABILITY",
  "TICKET_LIABILITY",
  "TICKET_LIFECYCLE",
  "COMPLETION",
  "TICKET_EXCEPTION",
  "OPERATIONAL_GOVERNANCE",
  "OPERATIONAL_SECURITY",
  "OPERATIONAL_CHANGE",
] as const;

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
  const actualAuthorities = coreAuthorityOwnership.map((item) => item.authority);
  check(
    "all frozen authorities have exactly one ownership record",
    expectedAuthorities.length === coreAuthorityOwnership.length &&
      expectedAuthorities.every((authority) => actualAuthorities.includes(authority)) &&
      new Set(actualAuthorities).size === actualAuthorities.length,
    { actualAuthorities }
  );

  const executionKeys = coreAuthorityOwnership.map(
    (item) => `${item.execution.file}#${item.execution.symbol}`
  );
  const registrationKeys = coreAuthorityOwnership.map(
    (item) => `${item.registration.file}#${item.registration.symbol}`
  );
  check(
    "authority execution and registration identities are unique",
    new Set(executionKeys).size === executionKeys.length &&
      new Set(registrationKeys).size === registrationKeys.length,
    { executionKeys, registrationKeys }
  );

  const missingSources: string[] = [];
  for (const ownership of coreAuthorityOwnership) {
    for (const location of [
      ownership.registration,
      ownership.execution,
      ownership.readiness,
    ]) {
      try {
        await access(location.file);
      } catch {
        missingSources.push(location.file);
      }
    }
  }
  check("all authority ownership sources exist", missingSources.length === 0, {
    missingSources: [...new Set(missingSources)],
  });

  const readiness = getAuthorityConsolidationReadiness();
  check(
    "every authority reports one complete readiness record",
    readiness.length === expectedAuthorities.length &&
      readiness.every(
        (item) =>
          item.registered &&
          item.ready &&
          item.healthy &&
          item.productionCapable &&
          item.governed &&
          item.auditable &&
          item.issueCount === 0
      ),
    { readiness }
  );

  const duplicateOwnedResources = serviceOwnedResources
    .map((resource) => resource.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  check(
    "service resource ownership has no duplicate registrations",
    duplicateOwnedResources.length === 0,
    { duplicateOwnedResources: [...new Set(duplicateOwnedResources)] }
  );

  const program = await source("services/game-engine/src/GameEngine.Api/Program.cs");
  const legacyRegistry = await source(
    "services/game-engine/src/GameEngine.Application/Services/DrawAuthorityRegistry.cs"
  );
  const legacyScheduler = await source(
    "services/game-engine/src/GameEngine.Application/Services/DrawSchedulerService.cs"
  );
  const forbiddenDrawRegistrations = [
    "IDrawAuthorityRepository",
    "IDrawAuthorityVersionRepository",
    "IDrawAuthorityAssignmentRepository",
  ].filter((registration) => program.includes(registration));
  check(
    "legacy draw diagnostics have no durable production write path",
    forbiddenDrawRegistrations.length === 0 &&
      !legacyRegistry.includes("UpsertAsync") &&
      !legacyRegistry.includes("PersistAuthoritySnapshot") &&
      legacyScheduler.includes("IDrawScheduleRepository") &&
      legacyScheduler.includes("PersistLifecycle"),
    { forbiddenDrawRegistrations }
  );

  const singletonRegistrations = [
    "CanonicalOutcomeProviderAuthority",
    "InternalCsprngOutcomeProvider",
    "OfficialResultsProvider",
    "ManualCertifiedProvider",
    "CanonicalOutcomeAuthority",
    "CanonicalOutcomeLifecycleAuthority",
    "GameEngineProductionActivationAuthority",
  ];
  const registrationCounts = Object.fromEntries(
    singletonRegistrations.map((name) => [
      name,
      (program.match(new RegExp(`AddSingleton<${name}>`, "g")) ?? []).length,
    ])
  );
  check(
    "Game Engine production authorities are each registered once",
    Object.values(registrationCounts).every((count) => count === 1),
    { registrationCounts }
  );

  const resultRoute = await source("app/api/results/route.ts");
  const ticketRoute = await source("app/api/tickets/route.ts");
  const endpoints = await source(
    "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs"
  );
  check(
    "retired public mutation paths cannot bypass canonical authorities",
    resultRoute.includes("status: 410") &&
      ticketRoute.includes("Legacy external-ID ticket intake is retired") &&
      (endpoints.match(/MapPost\("\/outcome-publications"/g) ?? []).length === 1,
    {}
  );

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
  console.error(error);
  process.exitCode = 1;
});
