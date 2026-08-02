import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import {
  cashierLaunchMutationsEnabled,
  getLaunchConfigurationReadiness,
  LAUNCH_CONFIGURATION_FINGERPRINT,
  LAUNCH_CONFIGURATION_VERSION,
} from "../../src/domains/launch-configuration/launch-configuration";

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

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const governedEnvironment = {
  DEPLOYMENT_ENVIRONMENT: "production",
  LAUNCH_CONFIGURATION_VERSION,
  CREDIT_ONLY_LAUNCH_ENABLED: "true",
  CASHIER_LAUNCH_ENABLED: "false",
  PAYMENT_PROVIDER_INTEGRATION_ENABLED: "false",
  PLAYER_CASH_DEPOSITS_ENABLED: "false",
  PLAYER_CASH_WITHDRAWALS_ENABLED: "false",
  EXTERNAL_INTEGRATIONS_ENABLED: "false",
  PRODUCTION_UI_ENABLED: "false",
  SELF_SERVICE_ONBOARDING_ENABLED: "false",
  PLATFORM_HIERARCHY_MODE: "CANONICAL",
  PLATFORM_LEGACY_DEVELOPMENT_MUTATIONS_ENABLED: "false",
  CANONICAL_TICKET_PATH_ENABLED: "true",
  TICKET_LEGACY_MUTATIONS_ENABLED: "false",
  TICKET_SCOPE_ENFORCEMENT_ENABLED: "true",
  TICKET_CORRELATION_CONTRACT_ENABLED: "true",
  CANONICAL_DRAW_ORCHESTRATION_ENABLED: "true",
  OUTCOME_CANONICAL_PIPELINE_ENABLED: "false",
  OUTCOME_LEGACY_PUBLICATION_ENABLED: "false",
  OUTCOME_CANONICAL_RECOVERY_ENABLED: "true",
  PRODUCT_LAUNCH_STATUS: "DISABLED_PENDING_BUSINESS_APPROVAL",
  REQUIRED_WORKERS_ENABLED: "true",
  AUDIT_RECORDING_ENABLED: "true",
  READINESS_ENFORCEMENT_ENABLED: "true",
  AUTH_AUTHORITY: "MONOLITH",
  LEDGER_AUTHORITY: "MONOLITH",
  CREDIT_AUTHORITY: "MONOLITH",
  SETTLEMENT_AUTHORITY: "MONOLITH",
} as const;

async function main() {
  const originalEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(governedEnvironment)) {
    originalEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const production = getLaunchConfigurationReadiness();
  check("approved production baseline is internally consistent", production.ready, {
    version: production.version,
    fingerprint: production.fingerprint,
  });
  check(
    "configuration fingerprint is safe and stable",
    /^sha256:[a-f0-9]{64}$/.test(LAUNCH_CONFIGURATION_FINGERPRINT)
  );

  process.env.OUTCOME_LEGACY_PUBLICATION_ENABLED = "true";
  check(
    "legacy Outcome publication fails readiness",
    !getLaunchConfigurationReadiness().ready
  );
  process.env.OUTCOME_LEGACY_PUBLICATION_ENABLED = "false";

  process.env.CASHIER_LAUNCH_ENABLED = "true";
  check(
    "Cashier activation contradicts the credit-only baseline",
    !getLaunchConfigurationReadiness().ready
  );
  process.env.CASHIER_LAUNCH_ENABLED = "false";
  check("Cashier mutations are disabled by default for launch", !cashierLaunchMutationsEnabled());

  process.env.DEPLOYMENT_ENVIRONMENT = "staging";
  check(
    "staging uses the governed launch baseline",
    getLaunchConfigurationReadiness().ready
  );

  for (const [name, value] of originalEnvironment) restore(name, value);

  const [
    productionCompose,
    localCompose,
    ticketRoute,
    authRepository,
    ...cashierMutationRoutes
  ] =
    await Promise.all([
      readFile("docker-compose.production.yml", "utf8"),
      readFile("docker-compose.yml", "utf8"),
      readFile("app/api/tickets/route.ts", "utf8"),
      readFile(
        "services/auth-service/src/AuthService.Infrastructure/PostgresAuthPersistence.cs",
        "utf8"
      ),
      ...[
        "app/api/cashier/deposits/route.ts",
        "app/api/cashier/withdrawals/route.ts",
        "app/api/cashier/transactions/[transactionId]/approve/route.ts",
        "app/api/cashier/transactions/[transactionId]/complete/route.ts",
        "app/api/cashier/transactions/[transactionId]/reject/route.ts",
        "app/api/cashier/transactions/[transactionId]/cancel/route.ts",
      ].map((file) => readFile(file, "utf8")),
    ]);

  check(
    "production Compose freezes conservative authority modes",
    ["AUTH_AUTHORITY", "LEDGER_AUTHORITY", "CREDIT_AUTHORITY", "SETTLEMENT_AUTHORITY"].every(
      (name) => productionCompose.includes(`${name}: \${${name}:-MONOLITH}`)
    )
  );
  check(
    "production .NET services receive canonical Outcome recovery posture",
    productionCompose.match(/OUTCOME_LEGACY_PUBLICATION_ENABLED: "false"/g)?.length === 2 &&
      productionCompose.match(/OUTCOME_CANONICAL_RECOVERY_ENABLED: "true"/g)?.length === 2
  );
  check(
    "all required launch workers are present",
    [
      "outbox-dispatcher",
      "worker-critical-financial",
      "worker-ticket-lifecycle",
      "worker-settlement",
      "worker-accounting",
      "worker-commission",
      "worker-reconciliation",
      "worker-operational-access",
      "worker-reporting",
    ].every((worker) => productionCompose.includes(`  ${worker}:`))
  );
  check(
    "local Cashier exception is explicit",
    localCompose.includes('DEPLOYMENT_ENVIRONMENT: local') &&
      localCompose.includes('CASHIER_LAUNCH_ENABLED: "true"')
  );
  check(
    "every Cashier mutation endpoint fails through the launch gate",
    cashierMutationRoutes.every((source) =>
      source.includes("requireCashierLaunchMutationEnabled")
    )
  );
  check(
    "canonical Ticket API requires frozen permissions",
    ticketRoute.includes('requirePermission(request, "tickets.read")') &&
      ticketRoute.includes('requirePermission(request, "tickets.create")')
  );
  check(
    "Auth Service resolves role permission metadata",
    authRepository.includes("role.metadata->'permissions'")
  );

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local",
  });
  try {
    const permissionResult = await pool.query<{ code: string }>(
      `select code
       from auth_service.permissions
       where code = any($1::text[])
         and disabled_at is null
       order by code`,
      [["tickets.read", "tickets.create", "tickets.cancel"]]
    );
    check("Ticket permission catalog is durable", permissionResult.rowCount === 3);

    const roleResult = await pool.query<{
      code: string;
      permissions: string[];
    }>(
      `select code, array(
         select jsonb_array_elements_text(metadata->'permissions')
         order by 1
       ) permissions
       from auth_service.roles
       where code = any($1::text[])
       order by code`,
      [[
        "PLATFORM_SUPER_ADMIN",
        "PLATFORM_OPERATIONS_ADMIN",
        "PLATFORM_READ_ONLY_AUDITOR",
      ]]
    );
    const rolePermissions = new Map(
      roleResult.rows.map((row) => [row.code, row.permissions])
    );
    check(
      "approved production roles have least-privilege Ticket assignments",
      ["tickets.read", "tickets.create", "tickets.cancel"].every((permission) =>
        rolePermissions.get("PLATFORM_SUPER_ADMIN")?.includes(permission)
      ) &&
        ["tickets.read", "tickets.create", "tickets.cancel"].every((permission) =>
          rolePermissions.get("PLATFORM_OPERATIONS_ADMIN")?.includes(permission)
        ) &&
        rolePermissions.get("PLATFORM_READ_ONLY_AUDITOR")?.includes("tickets.read") === true &&
        !rolePermissions.get("PLATFORM_READ_ONLY_AUDITOR")?.includes("tickets.create") &&
        !rolePermissions.get("PLATFORM_READ_ONLY_AUDITOR")?.includes("tickets.cancel"),
      { roles: Object.fromEntries(rolePermissions) }
    );

    const correlationResult = await pool.query<{ ready: boolean }>(
      `select
         to_regclass('ticket_authority.ticket_correlations') is not null
         and to_regclass('ticket_authority.ticket_lifecycle_events') is not null
         and exists (
           select 1
           from pg_proc procedure
           join pg_namespace namespace on namespace.oid = procedure.pronamespace
           where namespace.nspname = 'ticket_authority'
             and procedure.proname = 'request_settlement'
         )
         and exists (
           select 1
           from pg_proc procedure
           join pg_namespace namespace on namespace.oid = procedure.pronamespace
           where namespace.nspname = 'ticket_completion_authority'
             and procedure.proname = 'complete_ticket'
         )
         and to_regprocedure(
           'ticket_authority.record_correlation(uuid,uuid,text,text,text,text,jsonb,text)'
         ) is null
         as ready`
    );
    check(
      "durable typed Ticket lifecycle authority is callable",
      correlationResult.rows[0]?.ready === true
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
        version: LAUNCH_CONFIGURATION_VERSION,
        fingerprint: LAUNCH_CONFIGURATION_FINGERPRINT,
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
