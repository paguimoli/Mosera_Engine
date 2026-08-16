import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const image = "mosera/csprng-external-batteries:1.2a";
const dockerfileDirectory = join(root, "scripts/qualification/csprng/external-batteries");
const generatorProject = join(
  root,
  "services/game-engine/tests/GameEngine.CsprngExternalSampleGenerator/GameEngine.CsprngExternalSampleGenerator.csproj",
);
const generatorAssembly = join(
  root,
  "services/game-engine/tests/GameEngine.CsprngExternalSampleGenerator/bin/Release/net10.0/GameEngine.CsprngExternalSampleGenerator.dll",
);
const defaultEvidenceRoot = join(root, ".qa/csprng-1.2a/evidence");
const qualifiedHash = "0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46";
const classification = "NON_QUALIFICATION_SMOKE_TEST";

const [command = "help", ...argv] = process.argv.slice(2);
const flags = parseFlags(argv);

switch (command) {
  case "build":
    buildContainer();
    break;
  case "generate":
    generateSample(flags);
    break;
  case "verify":
    verifySample(requiredSample(flags));
    break;
  case "show":
    process.stdout.write(readFileSync(join(requiredSample(flags), "manifest.json"), "utf8"));
    break;
  case "inventory":
    runChecked("docker", ["run", "--rm", image, "inventory"], { stdio: "inherit" });
    break;
  case "smoke":
    smoke(flags);
    break;
  default:
    console.log(`Usage:
  npm run csprng:external:build
  npm run csprng:external:generate -- --sample-id <id> --bytes <count> [--output-root <path>]
  npm run csprng:external:verify -- --sample <sample-directory>
  npm run csprng:external:show -- --sample <sample-directory>
  npm run csprng:external:inventory
  npm run csprng:external:smoke [-- --sample <sample-directory>]`);
    if (command !== "help") process.exitCode = 64;
}

function buildContainer() {
  runChecked("docker", ["build", "--pull=false", "--tag", image, dockerfileDirectory], { stdio: "inherit" });
}

function generateSample(options) {
  const sampleId = options["sample-id"] ?? freshId("sample");
  const outputRoot = resolve(root, options["output-root"] ?? defaultEvidenceRoot);
  const bytes = options.bytes ?? String(1024 * 1024);
  mkdirSync(outputRoot, { recursive: true });
  runChecked(
    "dotnet",
    ["build", generatorProject, "--configuration", "Release", "--no-restore", "--disable-build-servers", "-m:1", "/nr:false", "--verbosity:quiet"],
    { cwd: root, stdio: "inherit" },
  );
  runChecked(
    "dotnet",
    [
      generatorAssembly,
      "--sample-id", sampleId,
      "--output-root", outputRoot,
      "--bytes", bytes,
      "--suites", "PractRand,dieharder,NIST_SP_800_22_STS",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const sampleDirectory = join(outputRoot, sampleId);
  verifySample(sampleDirectory);
  console.log(sampleDirectory);
  return sampleDirectory;
}

function verifySample(sampleDirectory) {
  const manifestPath = join(sampleDirectory, "manifest.json");
  const samplePath = join(sampleDirectory, "sample.bin");
  const sidecarPath = join(sampleDirectory, "manifest.json.sha256");
  for (const path of [manifestPath, samplePath, sidecarPath]) {
    if (!existsSync(path)) throw new Error(`Required evidence file is missing: ${path}`);
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const payload = manifest.manifestPayload;
  assert(payload.status === "COMPLETED", "Sample manifest is not completed.");
  assert(payload.qualifiedImplementationHash === qualifiedHash, "Qualified implementation hash changed.");
  assert(statSync(samplePath).size === payload.streamSizeBytes, "Raw sample byte count does not match manifest.");
  assert(sha256(readFileSync(samplePath)) === payload.rawSampleSha256, "Raw sample SHA-256 does not match manifest.");
  assert(sha256(Buffer.from(JSON.stringify(payload))) === manifest.manifestPayloadSha256, "Manifest payload SHA-256 is invalid.");
  const sidecar = readFileSync(sidecarPath, "utf8").trim().split(/\s+/)[0];
  assert(sha256(manifestBytes) === sidecar, "Manifest file SHA-256 sidecar is invalid.");
  console.log(`[csprng-external] verified ${payload.sampleId} (${payload.streamSizeBytes} bytes)`);
  return manifest;
}

function smoke(options) {
  let sampleDirectory = options.sample ? resolve(root, options.sample) : null;
  if (!sampleDirectory) sampleDirectory = generateSample({ bytes: String(1024 * 1024) });
  const manifest = verifySample(sampleDirectory);
  if (manifest.manifestPayload.streamSizeBytes < 125000) {
    throw new Error("NIST STS smoke requires at least one 1,000,000-bit sequence.");
  }

  const runId = freshId("smoke");
  const runsDirectory = join(sampleDirectory, "runs");
  mkdirSync(runsDirectory, { recursive: true });
  const runDirectory = join(runsDirectory, runId);
  mkdirSync(runDirectory, { recursive: false });
  const samplePath = join(sampleDirectory, "sample.bin");
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : "65534:65534";
  const mountArgs = [
    "run", "--rm", "--network", "none", "--user", uid,
    "--mount", `type=bind,src=${samplePath},dst=/input/sample.bin,readonly`,
    "--mount", `type=bind,src=${runDirectory},dst=/output`,
    image,
  ];
  const tools = [
    ["inventory", ["inventory"]],
    ["practrand", ["practrand", "/input/sample.bin", "1MB"]],
    ["dieharder", ["dieharder", "/input/sample.bin"]],
    ["nist-sts", ["nist", "/input/sample.bin", "/output", "1000000", "1"]],
  ];
  const results = [];
  for (const [name, toolArgs] of tools) {
    const result = spawnSync("docker", [...mountArgs, ...toolArgs], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    const stdoutPath = join(runDirectory, `${name}.stdout.log`);
    const stderrPath = join(runDirectory, `${name}.stderr.log`);
    writeNew(stdoutPath, result.stdout ?? "");
    writeNew(stderrPath, result.stderr ?? "");
    chmodSync(stdoutPath, 0o444);
    chmodSync(stderrPath, 0o444);
    results.push({
      tool: name,
      command: ["docker", ...mountArgs, ...toolArgs].join(" "),
      exitCode: result.status,
      acceptedInput: result.status === 0,
      stdoutSha256: sha256(Buffer.from(result.stdout ?? "")),
      stderrSha256: sha256(Buffer.from(result.stderr ?? "")),
    });
  }

  const executionPayload = {
    schemaVersion: "1.0.0",
    qualificationPackageId: "CSPRNG-1.2A",
    classification,
    runId,
    sampleId: manifest.manifestPayload.sampleId,
    sampleSha256: manifest.manifestPayload.rawSampleSha256,
    qualifiedImplementationHash: qualifiedHash,
    sourceGitCommitSha: git(["rev-parse", "HEAD"]).trim(),
    executedAtUtc: new Date().toISOString(),
    batteryImage: image,
    generatorDotnet: runChecked("dotnet", ["--version"], { encoding: "utf8" }).stdout.trim(),
    results,
    interpretation: "Infrastructure acceptance only; statistical results are not qualification evidence.",
    failurePreservation: "All outputs are retained. Follow-up runs require a new immutable run identity.",
    status: results.every((result) => result.acceptedInput) ? "COMPLETED" : "FAILED_PRESERVED",
  };
  const execution = {
    executionPayload,
    executionPayloadSha256: sha256(Buffer.from(JSON.stringify(executionPayload))),
  };
  const executionPath = join(runDirectory, "execution.json");
  writeNew(executionPath, `${JSON.stringify(execution, null, 2)}\n`);
  writeNew(join(runDirectory, "execution.json.sha256"), `${sha256(readFileSync(executionPath))}  execution.json\n`);
  for (const path of [executionPath, join(runDirectory, "execution.json.sha256")]) chmodSync(path, 0o444);
  const nistArchive = join(runDirectory, "nist-sts-output.tar.gz");
  if (existsSync(nistArchive)) chmodSync(nistArchive, 0o444);
  if (executionPayload.status !== "COMPLETED") {
    const failed = results.filter((result) => !result.acceptedInput).map((result) => result.tool).join(", ");
    throw new Error(`External battery smoke failed and evidence was preserved: ${failed}`);
  }
  console.log(`${classification}: ${runDirectory}`);
}

function requiredSample(options) {
  if (!options.sample) throw new Error("--sample <sample-directory> is required.");
  return resolve(root, options.sample);
}

function parseFlags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] === undefined) throw new Error(`Invalid argument: ${key ?? ""}`);
    result[key.slice(2)] = values[index + 1];
  }
  return result;
}

function freshId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(6).toString("hex")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args) {
  return runChecked("git", args, { cwd: root, encoding: "utf8" }).stdout;
}

function writeNew(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

function runChecked(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, ...options });
  if (result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed with status ${result.status}.`);
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
