import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function read(path) {
  return readFileSync(path, "utf8");
}

const runtimeSource = read("services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs");
const testSource = read("services/game-engine/tests/GameEngine.Application.Tests/Program.cs");

addCheck("sampler abstraction exists", runtimeSource.includes("public interface ICertifiedCsprngSampler"));
addCheck("rejection threshold sampling implemented", runtimeSource.includes("threshold = (0UL - exclusiveUpperBound) % exclusiveUpperBound") && runtimeSource.includes("value >= threshold"));
addCheck("bounded integer uses DRBG bytes", runtimeSource.includes("drbgRuntime.Generate(session, sizeof(ulong))"));
addCheck("Fisher-Yates implemented", runtimeSource.includes("FisherYatesShuffle") && runtimeSource.includes("(copy[i], copy[j]) = (copy[j], copy[i])"));
addCheck("unique-number selection implemented", runtimeSource.includes("UniqueNumbers") && runtimeSource.includes("count > rangeSize"));
addCheck("weighted selection uses integer weights", runtimeSource.includes("IReadOnlyDictionary<string, long> weights") && runtimeSource.includes("Weighted selection requires positive integer weights"));
addCheck("floating-point threshold sampling absent", !runtimeSource.includes("double") && !runtimeSource.includes("float"));
addCheck("sampling behavior covered by tests", testSource.includes("Rejection-sampled bounded integer") && testSource.includes("Fisher-Yates shuffle") && testSource.includes("Unique-number selection") && testSource.includes("Integer/rational weighted selection"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
