import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const campaignId = "csprng-1.2b-20260816T185106Z-7eda4e0";
const image = "mosera/csprng-external-batteries@sha256:f3422c599d851ea93444d23a40b11466d75968052bea96eff37a8e57b66d5d81";
const qualifiedHash = "0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46";
const [battery, ...rawArgs] = process.argv.slice(2);
const flags = parseFlags(rawArgs);

if (!["practrand", "dieharder", "nist"].includes(battery)) {
  throw new Error("Usage: external-campaign-runner.mjs {practrand|dieharder|nist} --sample <dir> --execution-id <id> [--max 2GB] [--test 203] [--ntuple 23] [--sequence-bits 1000000] [--sequences 100]");
}

const sampleDirectory = resolve(root, required("sample"));
const executionId = required("execution-id");
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,160}$/.test(executionId)) throw new Error("Unsafe execution identity.");
const samplePath = join(sampleDirectory, "sample.bin");
const manifestPath = join(sampleDirectory, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sample = manifest.manifestPayload;
if (sample.qualifiedImplementationHash !== qualifiedHash) throw new Error("Qualified implementation hash mismatch.");
if (statSync(samplePath).size !== sample.streamSizeBytes) throw new Error("Sample size mismatch.");
if (await sha256File(samplePath) !== sample.rawSampleSha256) throw new Error("Sample hash mismatch.");

const executionDirectory = join(sampleDirectory, "campaign-runs", executionId);
mkdirSync(join(sampleDirectory, "campaign-runs"), { recursive: true });
mkdirSync(executionDirectory, { recursive: false });
const startedAt = new Date();
const stdoutPath = join(executionDirectory, `${battery}.stdout.log`);
const stderrPath = join(executionDirectory, `${battery}.stderr.log`);
const stdoutFd = openSync(stdoutPath, "wx", 0o644);
const stderrFd = openSync(stderrPath, "wx", 0o644);
const invocation = buildInvocation(battery);

writeNew(join(executionDirectory, "execution.initial.json"), {
  schemaVersion: "1.0.0",
  campaignId,
  executionId,
  battery,
  status: "RUNNING",
  startedAtUtc: startedAt.toISOString(),
  sampleId: sample.sampleId,
  sampleSha256: sample.rawSampleSha256,
  sampleBytes: sample.streamSizeBytes,
  qualificationImage: image,
  command: invocation.display,
});

let result;
try {
  result = await run("docker", invocation.args, stdoutFd, stderrFd);
} finally {
  closeSync(stdoutFd);
  closeSync(stderrFd);
}

const completedAt = new Date();
const artifacts = [];
for (const name of readdirSync(executionDirectory).sort()) {
  if (name.startsWith("execution.")) continue;
  const path = join(executionDirectory, name);
  if (!statSync(path).isFile()) continue;
  artifacts.push({ name, bytes: statSync(path).size, sha256: await sha256File(path) });
}
const executionPayload = {
  schemaVersion: "1.0.0",
  campaignId,
  executionId,
  battery,
  status: result.status === 0 ? "COMPLETED" : "FAILED_PRESERVED",
  startedAtUtc: startedAt.toISOString(),
  completedAtUtc: completedAt.toISOString(),
  durationMs: completedAt.getTime() - startedAt.getTime(),
  sampleId: sample.sampleId,
  sampleSha256: sample.rawSampleSha256,
  sampleBytes: sample.streamSizeBytes,
  qualificationImage: image,
  command: invocation.display,
  exitStatus: result.status,
  signal: result.signal,
  artifacts,
};
const payloadJson = JSON.stringify(executionPayload);
const execution = {
  executionPayload,
  executionPayloadSha256: sha256(Buffer.from(payloadJson)),
};
const executionPath = join(executionDirectory, "execution.json");
writeNew(executionPath, execution);
writeFileSync(
  join(executionDirectory, "execution.json.sha256"),
  `${await sha256File(executionPath)}  execution.json\n`,
  { flag: "wx", mode: 0o644 },
);
for (const name of readdirSync(executionDirectory)) chmodSync(join(executionDirectory, name), 0o444);
console.log(JSON.stringify({ executionDirectory, ...executionPayload }, null, 2));
if (result.status !== 0) process.exitCode = result.status ?? 1;

function buildInvocation(selectedBattery) {
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : "65534:65534";
  const common = [
    "run", "--rm", "--network", "none", "--user", uid,
    "--mount", `type=bind,src=${samplePath},dst=/input/sample.bin,readonly`,
    "--mount", `type=bind,src=${executionDirectory},dst=/output`,
  ];
  if (selectedBattery === "practrand") {
    const max = flags.max ?? "2GB";
    if (!/^\d+(MB|GB)$/.test(max)) throw new Error("PractRand max must use MB or GB units.");
    const inner = `RNG_test stdin -tlmin 256MB -tlmax ${max} < /input/sample.bin`;
    return { display: `docker run --network none ${image} /bin/sh -c '${inner}'`, args: [...common, "--entrypoint", "/bin/sh", image, "-c", inner] };
  }
  if (selectedBattery === "dieharder") {
    const test = flags.test;
    if (test !== undefined && !/^\d{1,3}$/.test(test)) throw new Error("dieharder test must be a numeric test identifier.");
    const ntuple = flags.ntuple;
    if (ntuple !== undefined && !/^\d{1,3}$/.test(ntuple)) throw new Error("dieharder ntuple must be numeric.");
    const selection = test === undefined ? ["-a"] : ["-d", test];
    const testParameters = ntuple === undefined ? [] : ["-n", ntuple];
    const command = `dieharder ${selection.join(" ")} ${testParameters.join(" ")} -g 201 -f /input/sample.bin`.replace("  ", " ");
    return { display: `docker run --network none ${image} ${command}`, args: [...common, "--entrypoint", "/usr/bin/dieharder", image, ...selection, ...testParameters, "-g", "201", "-f", "/input/sample.bin"] };
  }
  const bits = Number(flags["sequence-bits"] ?? 1_000_000);
  const sequences = Number(flags.sequences ?? 100);
  if (!Number.isSafeInteger(bits) || bits < 1_000_000) throw new Error("NIST sequence length is invalid.");
  if (!Number.isSafeInteger(sequences) || sequences < 55) throw new Error("NIST requires at least 55 sequences for second-level analysis.");
  if (sample.streamSizeBits < bits * sequences) throw new Error("Sample is too small for the requested NIST geometry.");
  const inner = [
    "set -eu",
    "work=$(mktemp -d /tmp/nist-sts.XXXXXX)",
    "cp -R /opt/nist-sts/. \"$work/\"",
    "chmod -R u+w \"$work\"",
    "cd \"$work\"",
    `set +e; printf '0\\n/input/sample.bin\\n1\\n0\\n${sequences}\\n1\\n' | ./assess ${bits}; assess_status=$?; set -e`,
    "test -s experiments/AlgorithmTesting/finalAnalysisReport.txt",
    "cp experiments/AlgorithmTesting/finalAnalysisReport.txt /output/finalAnalysisReport.txt",
    "tar -czf /output/nist-sts-output.tar.gz experiments/AlgorithmTesting",
    "echo nist_reference_assess_status=$assess_status",
  ].join("; ");
  return { display: `docker run --network none ${image} /bin/sh -c <NIST all-tests ${bits}x${sequences}>`, args: [...common, "--entrypoint", "/bin/sh", image, "-c", inner] };
}

function parseFlags(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith("--") || values[index + 1] === undefined) throw new Error(`Invalid argument ${values[index] ?? ""}.`);
    parsed[values[index].slice(2)] = values[index + 1];
  }
  return parsed;
}

function required(name) {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function run(file, args, stdout, stderr) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: ["ignore", stdout, stderr] });
    child.once("error", reject);
    child.once("close", (status, signal) => resolveRun({ status, signal }));
  });
}

function writeNew(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
