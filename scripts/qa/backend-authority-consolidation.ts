import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  coreAuthorityOwnership,
  getAuthorityConsolidationReadiness,
} from "../../src/architecture/authorities/authority-consolidation";

type Check = {
  name: string;
  status: "PASS" | "FAIL";
  metadata?: Record<string, unknown>;
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

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return /\.(?:ts|tsx|mjs|cjs)$/.test(entry.name) ? [target] : [];
    })
  );
  return files.flat();
}

async function main() {
  const authorityNames = coreAuthorityOwnership.map(
    (ownership) => ownership.authority
  );
  const ownershipMap = await source(
    "src/architecture/service-boundaries/service-ownership.map.ts"
  );
  check(
    "all Backend Freeze authorities have one declared owner and execution path",
    authorityNames.length === 23 &&
      new Set(authorityNames).size === 23 &&
      coreAuthorityOwnership.every(
        (ownership) =>
          ownership.canonicalOwner.length > 0 &&
          ownership.registration.file.length > 0 &&
          ownership.execution.file.length > 0 &&
          ownership.execution.symbol.length > 0 &&
          ownership.readiness.file.length > 0
      ),
    { authorityNames }
  );
  check(
    "service ownership map matches canonical authority owners",
    ownershipMap.includes('"PLATFORM_SERVICE", name: "platform.organizations"') &&
      ownershipMap.includes(
        '"GAME_ENGINE_SERVICE", name: "game_engine.canonical_outcome_versions"'
      ) &&
      ownershipMap.includes(
        '"TICKET_SERVICE", name: "ticket_authority.accept_ticket"'
      ) &&
      ownershipMap.includes(
        '"OPERATIONAL_SERVICE", name: "authority_approval_records"'
      ) &&
      ownershipMap.includes(
        '"GAME_ENGINE_SERVICE", name: "game_engine.outcome_provider_executions"'
      ) &&
      ownershipMap.includes(
        '"TICKET_SERVICE", name: "ticket_authority.availability_decisions"'
      ) &&
      ownershipMap.includes(
        '"OPERATIONAL_SERVICE", name: "operational_governance.change_requests"'
      ) &&
      !ownershipMap.includes(
        '"SETTLEMENT_SERVICE", name: "tickets", kind: "future"'
      )
  );
  check(
    "authority consolidation readiness is fail-closed and complete",
    getAuthorityConsolidationReadiness().length === 23 &&
      getAuthorityConsolidationReadiness().every(
        (item) =>
          item.ready && item.registered && item.healthy &&
          item.productionCapable && item.governed && item.auditable
      ),
    { readiness: getAuthorityConsolidationReadiness() }
  );

  const reconciliation = await source(
    "src/domains/reconciliation/reconciliation.service.ts"
  );
  const financialEffects = await source(
    "src/domains/settlement/settlement-financial-effects.service.ts"
  );
  const settlementCredit = await source(
    "src/domains/settlement/settlement-credit.service.ts"
  );
  check(
    "financial callers use canonical entrypoints",
    reconciliation.includes(
      "../financial-authority/financial-authority-credit"
    ) &&
      financialEffects.includes(
        "../financial-authority/financial-authority-ledger"
      ) &&
      settlementCredit.includes(
        "../financial-authority/financial-authority-credit"
      )
  );

  const runtimeFiles = (
    await Promise.all(["app/api", "src/domains/workers", "scripts/workers"].map(sourceFiles))
  ).flat();
  const forbiddenFinancialImports =
    /domains\/(?:ledger\/(?:ledger\.repository|ledger\.service)|credit\/(?:credit-reservation\.repository|credit-reservation\.service)|settlement\/(?:settlement-executor\.service|settlement-engine\.service))/;
  const financialBypasses: string[] = [];
  for (const file of runtimeFiles) {
    if (forbiddenFinancialImports.test(await source(file))) {
      financialBypasses.push(path.relative(process.cwd(), file));
    }
  }
  check("runtime has no direct financial authority bypass imports", financialBypasses.length === 0, {
    financialBypasses,
  });

  const resultRoute = await source("app/api/results/route.ts");
  const gameEngineEndpoints = await source(
    "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs"
  );
  const drawWorker = await source(
    "src/domains/workers/canonical-settlement-request-handler.ts"
  );
  check(
    "Game Engine is the sole production Draw authority",
    resultRoute.includes("status: 410") &&
      !resultRoute.includes('from("drawing_results")') &&
      gameEngineEndpoints.includes('MapPost("/outcome-publications"') &&
      gameEngineEndpoints.includes('MapPost("/outcome-settlement-requests"') &&
      drawWorker.includes("game_engine.outcome_settlement_requests")
  );

  const gameEngineProgram = await source(
    "services/game-engine/src/GameEngine.Api/Program.cs"
  );
  const legacyDrawRegistry = await source(
    "services/game-engine/src/GameEngine.Application/Services/DrawAuthorityRegistry.cs"
  );
  const legacyDrawScheduler = await source(
    "services/game-engine/src/GameEngine.Application/Services/DrawSchedulerService.cs"
  );
  check(
    "legacy Draw diagnostics cannot register or write durable authority repositories",
      !gameEngineProgram.includes("IDrawAuthorityRepository") &&
      !gameEngineProgram.includes("IDrawAuthorityVersionRepository") &&
      !gameEngineProgram.includes("IDrawAuthorityAssignmentRepository") &&
      gameEngineProgram.includes("IDrawScheduleRepository") &&
      !legacyDrawRegistry.includes("PersistAuthoritySnapshot") &&
      legacyDrawScheduler.includes("PersistLifecycleSnapshot") &&
      legacyDrawScheduler.includes("PersistLifecycleRecord")
  );

  const ticketRoute = await source("app/api/tickets/route.ts");
  const ticketRuntimeImports: string[] = [];
  for (const file of runtimeFiles) {
    const contents = await source(file);
    if (
      /domains\/tickets\/(?:ticket\.repository|ticket\.service|ticket\.controller)/.test(
        contents
      )
    ) {
      ticketRuntimeImports.push(path.relative(process.cwd(), file));
    }
  }
  check(
    "Ticket authority is canonical and legacy ticket modules are runtime-isolated",
    ticketRoute.includes("canonical-ticket.repository") &&
      ticketRoute.includes("Legacy external-ID ticket intake is retired") &&
      ticketRuntimeImports.length === 0,
    { ticketRuntimeImports }
  );

  const brandRepository = await source("src/domains/brands/brand.repository.ts");
  const marketRepository = await source("src/domains/markets/market.repository.ts");
  const platformCollection = await source(
    "app/api/platform-management/[resource]/route.ts"
  );
  check(
    "Hierarchy authority has no legacy persistent Brand or Market writer",
    !/export async function (?:create|update|setDefault|disable)Brand/.test(
      brandRepository
    ) &&
      !/\.from\("markets"\)[\s\S]{0,160}\.(?:insert|update|delete)\(/.test(
        marketRepository
      ) &&
      platformCollection.includes("platform-management.repository")
  );

  const accountRoute = await source("app/api/accounts/route.ts");
  const playerRoute = await source("app/api/players/route.ts");
  check(
    "Scope authority is server-derived for governed resources",
    accountRoute.includes("account-scope-governance") &&
      playerRoute.includes("account-scope-governance") &&
      !ticketRoute.includes("body.tenantId") &&
      !ticketRoute.includes("body.brandId") &&
      !ticketRoute.includes("body.marketId")
  );

  const promotionRoute = await source(
    "app/api/authority/approvals/promotion/route.ts"
  );
  const breakGlassRoute = await source("app/api/admin/access/break-glass/route.ts");
  check(
    "Operational authority uses authenticated command and approval services",
    promotionRoute.includes('requirePermission(request, "system.admin")') &&
      promotionRoute.includes("authority-approval.service") &&
      breakGlassRoute.includes('requirePermission(request, "system.admin")') &&
      breakGlassRoute.includes("operational-access.service") &&
      authorityNames.includes("OPERATIONAL_GOVERNANCE") &&
      authorityNames.includes("OPERATIONAL_SECURITY") &&
      authorityNames.includes("OPERATIONAL_CHANGE")
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

main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
