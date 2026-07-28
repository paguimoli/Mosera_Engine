import { existsSync, readFileSync } from "node:fs";

const workflowFile = ".github/workflows/release-pipeline.yml";
const productionComposeFile = "docker-compose.production.yml";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function includesAll(text, values, label) {
  for (const value of values) {
    assert(text.includes(value), `${label} must include ${value}.`);
  }
}

assert(existsSync(workflowFile), "Release pipeline workflow is missing.", {
  workflowFile,
});
assert(existsSync(productionComposeFile), "Production compose file is missing.", {
  productionComposeFile,
});

const workflow = readFileSync(workflowFile, "utf8");
const productionCompose = readFileSync(productionComposeFile, "utf8");

assert(workflow.includes("name: CI/CD Release Pipeline"), "Workflow must have the expected name.");
assert(workflow.includes("pull_request:"), "Workflow must run on pull requests.");
assert(workflow.includes("workflow_dispatch:"), "Workflow must support manual dispatch.");
assert(workflow.includes("packages: write"), "Workflow must have package write permission for GHCR publish.");
assert(workflow.includes("security-events: write"), "Workflow must be able to upload security scan evidence.");

includesAll(
  workflow,
  [
    "npm run lint",
    "npm run build",
    "npm run security:audit",
    "docker compose config",
    "docker compose -f docker-compose.production.yml config",
    "npm run qa:production-config",
    "npm run qa:production-compose",
    "npm run qa:managed-services-wiring",
    "npm run qa:cicd-release-pipeline",
    "npm run qa:production-migration-governance",
    "npm run qa:observability-baseline",
    "npm run qa:production-runtime",
    "npm run qa:queue-operations",
    "npm run qa:container-network-hardening",
  ],
  "Validation job"
);

includesAll(
  workflow,
  [
    "integration-validation:",
    "name: Canonical Integration Validation",
    "if: always()",
    "merge_group:",
    "postgres:16-alpine",
    "rabbitmq:3-management",
    "redis:7-alpine",
    "lottery_disposable",
    'ALLOW_DISPOSABLE_DB_MIGRATIONS: "true"',
    "MIGRATIONS_POSTGRES_CONTAINER",
    "job.services.postgres.id",
    "AUTH_AUTHORITY: MONOLITH",
    "bash scripts/ci/run-integration-validation.sh",
    "bash scripts/ci/collect-integration-evidence.sh",
    "node scripts/ci/sanitize-integration-evidence.mjs",
    "actions/upload-artifact@v4",
    "retention-days: 30",
    "compression-level: 9",
    "GITHUB_STEP_SUMMARY",
    "Require prerequisite validation",
  ],
  "Canonical integration validation job"
);

const integrationHarness = readFileSync("scripts/ci/run-integration-validation.sh", "utf8");
includesAll(
  integrationHarness,
  [
    'CI:-}" != "true"',
    'GITHUB_ACTIONS:-}" != "true"',
    'ALLOW_DISPOSABLE_DB_MIGRATIONS}" != "true"',
    'AUTH_AUTHORITY:-MONOLITH}" != "MONOLITH"',
    "npm --silent run migrations:local:run",
    "npm --silent run migrations:local:validate",
    "npm --silent run qa:local-migrations",
    "npm --silent run qa:auth-service-cutover",
    "npm --silent run qa:local-integrated-runtime",
    "076_add_authentication_authority_consolidation",
    "scripts/migrations/query-local-postgres.mjs",
  ],
  "Canonical integration harness"
);

assert(
  !workflow.includes("apt-get install --yes postgresql-client"),
  "Canonical integration validation must use the PostgreSQL client inside Docker."
);
assert(
  !/\bpsql\s+-X\b/.test(integrationHarness),
  "Canonical integration harness must not invoke host psql."
);

assert(
  workflow.includes("needs:\n      - validate\n      - integration-validation"),
  "Image publication must wait for canonical integration validation."
);

includesAll(
  workflow,
  [
    "services/auth-service/AuthService.sln",
    "services/game-engine/GameEngine.sln",
    "services/ledger-service/LedgerService.csproj",
    "services/credit-wallet-service/CreditWalletService.csproj",
    "services/settlement-service/SettlementService.csproj",
  ],
  ".NET build/test gates"
);

const imageNames = [
  "lottery-app",
  "auth-service",
  "game-engine",
  "ledger-service",
  "credit-wallet-service",
  "settlement-service",
];

for (const imageName of imageNames) {
  assert(workflow.includes(`image: ${imageName}`), `Workflow image matrix must include ${imageName}.`);
}

includesAll(
  workflow,
  [
    "docker/metadata-action@v5",
    "docker/build-push-action@v6",
    "docker/login-action@v3",
    "ghcr.io",
    "type=raw,value=sha-${{ github.sha }}",
    "type=semver,pattern={{version}}",
    "github.ref_protected || startsWith(github.ref, 'refs/tags/v')",
  ],
  "Image publish job"
);

includesAll(
  workflow,
  [
    "org.opencontainers.image.revision=${{ github.sha }}",
    "org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}",
    "org.opencontainers.image.service.name=${{ matrix.service }}",
  ],
  "Image metadata labels"
);

includesAll(
  workflow,
  [
    "aquasecurity/trivy-action",
    "anchore/sbom-action",
    "Upload Trivy source scan",
    "Generate source SBOM",
    "Generate image SBOM",
  ],
  "Supply-chain gates"
);

assert(!workflow.includes(":latest"), "Workflow must not publish latest-only tags.");
assert(!/type=raw,value=latest\b/.test(workflow), "Workflow must not publish a latest tag.");

for (const imageName of imageNames) {
  assert(
    productionCompose.includes(`ghcr.io/lottery-app/${imageName}:`),
    `Production compose must have an overridable GHCR image reference for ${imageName}.`
  );
}

includesAll(
  productionCompose,
  [
    "PRODUCTION_APP_IMAGE",
    "PRODUCTION_AUTH_SERVICE_IMAGE",
    "PRODUCTION_GAME_ENGINE_IMAGE",
    "PRODUCTION_LEDGER_SERVICE_IMAGE",
    "PRODUCTION_CREDIT_WALLET_SERVICE_IMAGE",
    "PRODUCTION_SETTLEMENT_SERVICE_IMAGE",
    "RELEASE_VERSION:-production-required",
  ],
  "Production compose image overrides"
);

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    workflowPresent: "PASS",
    validationGatesConfigured: "PASS",
    dotnetBuildTestConfigured: "PASS",
    imageMatrixConfigured: "PASS",
    immutableShaTagsConfigured: "PASS",
    protectedPushGateConfigured: "PASS",
    imageMetadataConfigured: "PASS",
    supplyChainGatesConfigured: "PASS",
    canonicalIntegrationValidationConfigured: "PASS",
    productionComposeImageOverrides: "PASS",
  },
}, null, 2));
