import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const productionComposeFile = "docker-compose.production.yml";
const caddyFile = "deploy/caddy/Caddyfile";

const publicEdgeService = "caddy";
const caddyRuntimeExceptions = new Set(["NET_BIND_SERVICE"]);
const internalApplicationServices = [
  "app",
  "auth-service",
  "game-engine",
  "ledger-service",
  "credit-wallet-service",
  "settlement-service",
  "outbox-dispatcher",
  "worker-critical-financial",
  "worker-ticket-lifecycle",
  "worker-settlement",
  "worker-accounting",
  "worker-commission",
  "worker-reconciliation",
  "worker-operational-access",
  "worker-reporting",
];

const dockerfiles = [
  "Dockerfile",
  "services/auth-service/Dockerfile",
  "services/game-engine/Dockerfile",
  "services/ledger-service/Dockerfile",
  "services/credit-wallet-service/Dockerfile",
  "services/settlement-service/Dockerfile",
];

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} was not valid JSON.`, {
      error: error instanceof Error ? error.message : String(error),
      value,
    });
  }
}

function runComposeConfig(args = []) {
  const result = spawnSync("docker", [
    "compose",
    "-f",
    productionComposeFile,
    ...args,
    "config",
    "--format",
    "json",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_VERSION: "qa-container-network-hardening",
      PRODUCTION_HOSTNAME: "qa.example.com",
    },
  });

  assert(result.status === 0, "Production compose config failed.", {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr ?? result.error?.message,
  });

  return parseJson(result.stdout, "Production compose config");
}

function volumeText(service) {
  return JSON.stringify(service.volumes ?? []);
}

function serviceNetworks(service) {
  const networks = service.networks ?? {};
  if (Array.isArray(networks)) return networks;
  return Object.keys(networks);
}

function assertHardenedContainer(name, service, options = {}) {
  assert(service.privileged !== true, `${name} must not run privileged.`, { service });
  assert(service.read_only === true, `${name} must use a read-only root filesystem.`, { service });
  assert(Array.isArray(service.security_opt), `${name} must configure security_opt.`, { service });
  assert(
    service.security_opt.includes("no-new-privileges:true"),
    `${name} must prevent privilege escalation.`,
    { security_opt: service.security_opt }
  );
  assert(Array.isArray(service.cap_drop), `${name} must drop Linux capabilities.`, { service });
  assert(service.cap_drop.includes("ALL"), `${name} must drop all Linux capabilities by default.`, {
    cap_drop: service.cap_drop,
  });

  const unexpectedCaps = (service.cap_add ?? []).filter((capability) => !caddyRuntimeExceptions.has(capability));
  assert(unexpectedCaps.length === 0, `${name} must not add unexpected Linux capabilities.`, {
    cap_add: service.cap_add,
  });

  assert(!volumeText(service).includes("/var/run/docker.sock"), `${name} must not mount the Docker socket.`, {
    volumes: service.volumes,
  });
  assert(service.pids_limit, `${name} must set a process limit.`, { service });
  assert(service.tmpfs?.length > 0, `${name} must use tmpfs for writable temporary paths.`, { tmpfs: service.tmpfs });
  assert(service.mem_limit, `${name} must set a memory limit.`, { service });
  assert(service.mem_reservation, `${name} must set a memory reservation.`, { service });
  assert(service.cpus, `${name} must set a CPU limit.`, { service });

  if (options.expectNonRoot !== false) {
    assert(service.user, `${name} must run as a non-root user.`, { service });
    assert(!String(service.user).startsWith("0"), `${name} must not run as root.`, { user: service.user });
  }
}

assert(existsSync(productionComposeFile), "Production compose file is missing.", { productionComposeFile });
assert(existsSync(caddyFile), "Caddyfile is missing.", { caddyFile });

const config = runComposeConfig();
const manualConfig = runComposeConfig(["--profile", "manual"]);
const services = config.services ?? {};
const manualServices = manualConfig.services ?? {};
const networks = config.networks ?? {};
const caddy = services[publicEdgeService];

assert(caddy, "Caddy must be present in production compose.");
assert(networks["production-internal"]?.internal === true, "Production internal network must be internal.", {
  networks,
});
assert(networks["production-internal"]?.name === "lottery-production-internal", "Production internal network must use the expected name.", {
  networks,
});
assert(networks["production-edge"], "Production edge network must be present.", { networks });
assert(networks["production-edge"]?.name === "lottery-production-edge", "Production edge network must use the expected name.", {
  networks,
});

for (const [name, service] of Object.entries(services)) {
  assertHardenedContainer(name, service, { expectNonRoot: name !== publicEdgeService });

  const ports = service.ports ?? [];
  if (name === publicEdgeService) {
    const publishedPorts = ports.map((port) => String(port.published)).sort();
    assert(
      publishedPorts.length === 2 && publishedPorts.includes("80") && publishedPorts.includes("443"),
      "Only Caddy may publish HTTP/HTTPS ports.",
      { ports }
    );
    assert(service.cap_add?.includes("NET_BIND_SERVICE"), "Caddy must declare the low-port binding exception.", {
      cap_add: service.cap_add,
    });
    assert(serviceNetworks(service).includes("production-edge"), "Caddy must join the edge network.", {
      networks: service.networks,
    });
    assert(serviceNetworks(service).includes("production-internal"), "Caddy must join the internal network.", {
      networks: service.networks,
    });
    continue;
  }

  assert(ports.length === 0, `${name} must not publish public ports.`, { ports });
  assert(serviceNetworks(service).includes("production-internal"), `${name} must join the internal network.`, {
    networks: service.networks,
  });
  assert(!serviceNetworks(service).includes("production-edge"), `${name} must not join the edge network.`, {
    networks: service.networks,
  });
}

for (const serviceName of internalApplicationServices) {
  assert(services[serviceName], `${serviceName} must be present in the default production stack.`);
  assert(services[serviceName].expose?.length > 0 || serviceName.startsWith("worker-") || serviceName === "outbox-dispatcher", `${serviceName} must use internal exposure only.`, {
    expose: services[serviceName].expose,
  });
}

assert(manualServices["migration-runner"], "Manual migration runner must be present in the manual profile.");
assertHardenedContainer("migration-runner", manualServices["migration-runner"]);
assert(
  manualServices["migration-runner"].tmpfs?.some((entry) => String(entry).startsWith("/app/.qa")),
  "Migration runner must use tmpfs for evidence output on a read-only root filesystem.",
  { tmpfs: manualServices["migration-runner"].tmpfs }
);

const composeText = readFileSync(productionComposeFile, "utf8");
assert(!composeText.includes("network_mode: host"), "Production compose must not use host networking.");
assert(!composeText.includes("privileged: true"), "Production compose must not declare privileged containers.");

const caddyText = readFileSync(caddyFile, "utf8");
for (const requiredCaddyDirective of [
  "Strict-Transport-Security",
  "Content-Security-Policy",
  "Permissions-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "request_body",
  "max_size 10MB",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "X-Request-ID",
  "CF-Connecting-IP",
  "reverse_proxy app:3000",
]) {
  assert(caddyText.includes(requiredCaddyDirective), `Caddyfile must include ${requiredCaddyDirective}.`);
}

let braceDepth = 0;
for (const char of caddyText) {
  if (char === "{") braceDepth += 1;
  if (char === "}") braceDepth -= 1;
  assert(braceDepth >= 0, "Caddyfile braces must be balanced.");
}
assert(braceDepth === 0, "Caddyfile braces must be balanced.");

for (const dockerfile of dockerfiles) {
  assert(existsSync(dockerfile), `${dockerfile} is missing.`);
  const dockerfileText = readFileSync(dockerfile, "utf8");
  assert(!/FROM\s+\S+:latest\b/i.test(dockerfileText), `${dockerfile} must not use latest base images.`);
}

const appDockerfile = readFileSync("Dockerfile", "utf8");
assert(appDockerfile.includes("USER node"), "App runtime image must declare the non-root node user.");

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    noPrivilegedContainers: "PASS",
    noDockerSocketMounts: "PASS",
    onlyCaddyPublishesPorts: "PASS",
    internalServicesNotOnEdgeNetwork: "PASS",
    nonRootWhereExpected: "PASS",
    readOnlyFilesystemConfigured: "PASS",
    tmpfsWritablePathsConfigured: "PASS",
    capabilitiesDropped: "PASS",
    resourceLimitsConfigured: "PASS",
    caddySecurityHeadersConfigured: "PASS",
    caddyRequestLimitConfigured: "PASS",
    caddyConfigStaticallyValidated: "PASS",
    noLatestBaseImages: "PASS",
  },
}, null, 2));
