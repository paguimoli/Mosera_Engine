import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
    })
  );
  return nested.flat();
}

async function main() {
  const authorityService = await source(
    "src/domains/financial-authority/financial-authority.service.ts"
  );
  const authorityPolicy = await source(
    "src/domains/financial-authority/financial-authority.policy.ts"
  );
  const readiness = {
    authority: authorityService.includes('authority: "FinancialAuthority"'),
    ledger: authorityService.includes('ledgerAuthority: "CANONICAL"'),
    wallet: authorityService.includes('walletAuthority: "CANONICAL"'),
    reservation: authorityService.includes('reservationAuthority: "CANONICAL"'),
    settlement: authorityService.includes('settlementAuthority: "CANONICAL"'),
    operatingMode: authorityService.includes(
      'operatingModeAuthority: "CANONICAL"'
    ),
    funding: authorityService.includes(
      'fundingInstrumentAuthority: "CANONICAL"'
    ),
  };
  check(
    "one canonical Financial Authority owns all launch financial authorities",
    Object.values(readiness).every(Boolean)
  );

  check(
    "CREDIT and COMMISSION operating modes resolve centrally",
    authorityPolicy.includes(
      'policy.operatingMode === "COMMISSION"'
    ) &&
      authorityPolicy.includes(
        'policy.operatingMode === "CREDIT_EXPOSURE"'
      ) &&
      authorityPolicy.includes('policy.fundingModel === "CREDIT"')
  );

  check(
    "CREDIT and FREE_PLAY are the exact launch funding instruments",
    authorityPolicy.includes('instrument !== "CREDIT"') &&
      authorityPolicy.includes('instrument !== "FREE_PLAY"') &&
      authorityService.includes(
        'launchFundingInstruments: ["CREDIT", "FREE_PLAY"]'
      ) &&
      authorityService.includes("futureFundingInstruments: []")
  );
  const fundingAuthority = await source(
    "src/domains/financial-authority/funding-instrument-authority.ts"
  );
  const canonicalTicket = await source(
    "src/domains/tickets/canonical-ticket.repository.ts"
  );
  const compensationService = await source(
    "src/domains/compensation/compensation.service.ts"
  );
  check(
    "Ticket and Compensation wallet routing use one Funding Instrument Authority",
    fundingAuthority.includes(
      "funding_authority.resolve_funding_instrument"
    ) &&
      canonicalTicket.includes("resolveFundingInstrument") &&
      compensationService.includes("resolveFundingInstrument") &&
      !compensationService.includes("findActiveCreditWallet")
  );

  const runtimeFiles = (
    await Promise.all(
      ["app/api", "src/domains/workers", "scripts/workers"].map(sourceFiles)
    )
  ).flat();
  const bypassPattern =
    /domains\/(?:ledger\/ledger\.entrypoints|credit\/credit\.entrypoints|wallets\/wallet\.service|cashier\/cashier\.service|compensation\/compensation\.service)/;
  const bypasses: string[] = [];
  for (const file of runtimeFiles) {
    if (bypassPattern.test(await source(file))) {
      bypasses.push(path.relative(process.cwd(), file));
    }
  }
  check("production API and worker callers use one financial boundary", bypasses.length === 0, {
    bypasses,
  });

  const settlementCredit = await source(
    "src/domains/settlement/settlement-credit.service.ts"
  );
  const settlementLedger = await source(
    "src/domains/settlement/settlement-financial-effects.service.ts"
  );
  const reconciliation = await source(
    "src/domains/reconciliation/reconciliation.service.ts"
  );
  check(
    "cross-domain financial callers delegate to Financial Authority",
    settlementCredit.includes(
      "../financial-authority/financial-authority-credit"
    ) &&
      settlementLedger.includes(
        "../financial-authority/financial-authority-ledger"
      ) &&
      reconciliation.includes(
        "../financial-authority/financial-authority-credit"
      )
  );

  const compatibilityGateway = await source(
    "src/domains/compensation/compensation-ledger.gateway.ts"
  );
  const authorityGateway = await source(
    "src/domains/financial-authority/compensation-ledger.gateway.ts"
  );
  check(
    "Compensation consumes Financial Authority posting orchestration",
    compensationService.includes(
      "../financial-authority/compensation-ledger.gateway"
    ) &&
      compatibilityGateway.includes(
        "../financial-authority/compensation-ledger.gateway"
      ) &&
      !compatibilityGateway.includes(
        "class LedgerServiceCompensationGateway"
      ) &&
      authorityGateway.includes("class LedgerServiceCompensationGateway")
  );

  const ownership = await source(
    "src/architecture/authorities/authority-consolidation.ts"
  );
  check(
    "architecture ownership declares one Financial Authority boundary",
    ownership.includes('canonicalOwner: "Canonical Financial Authority"') &&
      ownership.includes(
        "src/domains/financial-authority/financial-authority.entrypoints.ts"
      ) &&
      !ownership.includes("src/domains/ledger/ledger.entrypoints.ts")
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
