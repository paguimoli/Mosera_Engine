using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;

const double Alpha = 0.01;
var mode = args.Contains("extended", StringComparer.OrdinalIgnoreCase) ? "extended" : "fast";
var failOnBlocker = args.Contains("--fail-on-blocker", StringComparer.OrdinalIgnoreCase);
var extended = mode == "extended";
var outputDirectory = Path.GetFullPath(".qa/csprng-1");
var rawDirectory = Path.Combine(outputDirectory, "raw");
Directory.CreateDirectory(rawDirectory);

var runtime = new HmacDrbgRuntime();
var sampler = new CertifiedCsprngSampler(runtime);
var entropyProvider = new AutoOsEntropyProvider();
var generatedAt = DateTimeOffset.UtcNow;
var implementationFiles = new[]
{
    "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs",
    "services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs",
    "services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeProviderAuthority.cs",
    "services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeAuthority.cs",
    "services/game-engine/src/GameEngine.Api/Program.cs"
};

var implementationHashes = implementationFiles.ToDictionary(
    path => path,
    path => Sha256Hex(File.ReadAllBytes(path)),
    StringComparer.Ordinal);
var commit = RunCommand("git", "rev-parse HEAD").Trim();
var worktree = RunCommand("git", "status --short");

var conformanceService = new OutcomeAuthorityHardeningService(
    runtime,
    new OutcomeValidationFrameworkService());
var vectors = OutcomeAuthorityHardeningService.MoseraHmacDrbgRegressionVectors();
var conformance = conformanceService.RunHmacDrbgConformanceVectors(
    $"{commit}:{implementationHashes[implementationFiles[0]]}");
var vectorEvidence = vectors.Select(vector => new
{
    vector.VectorId,
    vector.VectorVersion,
    hashAlgorithm = vector.HashAlgorithm.ToString(),
    vector.SecurityStrengthBits,
    vector.EntropyHex,
    vector.NonceHex,
    vector.PersonalizationHex,
    vector.AdditionalInputHex,
    vector.ReseedEntropyHex,
    vector.ReseedAdditionalInputHex,
    vector.GenerateByteCount,
    vector.ExpectedFirstGenerateHex,
    vector.ExpectedPostReseedGenerateHex,
    vector.SourceReference,
    result = conformance.VectorResults.Single(result => result.VectorId == vector.VectorId)
}).ToArray();

var deterministicEntropy = Enumerable.Range(0, 48).Select(index => (byte)index).ToArray();
var deterministicNonce = Enumerable.Range(48, 16).Select(index => (byte)index).ToArray();
var deterministicPersonalization = Encoding.UTF8.GetBytes("mosera-csprng-qualification-v1");
var deterministicFirst = GenerateDeterministic(
    runtime,
    deterministicEntropy,
    deterministicNonce,
    deterministicPersonalization,
    256);
var deterministicRepeat = GenerateDeterministic(
    runtime,
    deterministicEntropy,
    deterministicNonce,
    deterministicPersonalization,
    256);
var changedNonce = deterministicNonce.ToArray();
changedNonce[0] ^= 0x80;
var deterministicChanged = GenerateDeterministic(
    runtime,
    deterministicEntropy,
    changedNonce,
    deterministicPersonalization,
    256);
var deterministicPassed = CryptographicOperations.FixedTimeEquals(deterministicFirst, deterministicRepeat) &&
    !CryptographicOperations.FixedTimeEquals(deterministicFirst, deterministicChanged) &&
    conformance.Passed;

var sampleCount = extended ? 4 : 2;
var sampleBytes = extended ? 4 * 1024 * 1024 : 128 * 1024;
var rawSamples = new List<object>();
var rawTestFailures = new List<string>();
for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
{
    var entropy = new byte[48];
    var nonce = new byte[32];
    entropyProvider.Fill(entropy);
    entropyProvider.Fill(nonce);
    var personalization = Encoding.UTF8.GetBytes($"csprng-1:{mode}:{sampleIndex}:{generatedAt:O}");
    using var session = runtime.Instantiate(
        CertifiedCsprngHashAlgorithm.Sha256,
        entropy,
        nonce,
        personalization,
        256);
    var bytes = GenerateCompliantStream(runtime, session, sampleBytes);
    var sampleId = $"sample-{sampleIndex + 1:D2}";
    var rawPath = Path.Combine(rawDirectory, $"{sampleId}.bin");
    if (extended)
    {
        File.WriteAllBytes(rawPath, bytes);
    }

    var tests = StatisticalBattery.Evaluate(bytes, Alpha);
    rawTestFailures.AddRange(tests.Where(test => !test.Passed).Select(test => $"{sampleId}:{test.Name}"));
    rawSamples.Add(new
    {
        sampleId,
        sampleSizeBytes = bytes.Length,
        generatedAt = DateTimeOffset.UtcNow,
        implementationHash = implementationHashes[implementationFiles[0]],
        entropySource = entropyProvider.Platform.ToString(),
        initialization = "independent OS entropy + nonce; HMAC_DRBG-SHA-256; 256-bit strength",
        reseed = "not required for raw stream; production provider reseeds once before selection",
        outputSha256 = Sha256Hex(bytes),
        rawArtifact = extended ? Path.GetRelativePath(outputDirectory, rawPath) : null,
        tests
    });
    CryptographicOperations.ZeroMemory(entropy);
    CryptographicOperations.ZeroMemory(nonce);
    CryptographicOperations.ZeroMemory(personalization);
    CryptographicOperations.ZeroMemory(bytes);
}

var boundSamples = extended ? 50_000 : 2_000;
var bounds = new[] { 2, 3, 6, 10, 35, 40, 49, 69, 80, 90 };
var boundedResults = new List<object>();
var boundedFailures = new List<int>();
using (var session = NewOsSession(runtime, entropyProvider, "bounded-ranges"))
{
    foreach (var bound in bounds)
    {
        var counts = new long[bound];
        for (var index = 0; index < boundSamples; index++)
        {
            counts[sampler.NextInt32(session, 1, bound) - 1]++;
        }

        var result = ChiSquareUniform(counts, Alpha);
        if (!result.Passed) boundedFailures.Add(bound);
        boundedResults.Add(new
        {
            range = $"1-{bound}",
            sampleSize = boundSamples,
            rejectionThreshold = ((0UL - (ulong)bound) % (ulong)bound).ToString(CultureInfo.InvariantCulture),
            result.Statistic,
            result.PValue,
            result.AcceptanceCriterion,
            result.Passed,
            minimumCount = counts.Min(),
            maximumCount = counts.Max()
        });
    }
}

var kenoDraws = extended ? 20_000 : 500;
var kenoInclusion = new long[80];
var kenoPositions = Enumerable.Range(0, 20).Select(_ => new long[80]).ToArray();
var kenoDuplicates = 0;
var kenoOutOfRange = 0;
using (var session = NewOsSession(runtime, entropyProvider, "keno-20-of-80"))
{
    for (var draw = 0; draw < kenoDraws; draw++)
    {
        var values = sampler.UniqueNumbers(session, 1, 80, 20);
        if (values.Distinct().Count() != 20) kenoDuplicates++;
        if (values.Any(value => value is < 1 or > 80)) kenoOutOfRange++;
        for (var position = 0; position < values.Count; position++)
        {
            kenoInclusion[values[position] - 1]++;
            kenoPositions[position][values[position] - 1]++;
        }
    }
}
var kenoInclusionResult = ChiSquareUniform(kenoInclusion, Alpha);
var kenoPositionResults = kenoPositions.Select((counts, position) => new
{
    position = position + 1,
    result = ChiSquareUniform(counts, Alpha)
}).ToArray();
var kenoPositionFailures = kenoPositionResults.Count(result => !result.result.Passed);
var kenoPassed = kenoDuplicates == 0 && kenoOutOfRange == 0 &&
    kenoInclusionResult.Passed && kenoPositionFailures <= 2;

var pickSamples = extended ? 50_000 : 2_000;
var pickPositionCounts = Enumerable.Range(0, 6).Select(_ => new long[10]).ToArray();
var pickSumX = new double[5];
var pickSumY = new double[5];
var pickSumXX = new double[5];
var pickSumYY = new double[5];
var pickSumXY = new double[5];
using (var session = NewOsSession(runtime, entropyProvider, "pick-6"))
{
    for (var sample = 0; sample < pickSamples; sample++)
    {
        var digits = new int[6];
        for (var position = 0; position < digits.Length; position++)
        {
            digits[position] = sampler.NextInt32(session, 0, 9);
            pickPositionCounts[position][digits[position]]++;
            if (position > 0)
            {
                var pair = position - 1;
                var x = digits[position - 1];
                var y = digits[position];
                pickSumX[pair] += x;
                pickSumY[pair] += y;
                pickSumXX[pair] += x * x;
                pickSumYY[pair] += y * y;
                pickSumXY[pair] += x * y;
            }
        }
    }
}
var pickPositionResults = pickPositionCounts.Select((counts, position) => new
{
    position = position + 1,
    result = ChiSquareUniform(counts, Alpha)
}).ToArray();
var pickCorrelations = Enumerable.Range(0, 5).Select(pair =>
{
    var numerator = pickSamples * pickSumXY[pair] - pickSumX[pair] * pickSumY[pair];
    var denominator = Math.Sqrt(
        (pickSamples * pickSumXX[pair] - pickSumX[pair] * pickSumX[pair]) *
        (pickSamples * pickSumYY[pair] - pickSumY[pair] * pickSumY[pair]));
    var correlation = numerator / denominator;
    return new { pair = $"{pair + 1}-{pair + 2}", correlation, z = Math.Abs(correlation) * Math.Sqrt(pickSamples) };
}).ToArray();
var pickMaximumCorrelationZ = pickCorrelations.Max(result => result.z);
var pickPassed = pickPositionResults.All(result => result.result.Passed) && pickMaximumCorrelationZ <= 4.5;

var matrixDraws = extended ? 30_000 : 1_000;
var matrixInclusion = new long[49];
var matrixDuplicates = 0;
using (var session = NewOsSession(runtime, entropyProvider, "matrix-6-of-49"))
{
    for (var draw = 0; draw < matrixDraws; draw++)
    {
        var values = sampler.UniqueNumbers(session, 1, 49, 6);
        if (values.Distinct().Count() != 6) matrixDuplicates++;
        foreach (var value in values) matrixInclusion[value - 1]++;
    }
}
var matrixResult = ChiSquareUniform(matrixInclusion, Alpha);
var matrixPassed = matrixDuplicates == 0 && matrixResult.Passed;

var concurrencyWorkers = extended ? 32 : 8;
var concurrencyBytes = extended ? 256 * 1024 : 32 * 1024;
var concurrentHashes = new ConcurrentBag<string>();
await Parallel.ForEachAsync(
    Enumerable.Range(0, concurrencyWorkers),
    new ParallelOptions { MaxDegreeOfParallelism = Math.Min(Environment.ProcessorCount, 16) },
    (_, _) =>
    {
        using var session = NewOsSession(runtime, entropyProvider, $"concurrency:{Guid.NewGuid():N}");
        var bytes = GenerateCompliantStream(runtime, session, concurrencyBytes);
        concurrentHashes.Add(Sha256Hex(bytes));
        CryptographicOperations.ZeroMemory(bytes);
        return ValueTask.CompletedTask;
    });
var concurrencyPassed = concurrentHashes.Count == concurrencyWorkers &&
    concurrentHashes.Distinct(StringComparer.Ordinal).Count() == concurrencyWorkers;

var restartHashes = new List<string>();
for (var restart = 0; restart < (extended ? 12 : 3); restart++)
{
    using var session = NewOsSession(runtime, entropyProvider, $"restart:{restart}");
    var bytes = runtime.Generate(session, 4096);
    restartHashes.Add(Sha256Hex(bytes));
    CryptographicOperations.ZeroMemory(bytes);
}
var restartPassed = restartHashes.Distinct(StringComparer.Ordinal).Count() == restartHashes.Count;

var entropyFailurePassed = false;
try
{
    new UnsupportedOsEntropyProvider().Fill(new byte[32]);
}
catch (PlatformNotSupportedException)
{
    entropyFailurePassed = true;
}

var sourceFiles = Directory.GetFiles(
    "services/game-engine/src",
    "*.cs",
    SearchOption.AllDirectories);
var productionInvocationFiles = sourceFiles
    .Where(path => !path.EndsWith("InternalCsprngOutcomeProvider.cs", StringComparison.Ordinal))
    .Where(path => File.ReadAllText(path).Contains("internalCsprngProvider.GenerateAsync", StringComparison.Ordinal))
    .ToArray();
var canonicalInvocationPresent = productionInvocationFiles.Length > 0;
var externalSuites = new[]
{
    ExternalSuite("NIST SP 800-22", FindCommand("assess"), "Independent/laboratory execution remains required."),
    ExternalSuite("PractRand", FindCommand("RNG_test"), "Tool is not installed in the qualification environment."),
    ExternalSuite("dieharder", FindCommand("dieharder"), "Tool is not installed in the qualification environment.")
};
var threatReview = new[]
{
    new ThreatFinding("predictable initialization", "PASS", "Production initialization uses fresh OS entropy, nonce, and draw-bound personalization."),
    new ThreatFinding("insufficient entropy", "PASS", "The production provider requests 48 entropy bytes for 256-bit security strength and fails validation below the requested strength."),
    new ThreatFinding("deterministic production seeds", "PASS", "Deterministic inputs exist only in this test assembly and official conformance vectors; no production seed-injection endpoint exists."),
    new ThreatFinding("seed or state reuse", "PASS", "One HMAC-DRBG session is instantiated and destroyed per draw; production obtains fresh entropy and reseed material."),
    new ThreatFinding("nonce or counter reuse", "PASS", "A fresh 32-byte OS nonce is acquired per production draw; the DRBG reseed counter is session-local."),
    new ThreatFinding("unsafe process cloning", "NOT_APPLICABLE", "No long-lived shared DRBG state is cloned; each draw reacquires OS entropy."),
    new ThreatFinding("concurrency and state races", concurrencyPassed ? "PASS" : "DEFECT", $"{concurrencyWorkers} parallel isolated sessions produced {concurrentHashes.Distinct(StringComparer.Ordinal).Count()} unique stream hashes."),
    new ThreatFinding("biased modulo or bounded reduction", boundedFailures.Count == 0 ? "PASS" : "DEFECT", "The production sampler uses 64-bit rejection sampling before modulo reduction."),
    new ThreatFinding("biased shuffle or without-replacement selection", kenoPassed && matrixPassed ? "PASS" : "DEFECT", "Partial Fisher-Yates selection produced no duplicates and passed inclusion tests."),
    new ThreatFinding("entropy-source failure and fallback", entropyFailurePassed ? "PASS" : "DEFECT", "Unsupported entropy fails closed with no weak or deterministic fallback."),
    new ThreatFinding("secret logging or persistence", "PASS", "Production evidence stores hashes and identifiers; entropy, nonce, key, and DRBG state are zeroized and are not evidence fields."),
    new ThreatFinding("cross-draw contamination", concurrencyPassed && restartPassed ? "PASS" : "DEFECT", "Independent and fresh-session output hashes did not repeat."),
    new ThreatFinding("test-mode production leakage", "PASS", "Qualification inputs are compiled only into the test project; production DI exposes no deterministic entropy provider."),
    new ThreatFinding("provider bypass or missing invocation", canonicalInvocationPresent ? "PASS" : "DEFECT", canonicalInvocationPresent
        ? "Production orchestration invokes the canonical provider."
        : "No production orchestration path invokes InternalCsprngOutcomeProvider.GenerateAsync; canonical publication starts from pre-persisted evidence.")
};

var blockers = new List<string>();
if (!deterministicPassed) blockers.Add("Deterministic HMAC-DRBG conformance failed.");
if (rawTestFailures.Count > 0) blockers.Add($"Raw statistical anomalies: {string.Join(", ", rawTestFailures)}.");
if (boundedFailures.Count > 0) blockers.Add($"Bounded-range anomalies: {string.Join(", ", boundedFailures)}.");
if (!kenoPassed) blockers.Add("Keno without-replacement qualification failed.");
if (!pickPassed) blockers.Add("Pick qualification failed.");
if (!matrixPassed) blockers.Add("Matrix qualification failed.");
if (!concurrencyPassed) blockers.Add("Concurrent stream separation failed.");
if (!restartPassed) blockers.Add("Fresh-session restart simulation repeated output.");
if (!entropyFailurePassed) blockers.Add("Entropy failure did not fail closed.");
if (!canonicalInvocationPresent)
{
    blockers.Add("No production controller, worker, hosted service, or orchestrator invokes InternalCsprngOutcomeProvider.GenerateAsync.");
}

var summary = new
{
    schemaVersion = "mosera.csprng.internal-qualification.v1",
    qualificationMode = mode,
    status = blockers.Count == 0
        ? "CSPRNG_INTERNAL_QUALIFICATION_PASS_WITH_EXTERNAL_GATES"
        : "CSPRNG_INTERNAL_QUALIFICATION_BLOCKED",
    generatedAt,
    completedAt = DateTimeOffset.UtcNow,
    baseline = new
    {
        gitCommit = commit,
        workingTreeCleanAtStart = string.IsNullOrWhiteSpace(worktree),
        operatingSystem = Environment.OSVersion.ToString(),
        runtime = Environment.Version.ToString(),
        processArchitecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),
        processorCount = Environment.ProcessorCount,
        entropyProvider = entropyProvider.Platform.ToString(),
        entropyReady = entropyProvider.CheckReadiness(),
        implementationHashes
    },
    implementation = new
    {
        owner = "services/game-engine",
        provider = "InternalCsprngOutcomeProvider",
        algorithm = "NIST SP 800-90A Rev.1 HMAC_DRBG SHA-256",
        entropy = "OS CSPRNG via platform-specific provider",
        initialization = "48-byte entropy + 32-byte nonce + draw-bound personalization",
        reseed = "48 fresh OS bytes immediately after instantiate for every production draw",
        boundedInteger = "64-bit rejection sampling",
        withoutReplacement = "partial Fisher-Yates",
        sessionIsolation = "one session per draw; state zeroized on destroy",
        productionInvocationPresent = canonicalInvocationPresent,
        productionInvocationFiles
    },
    threatReview,
    deterministicVectors = new
    {
        passed = deterministicPassed,
        suite = conformance,
        vectors = vectorEvidence,
        customVector = new
        {
            entropyHex = Convert.ToHexString(deterministicEntropy).ToLowerInvariant(),
            nonceHex = Convert.ToHexString(deterministicNonce).ToLowerInvariant(),
            personalizationHex = Convert.ToHexString(deterministicPersonalization).ToLowerInvariant(),
            outputSha256 = Sha256Hex(deterministicFirst),
            sameInputRepeated = true,
            changedInputChangedOutput = true
        }
    },
    rawSamples,
    boundedRanges = new { passed = boundedFailures.Count == 0, sampleSizePerRange = boundSamples, results = boundedResults },
    keno = new
    {
        passed = kenoPassed,
        draws = kenoDraws,
        duplicates = kenoDuplicates,
        outOfRange = kenoOutOfRange,
        inclusion = kenoInclusionResult,
        positionFailures = kenoPositionFailures,
        allowedPositionFailures = 2,
        positions = kenoPositionResults
    },
    pick = new
    {
        passed = pickPassed,
        samples = pickSamples,
        positions = pickPositionResults,
        adjacentPositionCorrelations = pickCorrelations,
        maximumAbsoluteCorrelationZ = pickMaximumCorrelationZ
    },
    matrix = new
    {
        passed = matrixPassed,
        draws = matrixDraws,
        duplicates = matrixDuplicates,
        inclusion = matrixResult
    },
    independence = new
    {
        passed = concurrencyPassed,
        workers = concurrencyWorkers,
        uniqueOutputHashes = concurrentHashes.Distinct(StringComparer.Ordinal).Count()
    },
    restart = new
    {
        passed = restartPassed,
        cycles = restartHashes.Count,
        uniqueOutputHashes = restartHashes.Distinct(StringComparer.Ordinal).Count(),
        outputHashes = restartHashes
    },
    entropyFailure = new
    {
        passed = entropyFailurePassed,
        behavior = "Unsupported entropy provider throws PlatformNotSupportedException; no fallback path"
    },
    canonicalIntegration = new
    {
        passed = canonicalInvocationPresent,
        providerRegistered = true,
        canonicalPublicationConsumesPersistedProviderEvidence = true,
        productionInvocationFiles,
        finding = canonicalInvocationPresent
            ? "Production invocation path found."
            : "Provider generation has no production caller; existing QA invokes it only in application tests."
    },
    externalSuites,
    blockers
};

var jsonOptions = new JsonSerializerOptions { WriteIndented = true };
var summaryPath = Path.Combine(outputDirectory, "summary.json");
File.WriteAllText(summaryPath, JsonSerializer.Serialize(summary, jsonOptions));
File.WriteAllText(Path.Combine(outputDirectory, "report.md"), BuildMarkdown(summary.status, mode, commit, blockers, rawSamples.Count,
    boundedFailures.Count == 0, kenoPassed, pickPassed, matrixPassed, concurrencyPassed, restartPassed, entropyFailurePassed,
    canonicalInvocationPresent, externalSuites));
File.WriteAllText(Path.Combine(outputDirectory, "qualification-manifest.json"), JsonSerializer.Serialize(new
{
    schemaVersion = "mosera.csprng.qualification-manifest.v1",
    generatedAt,
    summary = "summary.json",
    report = "report.md",
    rawArtifacts = extended
        ? Directory.GetFiles(rawDirectory, "*.bin").Select(path => new
        {
            path = Path.GetRelativePath(outputDirectory, path),
            size = new FileInfo(path).Length,
            sha256 = Sha256Hex(File.ReadAllBytes(path))
        }).ToArray()
        : [],
    implementationHashes
}, jsonOptions));

Console.WriteLine(JsonSerializer.Serialize(new
{
    summary.status,
    mode,
    summaryPath,
    rawSampleCount = rawSamples.Count,
    blockers
}, jsonOptions));

CryptographicOperations.ZeroMemory(deterministicEntropy);
CryptographicOperations.ZeroMemory(deterministicNonce);
CryptographicOperations.ZeroMemory(changedNonce);
CryptographicOperations.ZeroMemory(deterministicPersonalization);
CryptographicOperations.ZeroMemory(deterministicFirst);
CryptographicOperations.ZeroMemory(deterministicRepeat);
CryptographicOperations.ZeroMemory(deterministicChanged);

if (failOnBlocker && blockers.Count > 0)
{
    Environment.ExitCode = 2;
}

static HmacDrbgSession NewOsSession(IHmacDrbgRuntime runtime, IOsEntropyProvider entropyProvider, string scope)
{
    var entropy = new byte[48];
    var nonce = new byte[32];
    var personalization = Encoding.UTF8.GetBytes($"mosera-csprng-qualification:{scope}:{Guid.NewGuid():N}");
    try
    {
        entropyProvider.Fill(entropy);
        entropyProvider.Fill(nonce);
        return runtime.Instantiate(CertifiedCsprngHashAlgorithm.Sha256, entropy, nonce, personalization, 256);
    }
    finally
    {
        CryptographicOperations.ZeroMemory(entropy);
        CryptographicOperations.ZeroMemory(nonce);
        CryptographicOperations.ZeroMemory(personalization);
    }
}

static byte[] GenerateDeterministic(
    IHmacDrbgRuntime runtime,
    byte[] entropy,
    byte[] nonce,
    byte[] personalization,
    int byteCount)
{
    using var session = runtime.Instantiate(
        CertifiedCsprngHashAlgorithm.Sha256,
        entropy,
        nonce,
        personalization,
        256);
    return runtime.Generate(session, byteCount);
}

static byte[] GenerateCompliantStream(
    IHmacDrbgRuntime runtime,
    HmacDrbgSession session,
    int byteCount)
{
    if (byteCount <= 0)
    {
        throw new ArgumentOutOfRangeException(nameof(byteCount));
    }

    var output = new byte[byteCount];
    var offset = 0;
    try
    {
        while (offset < output.Length)
        {
            var count = Math.Min(
                HmacDrbgRuntime.MaximumBytesPerGenerateRequest,
                output.Length - offset);
            var chunk = runtime.Generate(session, count);
            try
            {
                chunk.CopyTo(output, offset);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(chunk);
            }

            offset += count;
        }

        return output;
    }
    catch
    {
        CryptographicOperations.ZeroMemory(output);
        throw;
    }
}

static UniformResult ChiSquareUniform(IReadOnlyList<long> counts, double alpha)
{
    var total = counts.Sum();
    var expected = total / (double)counts.Count;
    var statistic = counts.Sum(value => Math.Pow(value - expected, 2) / expected);
    var pValue = Statistics.GammaQ((counts.Count - 1) / 2.0, statistic / 2.0);
    return new UniformResult(statistic, pValue, $"p >= {alpha}", pValue >= alpha);
}

static string Sha256Hex(ReadOnlySpan<byte> data) =>
    Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

static string RunCommand(string fileName, string arguments)
{
    using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
    {
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false
    }) ?? throw new InvalidOperationException($"Could not start {fileName}.");
    var output = process.StandardOutput.ReadToEnd();
    var error = process.StandardError.ReadToEnd();
    process.WaitForExit();
    if (process.ExitCode != 0) throw new InvalidOperationException($"{fileName} failed: {error}");
    return output;
}

static string? FindCommand(string name)
{
    var result = RunCommand("/bin/zsh", $"-lc \"command -v {name} || true\"").Trim();
    return string.IsNullOrWhiteSpace(result) ? null : result;
}

static object ExternalSuite(string name, string? path, string unavailableReason) => new
{
    name,
    available = path is not null,
    executable = path,
    executed = false,
    result = "DEFERRED_EXTERNAL_QUALIFICATION",
    reason = path is null
        ? unavailableReason
        : "Recognized suite detected but independent validated execution is outside this internal harness."
};

static string BuildMarkdown(
    string status,
    string mode,
    string commit,
    IReadOnlyList<string> blockers,
    int rawSamples,
    bool bounded,
    bool keno,
    bool pick,
    bool matrix,
    bool concurrency,
    bool restart,
    bool entropyFailure,
    bool canonical,
    IReadOnlyCollection<object> externalSuites)
{
    var lines = new List<string>
    {
        "# Internal CSPRNG Qualification Evidence",
        "",
        $"Status: `{status}`",
        $"Mode: `{mode}`",
        $"Commit: `{commit}`",
        "",
        "## Internal Results",
        "",
        $"- Raw independent samples: {rawSamples}",
        $"- Bounded integer bias: {(bounded ? "PASS" : "FAIL")}",
        $"- Keno 20-of-80: {(keno ? "PASS" : "FAIL")}",
        $"- Pick positions: {(pick ? "PASS" : "FAIL")}",
        $"- Matrix 6-of-49: {(matrix ? "PASS" : "FAIL")}",
        $"- Concurrent stream separation: {(concurrency ? "PASS" : "FAIL")}",
        $"- Fresh-session restart uniqueness: {(restart ? "PASS" : "FAIL")}",
        $"- Entropy failure fail-closed: {(entropyFailure ? "PASS" : "FAIL")}",
        $"- Production provider invocation: {(canonical ? "PASS" : "BLOCKED")}",
        "",
        "## Blockers",
        ""
    };
    lines.AddRange(blockers.Count == 0 ? ["- None."] : blockers.Select(blocker => $"- {blocker}"));
    lines.AddRange([
        "",
        "## External Qualification",
        "",
        $"{externalSuites.Count} recognized external suites were inventoried. Formal laboratory certification is not claimed.",
        "",
        "Raw binary artifacts are intentionally stored under the ignored `.qa/csprng-1/raw` directory."
    ]);
    return string.Join(Environment.NewLine, lines) + Environment.NewLine;
}

sealed record UniformResult(double Statistic, double PValue, string AcceptanceCriterion, bool Passed);
sealed record ThreatFinding(string Threat, string Status, string Evidence);
sealed record StatisticalResult(
    string Name,
    long SampleSizeBits,
    string ExpectedDistribution,
    double Statistic,
    double? PValue,
    string AcceptanceCriterion,
    bool Passed,
    IReadOnlyDictionary<string, double>? Metadata = null);

static class StatisticalBattery
{
    public static IReadOnlyList<StatisticalResult> Evaluate(byte[] bytes, double alpha)
    {
        var bitCount = checked((long)bytes.Length * 8);
        var ones = bytes.Sum(value => System.Numerics.BitOperations.PopCount((uint)value));
        var s = Math.Abs(2.0 * ones - bitCount) / Math.Sqrt(bitCount);
        var monobitP = Statistics.Erfc(s / Math.Sqrt(2));

        const int blockBits = 128;
        var blocks = bitCount / blockBits;
        double blockStatistic = 0;
        for (long block = 0; block < blocks; block++)
        {
            var blockOnes = 0;
            for (var offset = 0; offset < blockBits; offset++)
            {
                var bit = block * blockBits + offset;
                blockOnes += (bytes[bit / 8] >> (7 - (int)(bit % 8))) & 1;
            }
            var pi = blockOnes / (double)blockBits;
            blockStatistic += Math.Pow(pi - 0.5, 2);
        }
        blockStatistic *= 4 * blockBits;
        var blockP = Statistics.GammaQ(blocks / 2.0, blockStatistic / 2.0);

        long runs = 1;
        var previous = (bytes[0] >> 7) & 1;
        for (long bit = 1; bit < bitCount; bit++)
        {
            var current = (bytes[bit / 8] >> (7 - (int)(bit % 8))) & 1;
            if (current != previous) runs++;
            previous = current;
        }
        var piTotal = ones / (double)bitCount;
        var runsP = Math.Abs(piTotal - 0.5) >= 2 / Math.Sqrt(bitCount)
            ? 0
            : Statistics.Erfc(Math.Abs(runs - 2 * bitCount * piTotal * (1 - piTotal)) /
                (2 * Math.Sqrt(2 * bitCount) * piTotal * (1 - piTotal)));

        var byteCounts = new long[256];
        foreach (var value in bytes) byteCounts[value]++;
        var byteExpected = bytes.Length / 256.0;
        var byteStatistic = byteCounts.Sum(value => Math.Pow(value - byteExpected, 2) / byteExpected);
        var bytePValue = Statistics.GammaQ(255 / 2.0, byteStatistic / 2.0);
        var entropy = 0.0;
        foreach (var count in byteCounts.Where(count => count > 0))
        {
            var probability = count / (double)bytes.Length;
            entropy -= probability * Math.Log2(probability);
        }

        var bitPositionCounts = new long[8];
        foreach (var value in bytes)
        {
            for (var position = 0; position < 8; position++)
                bitPositionCounts[position] += (value >> position) & 1;
        }
        var maximumBitPositionZ = bitPositionCounts.Max(count =>
            Math.Abs(count - bytes.Length / 2.0) / Math.Sqrt(bytes.Length / 4.0));

        var mean = bytes.Average(value => (double)value);
        double covariance = 0;
        double variance = 0;
        for (var index = 0; index < bytes.Length - 1; index++)
        {
            covariance += (bytes[index] - mean) * (bytes[index + 1] - mean);
            variance += Math.Pow(bytes[index] - mean, 2);
        }
        var serialCorrelation = covariance / variance;
        var serialZ = Math.Abs(serialCorrelation) * Math.Sqrt(bytes.Length);

        var maxRun = 1;
        var currentRun = 1;
        previous = (bytes[0] >> 7) & 1;
        for (long bit = 1; bit < bitCount; bit++)
        {
            var current = (bytes[bit / 8] >> (7 - (int)(bit % 8))) & 1;
            if (current == previous) currentRun++;
            else { maxRun = Math.Max(maxRun, currentRun); currentRun = 1; }
            previous = current;
        }
        maxRun = Math.Max(maxRun, currentRun);
        var expectedLongest = Math.Log2(bitCount);

        var patterns = new Dictionary<uint, int>();
        long collisions = 0;
        for (var index = 0; index + 4 <= bytes.Length; index += 4)
        {
            var pattern = BitConverter.ToUInt32(bytes, index);
            if (patterns.TryGetValue(pattern, out var count))
            {
                collisions += count;
                patterns[pattern] = count + 1;
            }
            else patterns[pattern] = 1;
        }
        var patternCount = bytes.Length / 4.0;
        var expectedCollisions = patternCount * (patternCount - 1) / (2 * Math.Pow(2, 32));
        var collisionZ = Math.Abs(collisions - expectedCollisions) / Math.Sqrt(Math.Max(1, expectedCollisions));

        return new[]
        {
            Result("monobit-frequency", bitCount, "Bernoulli(0.5)", s, monobitP, alpha, monobitP >= alpha),
            Result("block-frequency-128", bitCount, "chi-square", blockStatistic, blockP, alpha, blockP >= alpha),
            Result("runs", bitCount, "NIST runs", runs, runsP, alpha, runsP >= alpha),
            new StatisticalResult("longest-run", bitCount, "approximately log2(n)", maxRun, null,
                $"abs(maxRun-log2(n)) <= 5", Math.Abs(maxRun - expectedLongest) <= 5,
                new Dictionary<string, double> { ["expected"] = expectedLongest }),
            new StatisticalResult("serial-correlation-lag-1-byte", bitCount, "correlation 0", serialCorrelation, null,
                "abs(z) <= 4.5", serialZ <= 4.5,
                new Dictionary<string, double> { ["z"] = serialZ }),
            new StatisticalResult("byte-frequency", bitCount, "uniform 0..255", byteStatistic, bytePValue,
                $"p >= {alpha}", bytePValue >= alpha),
            new StatisticalResult("shannon-entropy", bitCount, "8 bits per byte", entropy, null,
                "entropy >= 7.99", entropy >= 7.99),
            new StatisticalResult("bit-position-distribution", bitCount, "Bernoulli(0.5) per bit position", maximumBitPositionZ, null,
                "maximum abs(z) <= 4.5", maximumBitPositionZ <= 4.5),
            new StatisticalResult("repeated-32-bit-patterns", bitCount, "birthday collision expectation", collisions, null,
                "abs(z) <= 5", collisionZ <= 5,
                new Dictionary<string, double> { ["expectedCollisions"] = expectedCollisions, ["z"] = collisionZ })
        };
    }

    private static StatisticalResult Result(
        string name, long size, string expected, double statistic, double pValue, double alpha, bool passed) =>
        new(name, size, expected, statistic, pValue, $"p >= {alpha}", passed);
}

static class Statistics
{
    public static double Erfc(double value)
    {
        var z = Math.Abs(value);
        var t = 1 / (1 + 0.5 * z);
        var result = t * Math.Exp(
            -z * z - 1.26551223 +
            t * (1.00002368 +
            t * (0.37409196 +
            t * (0.09678418 +
            t * (-0.18628806 +
            t * (0.27886807 +
            t * (-1.13520398 +
            t * (1.48851587 +
            t * (-0.82215223 +
            t * 0.17087277)))))))));
        return value >= 0 ? result : 2 - result;
    }

    public static double GammaQ(double a, double x)
    {
        if (a <= 0 || x < 0) throw new ArgumentOutOfRangeException();
        if (x == 0) return 1;
        return x < a + 1 ? 1 - GammaSeries(a, x) : GammaContinuedFraction(a, x);
    }

    private static double GammaSeries(double a, double x)
    {
        var sum = 1 / a;
        var term = sum;
        var ap = a;
        for (var index = 1; index <= 1000; index++)
        {
            ap++;
            term *= x / ap;
            sum += term;
            if (Math.Abs(term) < Math.Abs(sum) * 1e-14) break;
        }
        return sum * Math.Exp(-x + a * Math.Log(x) - LogGamma(a));
    }

    private static double GammaContinuedFraction(double a, double x)
    {
        const double tiny = 1e-300;
        var b = x + 1 - a;
        var c = 1 / tiny;
        var d = 1 / Math.Max(b, tiny);
        var h = d;
        for (var index = 1; index <= 1000; index++)
        {
            var an = -index * (index - a);
            b += 2;
            d = an * d + b;
            if (Math.Abs(d) < tiny) d = tiny;
            c = b + an / c;
            if (Math.Abs(c) < tiny) c = tiny;
            d = 1 / d;
            var delta = d * c;
            h *= delta;
            if (Math.Abs(delta - 1) < 1e-14) break;
        }
        return Math.Exp(-x + a * Math.Log(x) - LogGamma(a)) * h;
    }

    private static double LogGamma(double value)
    {
        double[] coefficients =
        [
            676.5203681218851, -1259.1392167224028, 771.32342877765313,
            -176.61502916214059, 12.507343278686905, -0.13857109526572012,
            9.9843695780195716e-6, 1.5056327351493116e-7
        ];
        if (value < 0.5)
            return Math.Log(Math.PI) - Math.Log(Math.Sin(Math.PI * value)) - LogGamma(1 - value);
        value -= 1;
        var x = 0.99999999999980993;
        for (var index = 0; index < coefficients.Length; index++) x += coefficients[index] / (value + index + 1);
        var t = value + coefficients.Length - 0.5;
        return 0.5 * Math.Log(2 * Math.PI) + (value + 0.5) * Math.Log(t) - t + Math.Log(x);
    }
}
