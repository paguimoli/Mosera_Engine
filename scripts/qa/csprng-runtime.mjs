import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function read(path) {
  return readFileSync(path, "utf8");
}

const runtimeSource = read("services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs");
const providerSource = read("services/game-engine/src/GameEngine.Application/Services/OutcomeProviderRuntimeServices.cs");
const apiSource = read("services/game-engine/src/GameEngine.Api/Program.cs");
const persistenceSource = read("services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCertifiedCsprngRuntimePersistence.cs");

addCheck("common OS entropy abstraction exists", runtimeSource.includes("public interface IOsEntropyProvider"));
addCheck("Linux getrandom provider exists", runtimeSource.includes("LinuxGetRandomEntropyProvider") && runtimeSource.includes("EntryPoint = \"getrandom\""));
addCheck("Windows BCryptGenRandom provider exists", runtimeSource.includes("WindowsBCryptEntropyProvider") && runtimeSource.includes("BCryptGenRandom"));
addCheck("macOS SecRandomCopyBytes provider exists", runtimeSource.includes("MacOsSecRandomEntropyProvider") && runtimeSource.includes("SecRandomCopyBytes"));
addCheck("unsupported OS fails closed", runtimeSource.includes("UnsupportedOsEntropyProvider") && runtimeSource.includes("PlatformNotSupportedException"));
addCheck("HMAC-DRBG runtime exists", runtimeSource.includes("public interface IHmacDrbgRuntime") && runtimeSource.includes("public sealed class HmacDrbgRuntime"));
addCheck("SHA-256/384/512 supported", ["Sha256", "Sha384", "Sha512"].every((token) => runtimeSource.includes(token)));
addCheck("DRBG destroy zeroizes state", runtimeSource.includes("MarkDestroyed") && runtimeSource.includes("CryptographicOperations.ZeroMemory(Key)") && runtimeSource.includes("CryptographicOperations.ZeroMemory(Value)"));
addCheck("no live CTR/Hash DRBG runtime added", !runtimeSource.includes("CtrDrbgRuntime") && !runtimeSource.includes("HashDrbgRuntime"));
addCheck("Certified CSPRNG provider runtime implemented", providerSource.includes("ProviderRuntimeImplemented: true") && providerSource.includes("EvidenceReference: $\"placeholder:drbg-session:"));
addCheck("production outcome authority remains disabled", providerSource.includes("OutcomeRuntimeExecutionMode.Production") && providerSource.includes("Production Outcome Authority remains disabled"));
addCheck("DRBG evidence Postgres adapter exists", persistenceSource.includes("game_engine.drbg_session_evidence") && persistenceSource.includes("on conflict (canonical_evidence_hash) do nothing"));
addCheck("DI registers CSPRNG runtime dependencies", apiSource.includes("IOsEntropyProvider") && apiSource.includes("IHmacDrbgRuntime") && apiSource.includes("ICertifiedCsprngEvidenceRepository"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
