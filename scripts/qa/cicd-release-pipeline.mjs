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
    "npm run migrations:local:run",
    "npm run migrations:local:validate",
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
    productionComposeImageOverrides: "PASS",
  },
}, null, 2));
