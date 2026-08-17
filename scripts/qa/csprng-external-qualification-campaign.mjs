import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const campaignId = "csprng-1.2b-20260816T185106Z-7eda4e0";
const evidenceRoot = join(root, ".qa/csprng-1.2b", campaignId);
const samplesRoot = join(evidenceRoot, "samples");
const qualifiedHash = "0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46";
const requiredExecutions = new Set([
  "practrand-stream-01-2gib-001",
  "practrand-stream-02-1gib-001",
  "practrand-stream-03-1gib-001",
  "practrand-stream-04-512mib-001",
  "dieharder-stream-01-full-001",
  "dieharder-stream-02-full-001",
  "dieharder-stream-03-full-001",
  "nist-stream-03-100x1m-all-002",
  "nist-stream-04-100x1m-all-002",
  "dieharder-stream-05-lagged-sum-23-no-rewind-001",
  "dieharder-stream-05-lagged-sum-31-no-rewind-001",
  "dieharder-stream-05-gcd-no-rewind-001",
]);

assert(existsSync(evidenceRoot), "Campaign evidence root is missing.");
const campaign = json(join(root, "docs/qa/csprng-1.2b-campaign-metadata.json"));
assert(campaign.campaignId === campaignId, "Campaign metadata identity mismatch.");
assert(campaign.qualifiedImplementation.sourceSha256 === qualifiedHash, "Campaign qualified hash mismatch.");
for (let index = 1; index <= 9; index += 1) {
  const suffix = String(index).padStart(3, "0");
  const amendment = json(join(root, `docs/qa/csprng-1.2b-environment-amendment-${suffix}.json`));
  assert(amendment.campaignId === campaignId, `Campaign amendment ${suffix} identity mismatch.`);
}

const sampleIds = new Set();
const sampleHashes = new Set();
const executionIds = new Set();
const completedExecutions = new Set();
const executionDirectories = new Map();
let aggregateBytes = 0;
let executionCount = 0;
for (const sampleDirectoryName of readdirSync(samplesRoot).filter((name) => !name.startsWith(".")).sort()) {
  const sampleDirectory = join(samplesRoot, sampleDirectoryName);
  if (!statSync(sampleDirectory).isDirectory()) continue;
  const manifestPath = join(sampleDirectory, "manifest.json");
  assert(existsSync(manifestPath), `Completed manifest missing for ${sampleDirectoryName}.`);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const payload = manifest.manifestPayload;
  assert(payload.sampleId === sampleDirectoryName, `Sample directory identity mismatch for ${sampleDirectoryName}.`);
  assert(!sampleIds.has(payload.sampleId), `Duplicate sample ID ${payload.sampleId}.`);
  assert(!sampleHashes.has(payload.rawSampleSha256), `Duplicate raw sample hash ${payload.rawSampleSha256}.`);
  sampleIds.add(payload.sampleId);
  sampleHashes.add(payload.rawSampleSha256);
  assert(payload.qualifiedImplementationHash === qualifiedHash, `Qualified hash mismatch for ${payload.sampleId}.`);
  const samplePath = join(sampleDirectory, "sample.bin");
  assert(statSync(samplePath).size === payload.streamSizeBytes, `Sample size mismatch for ${payload.sampleId}.`);
  assert(await sha256File(samplePath) === payload.rawSampleSha256, `Sample hash mismatch for ${payload.sampleId}.`);
  assert(sha256(Buffer.from(JSON.stringify(payload))) === manifest.manifestPayloadSha256, `Manifest payload hash mismatch for ${payload.sampleId}.`);
  assert(sidecarHash(join(sampleDirectory, "manifest.json.sha256")) === sha256(manifestBytes), `Manifest sidecar mismatch for ${payload.sampleId}.`);
  aggregateBytes += payload.streamSizeBytes + manifestBytes.length;

  const runsRoot = join(sampleDirectory, "campaign-runs");
  if (!existsSync(runsRoot)) continue;
  for (const executionDirectoryName of readdirSync(runsRoot).sort()) {
    const executionDirectory = join(runsRoot, executionDirectoryName);
    if (!statSync(executionDirectory).isDirectory()) continue;
    assert(!executionIds.has(executionDirectoryName), `Duplicate execution ID ${executionDirectoryName}.`);
    executionIds.add(executionDirectoryName);
    executionDirectories.set(executionDirectoryName, executionDirectory);
    executionCount += 1;
    const executionPath = join(executionDirectory, "execution.json");
    const interruptionPath = join(executionDirectory, "execution.interruption.json");
    assert(existsSync(executionPath) || existsSync(interruptionPath), `Final or interruption evidence missing for ${executionDirectoryName}.`);
    if (existsSync(executionPath)) {
      const executionBytes = readFileSync(executionPath);
      const execution = JSON.parse(executionBytes);
      const executionPayload = execution.executionPayload;
      assert(executionPayload.executionId === executionDirectoryName, `Execution identity mismatch for ${executionDirectoryName}.`);
      assert(executionPayload.campaignId === campaignId, `Campaign identity mismatch for ${executionDirectoryName}.`);
      assert(executionPayload.sampleId === payload.sampleId, `Sample identity mismatch for ${executionDirectoryName}.`);
      assert(executionPayload.sampleSha256 === payload.rawSampleSha256, `Sample hash mismatch for ${executionDirectoryName}.`);
      assert(sha256(Buffer.from(JSON.stringify(executionPayload))) === execution.executionPayloadSha256, `Execution payload hash mismatch for ${executionDirectoryName}.`);
      assert(sidecarHash(join(executionDirectory, "execution.json.sha256")) === sha256(executionBytes), `Execution sidecar mismatch for ${executionDirectoryName}.`);
      for (const artifact of executionPayload.artifacts) {
        const artifactPath = join(executionDirectory, artifact.name);
        assert(statSync(artifactPath).size === artifact.bytes, `Artifact size mismatch for ${executionDirectoryName}/${artifact.name}.`);
        assert(await sha256File(artifactPath) === artifact.sha256, `Artifact hash mismatch for ${executionDirectoryName}/${artifact.name}.`);
        aggregateBytes += artifact.bytes;
      }
      if (executionPayload.status === "COMPLETED") completedExecutions.add(executionDirectoryName);
    } else {
      const interruption = json(interruptionPath);
      assert(interruption.campaignId === campaignId, `Interrupted campaign identity mismatch for ${executionDirectoryName}.`);
      assert(interruption.executionId === executionDirectoryName, `Interrupted execution identity mismatch for ${executionDirectoryName}.`);
      for (const artifact of interruption.artifacts) {
        const artifactPath = join(executionDirectory, artifact.name);
        assert(statSync(artifactPath).size === artifact.bytes, `Interrupted artifact size mismatch for ${executionDirectoryName}/${artifact.name}.`);
        assert(await sha256File(artifactPath) === artifact.sha256, `Interrupted artifact hash mismatch for ${executionDirectoryName}/${artifact.name}.`);
        aggregateBytes += artifact.bytes;
      }
    }
  }
}

assert(sampleIds.size >= 5, "The campaign must preserve at least five independent streams including the no-rewind investigation.");
for (const executionId of requiredExecutions) assert(completedExecutions.has(executionId), `Required execution ${executionId} is not completed.`);

for (const executionId of [
  "practrand-stream-01-2gib-001",
  "practrand-stream-02-1gib-001",
  "practrand-stream-03-1gib-001",
  "practrand-stream-04-512mib-001",
]) {
  const output = readFileSync(join(executionDirectories.get(executionId), "practrand.stdout.log"), "utf8");
  assert(output.includes("no anomalies"), `${executionId} does not report a no-anomaly checkpoint.`);
  assert(!/FAIL|suspicious|unusual/i.test(output), `${executionId} contains an unresolved PractRand anomaly.`);
}

for (const executionId of ["dieharder-stream-01-full-001", "dieharder-stream-02-full-001", "dieharder-stream-03-full-001"]) {
  const output = readFileSync(join(executionDirectories.get(executionId), "dieharder.stdout.log"), "utf8");
  assert((output.match(/PASSED|WEAK|FAILED/g) ?? []).length === 114, `${executionId} does not contain 114 full-battery assessments.`);
  assert(!output.includes("FAILED"), `${executionId} contains an unresolved full-battery failure.`);
}

const noRewindExpectations = new Map([
  ["dieharder-stream-05-lagged-sum-23-no-rewind-001", "0.51120759"],
  ["dieharder-stream-05-lagged-sum-31-no-rewind-001", "0.71402512"],
  ["dieharder-stream-05-gcd-no-rewind-001", "0.93311253"],
]);
for (const [executionId, expectedPValue] of noRewindExpectations) {
  const directory = executionDirectories.get(executionId);
  const output = readFileSync(join(directory, "dieharder.stdout.log"), "utf8");
  assert(output.includes(expectedPValue) && !/WEAK|FAILED/.test(output), `${executionId} does not preserve its accepted no-rewind result.`);
  assert(statSync(join(directory, "dieharder.stderr.log")).size === 0, `${executionId} rewound input or emitted stderr.`);
}

const nistResults = new Map();
for (const executionId of ["nist-stream-03-100x1m-all-002", "nist-stream-04-100x1m-all-002"]) {
  const report = readFileSync(join(executionDirectories.get(executionId), "finalAnalysisReport.txt"), "utf8");
  const rows = report.split("\n").map((line) => line.trim().split(/\s+/)).filter((columns) => /^\d+\.\d+$/.test(columns[10] ?? "") && /^\d+\/\d+$/.test(columns[11] ?? ""));
  assert(rows.length === 188, `${executionId} does not contain 188 second-level rows.`);
  const familyOrdinals = new Map();
  const interpreted = [];
  for (const columns of rows) {
    const uniformityP = Number(columns[10]);
    const [passed, applicable] = columns[11].split("/").map(Number);
    const minimum = Math.floor(applicable * 0.99 - 3 * Math.sqrt(applicable * 0.99 * 0.01));
    const test = columns.at(-1);
    const familyOrdinal = (familyOrdinals.get(test) ?? 0) + 1;
    familyOrdinals.set(test, familyOrdinal);
    assert(uniformityP >= 0.0001, `${executionId} has a second-level uniformity failure.`);
    interpreted.push({ test, familyOrdinal, passed, applicable, minimum, uniformityP });
  }
  nistResults.set(executionId, interpreted);
}
const stream3ProportionFailures = nistResults.get("nist-stream-03-100x1m-all-002").filter((row) => row.passed < row.minimum);
assert(
  JSON.stringify(stream3ProportionFailures.map((row) => [row.test, row.familyOrdinal, row.passed, row.applicable])) ===
    JSON.stringify([["NonOverlappingTemplate", 49, 95, 100], ["NonOverlappingTemplate", 122, 95, 100]]),
  "Stream 03 NIST proportion anomalies do not match the disclosed register.",
);
const stream4Rows = nistResults.get("nist-stream-04-100x1m-all-002");
assert(stream4Rows.every((row) => row.passed >= row.minimum), "Stream 04 has an unresolved NIST pass-proportion failure.");
for (const failure of stream3ProportionFailures) {
  const independentRow = stream4Rows.find((row) => row.test === failure.test && row.familyOrdinal === failure.familyOrdinal);
  assert(independentRow?.passed >= independentRow?.minimum, `NIST ${failure.test} ${failure.familyOrdinal} recurred on independent stream 04.`);
}

const anomalyRegister = json(join(root, "docs/qa/csprng-1.2b-anomaly-register.json"));
assert(anomalyRegister.campaignId === campaignId, "Anomaly register campaign identity mismatch.");
assert(anomalyRegister.anomalies.length === 22, "Anomaly register entry count mismatch.");
for (const anomaly of anomalyRegister.anomalies) {
  assert(executionIds.has(anomaly.executionId), `Anomaly ${anomaly.anomalyId} references an unknown execution.`);
  assert(sampleIds.has(anomaly.sampleId), `Anomaly ${anomaly.anomalyId} references an unknown sample.`);
  assert(sampleHashes.has(anomaly.sampleSha256), `Anomaly ${anomaly.anomalyId} references an unknown sample hash.`);
}

const inventory = json(join(root, "docs/qa/csprng-1.2b-evidence-inventory.json"));
assert(inventory.campaignId === campaignId, "Evidence inventory campaign identity mismatch.");
assert(inventory.sampleCount === sampleIds.size, "Evidence inventory sample count mismatch.");
assert(inventory.executionCount === executionCount, "Evidence inventory execution count mismatch.");
assert(inventory.localEvidenceBytes === directoryBytes(evidenceRoot), "Evidence inventory aggregate size mismatch.");

console.log(`[csprng-external-qualification-campaign] PASS campaign=${campaignId} samples=${sampleIds.size} executions=${executionCount} verifiedArtifactBytes=${aggregateBytes} localEvidenceBytes=${inventory.localEvidenceBytes}`);

function json(path) {
  assert(existsSync(path), `Required JSON evidence missing: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(entryPath) : statSync(entryPath).size;
  }
  return total;
}

function sidecarHash(path) {
  return readFileSync(path, "utf8").trim().split(/\s+/)[0];
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
