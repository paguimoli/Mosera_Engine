import { spawnSync } from "node:child_process";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

const result = spawnSync("node", ["scripts/operations/local-runtime-inventory.mjs"], {
  encoding: "utf8",
  env: process.env,
});

assert(result.status === 0, "Local runtime inventory script failed.", {
  stdout: result.stdout,
  stderr: result.stderr,
});

let inventory;
try {
  inventory = JSON.parse(result.stdout);
} catch (error) {
  fail("Local runtime inventory did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: result.stdout,
  });
}

function health(name) {
  return inventory.serviceHealth.find((item) => item.name === name);
}

function readiness(name) {
  return inventory.serviceReadiness?.find((item) => item.name === name);
}

for (const name of [
  "app",
  "auth-service",
  "game-engine",
  "settlement-service",
  "ledger-service",
  "credit-wallet-service",
]) {
  assert(health(name)?.status === "UP", `${name} must be reachable.`, { service: health(name) });
}

for (const name of [
  "auth-service",
  "game-engine",
  "settlement-service",
  "ledger-service",
  "credit-wallet-service",
]) {
  assert(readiness(name)?.status === "READY", `${name} readiness endpoint must pass.`, {
    readiness: readiness(name),
  });
}

const notReadyDependencies = (inventory.dependencyReadiness ?? []).filter((item) => item.status === "NOT_READY");
assert(notReadyDependencies.length === 0, "All reported service dependencies must be ready.", {
  notReadyDependencies,
});

const auth = health("auth-service");

const rabbitmqManagement = health("rabbitmq-management");
const rabbitmqBroker = health("rabbitmq-broker");
assert(
  rabbitmqManagement?.status === "UP" || rabbitmqBroker?.status === "UP",
  "RabbitMQ management or broker must be reachable.",
  { rabbitmqManagement, rabbitmqBroker }
);

const redis = health("redis");
assert(redis?.status === "UP", "Redis must be reachable.", { redis });

assert(
  inventory.durablePersistence?.gameEngineDatabaseUrlConfigured,
  "Game Engine must have DATABASE_URL configured in local runtime.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.gameEngineDurablePersistenceModeActive,
  "Game Engine durable persistence mode must be active.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.migrationsCurrent,
  "Local migrations must validate before runtime QA passes.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.settlementDatabaseUrlConfigured,
  "Settlement persistence must have DATABASE_URL configured in local runtime.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.settlementPersistenceSchemaCurrent,
  "Settlement persistence schema must be current before runtime QA passes.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.creditWalletDatabaseUrlConfigured,
  "Credit Wallet Service must have DATABASE_URL configured in local runtime.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.authProvider?.configuredProvider === "auth-service",
  "Local runtime app must be configured for Auth Service provider mode.",
  { authProvider: inventory.authProvider }
);
assert(
  inventory.authProvider?.authServiceUrlConfigured,
  "Local runtime app must have AUTH_SERVICE_URL configured.",
  { authProvider: inventory.authProvider }
);
assert(
  inventory.financialAuthorityGuardrails?.status === "PASS",
  "Financial authority guardrails must pass for local runtime.",
  { financialAuthorityGuardrails: inventory.financialAuthorityGuardrails }
);
assert(
  inventory.financialAuthorityGuardrails?.productionReady === false,
  "Local runtime must not report financial authority as production-ready.",
  { financialAuthorityGuardrails: inventory.financialAuthorityGuardrails }
);

for (const [domain, guardrail] of Object.entries(
  inventory.financialAuthorityGuardrails?.domains ?? {}
)) {
  assert(guardrail.allowedToRun === true, `${domain} financial authority guardrail must allow runtime.`, {
    guardrail,
  });
  assert(guardrail.failClosed === false, `${domain} financial authority must not fail closed in MONOLITH mode.`, {
    guardrail,
  });
}

const authServiceCutoverResult = spawnSync("node", ["scripts/qa/auth-service-cutover.mjs"], {
  encoding: "utf8",
  env: process.env,
});

assert(authServiceCutoverResult.status === 0, "Auth Service cutover QA failed.", {
  stdout: authServiceCutoverResult.stdout,
  stderr: authServiceCutoverResult.stderr,
  exitCode: authServiceCutoverResult.status,
});

let authServiceCutover;
try {
  authServiceCutover = JSON.parse(authServiceCutoverResult.stdout);
} catch (error) {
  fail("Auth Service cutover QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: authServiceCutoverResult.stdout,
  });
}

const settlementDurableResult = spawnSync("node", ["scripts/run-ts-script.mjs", "scripts/qa/settlement-durable-persistence.ts"], {
  encoding: "utf8",
  env: process.env,
});

assert(settlementDurableResult.status === 0, "Settlement durable persistence QA failed.", {
  stdout: settlementDurableResult.stdout,
  stderr: settlementDurableResult.stderr,
  exitCode: settlementDurableResult.status,
});

let settlementDurable;
try {
  settlementDurable = JSON.parse(settlementDurableResult.stdout);
} catch (error) {
  fail("Settlement durable persistence QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementDurableResult.stdout,
  });
}

const settlementFinancialPostingResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-financial-posting.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementFinancialPostingResult.status === 0, "Settlement financial posting QA failed.", {
  stdout: settlementFinancialPostingResult.stdout,
  stderr: settlementFinancialPostingResult.stderr,
  exitCode: settlementFinancialPostingResult.status,
});

let settlementFinancialPosting;
try {
  settlementFinancialPosting = JSON.parse(settlementFinancialPostingResult.stdout);
} catch (error) {
  fail("Settlement financial posting QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementFinancialPostingResult.stdout,
  });
}

const settlementServiceDurableBaselineResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-service-durable-baseline.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementServiceDurableBaselineResult.status === 0, "Settlement Service durable baseline QA failed.", {
  stdout: settlementServiceDurableBaselineResult.stdout,
  stderr: settlementServiceDurableBaselineResult.stderr,
  exitCode: settlementServiceDurableBaselineResult.status,
});

let settlementServiceDurableBaseline;
try {
  settlementServiceDurableBaseline = JSON.parse(settlementServiceDurableBaselineResult.stdout);
} catch (error) {
  fail("Settlement Service durable baseline QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementServiceDurableBaselineResult.stdout,
  });
}

const settlementServiceExecutionDryRunResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-service-execution-dry-run.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementServiceExecutionDryRunResult.status === 0, "Settlement Service execution dry-run QA failed.", {
  stdout: settlementServiceExecutionDryRunResult.stdout,
  stderr: settlementServiceExecutionDryRunResult.stderr,
  exitCode: settlementServiceExecutionDryRunResult.status,
});

let settlementServiceExecutionDryRun;
try {
  settlementServiceExecutionDryRun = JSON.parse(settlementServiceExecutionDryRunResult.stdout);
} catch (error) {
  fail("Settlement Service execution dry-run QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementServiceExecutionDryRunResult.stdout,
  });
}

const settlementServiceIntegrationDryRunResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-service-integration-dry-run.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementServiceIntegrationDryRunResult.status === 0, "Settlement Service integration dry-run QA failed.", {
  stdout: settlementServiceIntegrationDryRunResult.stdout,
  stderr: settlementServiceIntegrationDryRunResult.stderr,
  exitCode: settlementServiceIntegrationDryRunResult.status,
});

let settlementServiceIntegrationDryRun;
try {
  settlementServiceIntegrationDryRun = JSON.parse(settlementServiceIntegrationDryRunResult.stdout);
} catch (error) {
  fail("Settlement Service integration dry-run QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementServiceIntegrationDryRunResult.stdout,
  });
}

const settlementServiceRecoveryResumeResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-service-recovery-resume.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementServiceRecoveryResumeResult.status === 0, "Settlement Service recovery/resume QA failed.", {
  stdout: settlementServiceRecoveryResumeResult.stdout,
  stderr: settlementServiceRecoveryResumeResult.stderr,
  exitCode: settlementServiceRecoveryResumeResult.status,
});

let settlementServiceRecoveryResume;
try {
  settlementServiceRecoveryResume = JSON.parse(settlementServiceRecoveryResumeResult.stdout);
} catch (error) {
  fail("Settlement Service recovery/resume QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementServiceRecoveryResumeResult.stdout,
  });
}

const settlementServiceResettlementDryRunResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-service-resettlement-dry-run.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementServiceResettlementDryRunResult.status === 0, "Settlement Service resettlement dry-run QA failed.", {
  stdout: settlementServiceResettlementDryRunResult.stdout,
  stderr: settlementServiceResettlementDryRunResult.stderr,
  exitCode: settlementServiceResettlementDryRunResult.status,
});

let settlementServiceResettlementDryRun;
try {
  settlementServiceResettlementDryRun = JSON.parse(settlementServiceResettlementDryRunResult.stdout);
} catch (error) {
  fail("Settlement Service resettlement dry-run QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementServiceResettlementDryRunResult.stdout,
  });
}

const settlementAuthoritySwitchResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/settlement-authority-switch.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(settlementAuthoritySwitchResult.status === 0, "Settlement authority switch QA failed.", {
  stdout: settlementAuthoritySwitchResult.stdout,
  stderr: settlementAuthoritySwitchResult.stderr,
  exitCode: settlementAuthoritySwitchResult.status,
});

let settlementAuthoritySwitch;
try {
  settlementAuthoritySwitch = JSON.parse(settlementAuthoritySwitchResult.stdout);
} catch (error) {
  fail("Settlement authority switch QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: settlementAuthoritySwitchResult.stdout,
  });
}

const cashierAtomicCompletionResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/cashier-atomic-completion.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(cashierAtomicCompletionResult.status === 0, "Cashier atomic completion QA failed.", {
  stdout: cashierAtomicCompletionResult.stdout,
  stderr: cashierAtomicCompletionResult.stderr,
  exitCode: cashierAtomicCompletionResult.status,
});

let cashierAtomicCompletion;
try {
  cashierAtomicCompletion = JSON.parse(cashierAtomicCompletionResult.stdout);
} catch (error) {
  fail("Cashier atomic completion QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: cashierAtomicCompletionResult.stdout,
  });
}

const financialWorkerHandlersResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/financial-worker-handlers.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(financialWorkerHandlersResult.status === 0, "Financial worker handlers QA failed.", {
  stdout: financialWorkerHandlersResult.stdout,
  stderr: financialWorkerHandlersResult.stderr,
  exitCode: financialWorkerHandlersResult.status,
});

let financialWorkerHandlers;
try {
  financialWorkerHandlers = JSON.parse(financialWorkerHandlersResult.stdout);
} catch (error) {
  fail("Financial worker handlers QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: financialWorkerHandlersResult.stdout,
  });
}

const ledgerServiceDurablePostingResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/ledger-service-durable-posting.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(ledgerServiceDurablePostingResult.status === 0, "Ledger Service durable posting QA failed.", {
  stdout: ledgerServiceDurablePostingResult.stdout,
  stderr: ledgerServiceDurablePostingResult.stderr,
  exitCode: ledgerServiceDurablePostingResult.status,
});

let ledgerServiceDurablePosting;
try {
  ledgerServiceDurablePosting = JSON.parse(ledgerServiceDurablePostingResult.stdout);
} catch (error) {
  fail("Ledger Service durable posting QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: ledgerServiceDurablePostingResult.stdout,
  });
}

const ledgerServiceAuthorityDryRunResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/ledger-service-authority-dry-run.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(ledgerServiceAuthorityDryRunResult.status === 0, "Ledger Service authority dry-run QA failed.", {
  stdout: ledgerServiceAuthorityDryRunResult.stdout,
  stderr: ledgerServiceAuthorityDryRunResult.stderr,
  exitCode: ledgerServiceAuthorityDryRunResult.status,
});

let ledgerServiceAuthorityDryRun;
try {
  ledgerServiceAuthorityDryRun = JSON.parse(ledgerServiceAuthorityDryRunResult.stdout);
} catch (error) {
  fail("Ledger Service authority dry-run QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: ledgerServiceAuthorityDryRunResult.stdout,
  });
}

const ledgerAuthoritySwitchResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/ledger-authority-switch.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(ledgerAuthoritySwitchResult.status === 0, "Ledger authority switch QA failed.", {
  stdout: ledgerAuthoritySwitchResult.stdout,
  stderr: ledgerAuthoritySwitchResult.stderr,
  exitCode: ledgerAuthoritySwitchResult.status,
});

let ledgerAuthoritySwitch;
try {
  ledgerAuthoritySwitch = JSON.parse(ledgerAuthoritySwitchResult.stdout);
} catch (error) {
  fail("Ledger authority switch QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: ledgerAuthoritySwitchResult.stdout,
  });
}

const creditWalletDurableBaselineResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/credit-wallet-durable-baseline.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(creditWalletDurableBaselineResult.status === 0, "Credit Wallet durable baseline QA failed.", {
  stdout: creditWalletDurableBaselineResult.stdout,
  stderr: creditWalletDurableBaselineResult.stderr,
  exitCode: creditWalletDurableBaselineResult.status,
});

let creditWalletDurableBaseline;
try {
  creditWalletDurableBaseline = JSON.parse(creditWalletDurableBaselineResult.stdout);
} catch (error) {
  fail("Credit Wallet durable baseline QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: creditWalletDurableBaselineResult.stdout,
  });
}

const creditWalletReserveReleaseResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/credit-wallet-reserve-release.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(creditWalletReserveReleaseResult.status === 0, "Credit Wallet reserve/release QA failed.", {
  stdout: creditWalletReserveReleaseResult.stdout,
  stderr: creditWalletReserveReleaseResult.stderr,
  exitCode: creditWalletReserveReleaseResult.status,
});

let creditWalletReserveRelease;
try {
  creditWalletReserveRelease = JSON.parse(creditWalletReserveReleaseResult.stdout);
} catch (error) {
  fail("Credit Wallet reserve/release QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: creditWalletReserveReleaseResult.stdout,
  });
}

const creditWalletSettlementApplyResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/credit-wallet-settlement-apply.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(creditWalletSettlementApplyResult.status === 0, "Credit Wallet settlement apply QA failed.", {
  stdout: creditWalletSettlementApplyResult.stdout,
  stderr: creditWalletSettlementApplyResult.stderr,
  exitCode: creditWalletSettlementApplyResult.status,
});

let creditWalletSettlementApply;
try {
  creditWalletSettlementApply = JSON.parse(creditWalletSettlementApplyResult.stdout);
} catch (error) {
  fail("Credit Wallet settlement apply QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: creditWalletSettlementApplyResult.stdout,
  });
}

const creditWalletAuthorityDryRunResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/credit-wallet-authority-dry-run.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(creditWalletAuthorityDryRunResult.status === 0, "Credit Wallet authority dry-run QA failed.", {
  stdout: creditWalletAuthorityDryRunResult.stdout,
  stderr: creditWalletAuthorityDryRunResult.stderr,
  exitCode: creditWalletAuthorityDryRunResult.status,
});

let creditWalletAuthorityDryRun;
try {
  creditWalletAuthorityDryRun = JSON.parse(creditWalletAuthorityDryRunResult.stdout);
} catch (error) {
  fail("Credit Wallet authority dry-run QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: creditWalletAuthorityDryRunResult.stdout,
  });
}

const creditAuthoritySwitchResult = spawnSync(
  "node",
  ["scripts/run-ts-script.mjs", "scripts/qa/credit-authority-switch.ts"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

assert(creditAuthoritySwitchResult.status === 0, "Credit authority switch QA failed.", {
  stdout: creditAuthoritySwitchResult.stdout,
  stderr: creditAuthoritySwitchResult.stderr,
  exitCode: creditAuthoritySwitchResult.status,
});

let creditAuthoritySwitch;
try {
  creditAuthoritySwitch = JSON.parse(creditAuthoritySwitchResult.stdout);
} catch (error) {
  fail("Credit authority switch QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: creditAuthoritySwitchResult.stdout,
  });
}

const durableSmokeResult = spawnSync("node", ["scripts/qa/game-engine-durable-runtime-smoke.mjs"], {
  encoding: "utf8",
  env: process.env,
});

assert(durableSmokeResult.status === 0, "Game Engine durable runtime smoke QA failed.", {
  stdout: durableSmokeResult.stdout,
  stderr: durableSmokeResult.stderr,
  exitCode: durableSmokeResult.status,
});

let durableSmoke;
try {
  durableSmoke = JSON.parse(durableSmokeResult.stdout);
} catch (error) {
  fail("Game Engine durable runtime smoke QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: durableSmokeResult.stdout,
  });
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Local integrated runtime baseline is reachable.",
      authServiceStatus: auth.status,
      durablePersistence: {
        gameEngineDatabaseUrlConfigured: inventory.durablePersistence.gameEngineDatabaseUrlConfigured,
        gameEngineDurablePersistenceModeActive: inventory.durablePersistence.gameEngineDurablePersistenceModeActive,
        settlementDatabaseUrlConfigured: inventory.durablePersistence.settlementDatabaseUrlConfigured,
        settlementPersistenceSchemaCurrent: inventory.durablePersistence.settlementPersistenceSchemaCurrent,
        creditWalletDatabaseUrlConfigured: inventory.durablePersistence.creditWalletDatabaseUrlConfigured,
        migrationsCurrent: inventory.durablePersistence.migrationsCurrent,
      },
      authServiceCutover,
      financialAuthorityGuardrails: inventory.financialAuthorityGuardrails,
      settlementDurablePersistence: {
        status: settlementDurable.status,
        checks: settlementDurable.checks,
      },
      settlementFinancialPosting: {
        status: settlementFinancialPosting.status,
        checks: settlementFinancialPosting.checks,
      },
      settlementServiceDurableBaseline: {
        status: settlementServiceDurableBaseline.status,
        checks: settlementServiceDurableBaseline.checks,
      },
      settlementServiceExecutionDryRun: {
        status: settlementServiceExecutionDryRun.status,
        checks: settlementServiceExecutionDryRun.checks,
      },
      settlementServiceIntegrationDryRun: {
        status: settlementServiceIntegrationDryRun.status,
        checks: settlementServiceIntegrationDryRun.checks,
      },
      settlementServiceRecoveryResume: {
        status: settlementServiceRecoveryResume.status,
        checks: settlementServiceRecoveryResume.checks,
      },
      settlementServiceResettlementDryRun: {
        status: settlementServiceResettlementDryRun.status,
        checks: settlementServiceResettlementDryRun.checks,
      },
      settlementAuthoritySwitch: {
        status: settlementAuthoritySwitch.status,
        checks: settlementAuthoritySwitch.checks,
      },
      cashierAtomicCompletion: {
        status: cashierAtomicCompletion.status,
        checks: cashierAtomicCompletion.checks,
      },
      financialWorkerHandlers: {
        status: financialWorkerHandlers.status,
        checks: financialWorkerHandlers.checks,
      },
      ledgerServiceDurablePosting: {
        status: ledgerServiceDurablePosting.status,
        checks: ledgerServiceDurablePosting.checks,
      },
      ledgerServiceAuthorityDryRun: {
        status: ledgerServiceAuthorityDryRun.status,
        checks: ledgerServiceAuthorityDryRun.checks,
      },
      ledgerAuthoritySwitch: {
        status: ledgerAuthoritySwitch.status,
        checks: ledgerAuthoritySwitch.checks,
      },
      creditWalletDurableBaseline: {
        status: creditWalletDurableBaseline.status,
        checks: creditWalletDurableBaseline.checks,
      },
      creditWalletReserveRelease: {
        status: creditWalletReserveRelease.status,
        checks: creditWalletReserveRelease.checks,
      },
      creditWalletSettlementApply: {
        status: creditWalletSettlementApply.status,
        checks: creditWalletSettlementApply.checks,
      },
      creditWalletAuthorityDryRun: {
        status: creditWalletAuthorityDryRun.status,
        checks: creditWalletAuthorityDryRun.checks,
      },
      creditAuthoritySwitch: {
        status: creditAuthoritySwitch.status,
        checks: creditAuthoritySwitch.checks,
      },
      gameEngineDurableSmoke: {
        status: durableSmoke.status,
        coverage: durableSmoke.coverage,
      },
      checkedServices: inventory.serviceHealth.map((item) => ({
        name: item.name,
        status: item.status,
      })),
      checkedReadiness: (inventory.serviceReadiness ?? []).map((item) => ({
        name: item.name,
        status: item.status,
      })),
    },
    null,
    2
  )
);
