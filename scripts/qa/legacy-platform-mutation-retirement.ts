import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import * as canonicalCollection from "../../app/api/platform-management/[resource]/route";
import {
  setPlatformManagementAuthOverrideForTesting,
} from "../../src/domains/platform-management/platform-management-auth";
import {
  assertLegacyPlatformDevelopmentMutationAllowed,
  getPlatformMutationAuthorityChecks,
  legacyPlatformMutationGone,
} from "../../src/domains/platform-management/platform-mutation-authority";

type JsonObject = Record<string, unknown>;

const checks: Array<{
  name: string;
  status: "PASS" | "FAIL";
  metadata?: JsonObject;
}> = [];

function addCheck(name: string, passed: boolean, metadata: JsonObject = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

async function responseJson(response: Response) {
  return (await response.json()) as JsonObject;
}

async function assertGone(name: string, response: Response) {
  const body = await responseJson(response);
  addCheck(
    name,
    response.status === 410 &&
      body.code === "LEGACY_PLATFORM_MUTATION_RETIRED" &&
      response.headers.get("deprecation") === "true",
    { status: response.status, body }
  );
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
  const runId = randomUUID();
  process.env.DATABASE_URL ??=
    "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";

  await assertGone(
    "legacy Brand create returns 410",
    legacyPlatformMutationGone("brand")
  );
  await assertGone(
    "legacy Brand patch returns 410",
    legacyPlatformMutationGone("brand")
  );
  await assertGone(
    "legacy Brand default mutation returns 410",
    legacyPlatformMutationGone("brand")
  );
  await assertGone(
    "legacy Market create returns 410",
    legacyPlatformMutationGone("market")
  );
  await assertGone(
    "legacy Market patch returns 410",
    legacyPlatformMutationGone("market")
  );
  await assertGone(
    "legacy Market default mutation returns 410",
    legacyPlatformMutationGone("market")
  );
  const legacyBrandCollectionSource = await readFile(
    "app/api/brands/route.ts",
    "utf8"
  );
  const legacyMarketCollectionSource = await readFile(
    "app/api/markets/route.ts",
    "utf8"
  );
  addCheck(
    "legacy scoped reads remain available",
    /export async function GET\(/.test(legacyBrandCollectionSource) &&
      /export async function GET\(/.test(legacyMarketCollectionSource)
  );
  const retiredRouteSources = await Promise.all(
    [
      "app/api/brands/route.ts",
      "app/api/brands/[brandId]/route.ts",
      "app/api/brands/[brandId]/set-default/route.ts",
      "app/api/markets/route.ts",
      "app/api/markets/[marketId]/route.ts",
      "app/api/markets/[marketId]/set-default/route.ts",
    ].map((file) => readFile(file, "utf8"))
  );
  addCheck(
    "all legacy HTTP writers delegate to explicit retirement response",
    retiredRouteSources.every((source) =>
      source.includes("legacyPlatformMutationGone")
    )
  );

  setPlatformManagementAuthOverrideForTesting(["system.admin"]);
  const organizationBody = {
    code: `retirement-org-${runId}`,
    name: "Legacy Retirement QA Organization",
    status: "Draft",
    version: "1.0.0",
    contentHash: `sha256:legacy-retirement:${runId}`,
  };
  const canonicalRequest = () =>
    new Request(
      "http://qa.local/api/platform-management/organizations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": `retirement-${runId}`,
          "x-correlation-id": `retirement-correlation-${runId}`,
        },
        body: JSON.stringify(organizationBody),
      }
    );
  const params = {
    params: Promise.resolve({ resource: "organizations" }),
  };
  const first = await canonicalCollection.POST(canonicalRequest(), params);
  const firstBody = await responseJson(first);
  const repeated = await canonicalCollection.POST(canonicalRequest(), params);
  const repeatedBody = await responseJson(repeated);
  const firstOrganization = firstBody.organization as JsonObject | undefined;
  const repeatedOrganization = repeatedBody.organization as
    | JsonObject
    | undefined;
  addCheck(
    "canonical Organization create succeeds",
    first.status === 201 && typeof firstOrganization?.id === "string",
    { status: first.status, body: firstBody }
  );
  addCheck(
    "identical canonical create retry is idempotent",
    repeated.status === 201 &&
      repeatedOrganization?.id === firstOrganization?.id,
    { status: repeated.status, body: repeatedBody }
  );
  const auditMetadata = firstOrganization?.auditMetadata as
    | JsonObject
    | undefined;
  addCheck(
    "canonical mutation records server-derived audit context",
    auditMetadata?.actorId === "platform-management-qa" &&
      auditMetadata.permission === "platform.organization.create" &&
      auditMetadata.requestId === `retirement-${runId}`,
    { auditMetadata: auditMetadata ?? {} }
  );

  const conflictRequest = new Request(
    "http://qa.local/api/platform-management/organizations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...organizationBody,
        name: "Conflicting Organization Payload",
      }),
    }
  );
  const conflict = await canonicalCollection.POST(conflictRequest, params);
  addCheck("conflicting canonical retry fails closed", conflict.status === 409, {
    status: conflict.status,
    body: await responseJson(conflict),
  });
  setPlatformManagementAuthOverrideForTesting(null);

  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalDeploymentEnvironment = process.env.DEPLOYMENT_ENVIRONMENT;
  const originalLegacyFlag =
    process.env.PLATFORM_LEGACY_DEVELOPMENT_MUTATIONS_ENABLED;
  process.env.DEPLOYMENT_ENVIRONMENT = "production";
  process.env.PLATFORM_LEGACY_DEVELOPMENT_MUTATIONS_ENABLED = "true";

  let productionGateRejected = false;
  try {
    assertLegacyPlatformDevelopmentMutationAllowed();
  } catch (error) {
    productionGateRejected =
      error instanceof Error &&
      error.message.includes("Legacy Platform mutation is disabled");
  }
  addCheck(
    "development mutation writer fails outside development",
    productionGateRejected
  );
  const unsafeReadiness = getPlatformMutationAuthorityChecks();
  addCheck(
    "readiness fails when development bypass is production-enabled",
    unsafeReadiness.some(
      (check) =>
        check.checkName ===
          "platform_mutation:development_writer_isolated" &&
        !check.ready
    ),
    { checks: unsafeReadiness }
  );

  restoreEnvironment("NODE_ENV", originalNodeEnvironment);
  restoreEnvironment("DEPLOYMENT_ENVIRONMENT", originalDeploymentEnvironment);
  restoreEnvironment(
    "PLATFORM_LEGACY_DEVELOPMENT_MUTATIONS_ENABLED",
    originalLegacyFlag
  );
  const safeReadiness = getPlatformMutationAuthorityChecks();
  addCheck(
    "readiness passes with only canonical production mutations",
    safeReadiness.every((check) => check.ready),
    { checks: safeReadiness }
  );

  const productionSources = (
    await Promise.all(
      ["app", "src", "scripts/workers", "scripts/operations"].map(sourceFiles)
    )
  ).flat();
  const forbiddenConsumerPattern =
    /\/api\/(?:brands|markets)(?:\/|["'`?])|from\s+["'][^"']*domains\/(?:brands|markets)\/(?:brand|market)\.service["']/;
  const consumers: string[] = [];
  for (const file of productionSources) {
    const source = await readFile(file, "utf8");
    if (
      forbiddenConsumerPattern.test(source) &&
      !file.includes("app/api/brands/") &&
      !file.includes("app/api/markets/")
    ) {
      consumers.push(path.relative(process.cwd(), file));
    }
  }
  addCheck("no production consumer references retired mutations", consumers.length === 0, {
    consumers,
  });

  addCheck(
    "canonical Platform route is the only production collection mutation path",
    typeof canonicalCollection.POST === "function" &&
      typeof canonicalCollection.GET === "function"
  );
  addCheck(
    "no legacy Website mutation route exists",
    !(await sourceFiles("app/api")).some((file) =>
      file.includes("/api/websites/")
    )
  );

  const failed = checks.filter((check) => check.status === "FAIL");
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

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

main()
  .catch((error: unknown) => {
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
  })
  .finally(() => {
    setPlatformManagementAuthOverrideForTesting(null);
  });
