import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type Check = {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly metadata: Record<string, unknown>;
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
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) return sourceFiles(target);
        return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
      })
    )
  ).flat();
}

async function main() {
  const authorityPath =
    "src/domains/hierarchy/canonical-hierarchy-authority.ts";
  const authority = await source(authorityPath);
  const accountService = await source("src/domains/accounts/account.service.ts");
  const accountRepository = await source(
    "src/domains/accounts/account.repository.ts"
  );
  const accountScope = await source(
    "src/domains/accounts/account-scope-governance.ts"
  );
  const platformRepository = await source(
    "src/domains/platform-management/platform-management.repository.ts"
  );

  check(
    "canonical authority owns Platform through Website traversal",
    [
      "resolveOrganizationHierarchy",
      "resolveTenantHierarchy",
      "resolveBrandHierarchy",
      "resolveMarketHierarchy",
      "resolveWebsiteHierarchy",
      "resolvePlatformHierarchy",
    ].every((name) => authority.includes(`function ${name}`))
  );
  check(
    "canonical authority owns account ancestor and descendant traversal",
    authority.includes("function resolveAccountAncestors") &&
      authority.includes("function resolveAccountDescendants") &&
      (authority.match(/with recursive/g) ?? []).length === 2
  );
  check(
    "recursive traversal is cycle bounded",
    authority.includes("not parent.id = any(hierarchy.visited)") &&
      authority.includes("not child.id = any(descendants.visited)")
  );
  check(
    "parent movement and membership validation are centralized",
    authority.includes("function validateAccountPlacement") &&
      authority.includes("function validateAccountMembership") &&
      authority.includes("Account hierarchy cannot cross canonical scope.") &&
      authority.includes("Account hierarchy cycle detected.")
  );
  check(
    "account mutations delegate hierarchy decisions",
    accountService.includes("validateAccountPlacement") &&
      accountService.includes("resolveAccountDescendants") &&
      !accountService.includes("function getDescendantAccountIds") &&
      !accountService.includes("validateAccountParentRule")
  );
  check(
    "account scope authorization uses canonical ancestors",
    accountScope.includes("resolveAccountAncestors") &&
      !accountScope.includes("resolveCanonicalAccountHierarchy")
  );
  check(
    "platform management delegates hierarchy resolution and lifecycle checks",
    platformRepository.includes("resolvePlatformHierarchy") &&
      platformRepository.includes("validatePlatformActivationHierarchy") &&
      platformRepository.includes("validatePlatformRetirementHierarchy") &&
      !platformRepository.includes("with recursive")
  );
  check(
    "production account repository contains no hierarchy traversal authority",
    !accountRepository.includes("with recursive") &&
      !accountRepository.includes("resolveCanonicalAccountHierarchy") &&
      !accountRepository.includes("listChildren(")
  );

  const productionFiles = (
    await Promise.all(["app/api", "src/domains"].map(sourceFiles))
  ).flat();
  const duplicateRecursiveTraversal: string[] = [];
  for (const file of productionFiles) {
    if (file === authorityPath) continue;
    const contents = await source(file);
    if (/with\s+recursive[\s\S]{0,1000}(?:parent_account_id|hierarchy)/i.test(contents)) {
      duplicateRecursiveTraversal.push(path.relative(process.cwd(), file));
    }
  }
  check(
    "no duplicate production recursive hierarchy traversal remains",
    duplicateRecursiveTraversal.length === 0,
    { duplicateRecursiveTraversal }
  );

  const migration081 = await source(
    "scripts/migrations/local/081_add_canonical_platform_hierarchy.sql"
  );
  const migration082 = await source(
    "scripts/migrations/local/082_add_account_player_agent_scope_governance.sql"
  );
  check(
    "durable hierarchy guardrails remain authoritative persistence invariants",
    migration081.includes("platform.validate_canonical_parent_status") &&
      migration082.includes("platform.validate_governed_account") &&
      migration082.includes("platform.account_governance_events")
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
