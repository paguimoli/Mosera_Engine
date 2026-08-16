using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;

const string PackageId = "CSPRNG-1.2A";
const string QualifiedImplementationHash = "0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46";
const int EntropyBytes = 48;
const int NonceBytes = 32;
const int ChunkBytes = 1024 * 1024;

var options = ParseArguments(args);
var repositoryRoot = FindRepositoryRoot();
var sourcePath = Path.Combine(
    repositoryRoot,
    "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs");
var actualImplementationHash = Sha256File(sourcePath);
if (!FixedHashEquals(actualImplementationHash, QualifiedImplementationHash))
{
    throw new InvalidOperationException(
        $"Qualified implementation hash mismatch. Expected {QualifiedImplementationHash}, got {actualImplementationHash}.");
}

var outputRoot = Path.GetFullPath(options.OutputRoot, repositoryRoot);
Directory.CreateDirectory(outputRoot);
var claimPath = Path.Combine(outputRoot, $".{options.SampleId}.claim");
using (new FileStream(claimPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
{
}

var sampleDirectory = Path.Combine(outputRoot, options.SampleId);
Directory.CreateDirectory(sampleDirectory);
var initialPath = Path.Combine(sampleDirectory, "manifest.initial.json");
var generatedAt = DateTimeOffset.UtcNow;
var gitCommit = Run("git", "rev-parse HEAD", repositoryRoot).Trim();
var personalization = Encoding.UTF8.GetBytes(
    $"{PackageId}|{options.SampleId}|{gitCommit}|{generatedAt:O}");
var publicInitialization = new
{
    entropySource = $"OS:{new AutoOsEntropyProvider().Platform}",
    entropyBytes = EntropyBytes,
    nonceBytes = NonceBytes,
    immediateReseedBytes = EntropyBytes,
    personalizationSha256 = Sha256(personalization),
    sessionIsolation = "one qualification session per immutable sample identity",
    secretsPersisted = false
};

WriteNewJson(initialPath, new
{
    qualificationPackageId = PackageId,
    options.SampleId,
    status = "GENERATING",
    generatedAtUtc = generatedAt,
    requestedBytes = options.ByteCount,
    qualifiedImplementationHash = actualImplementationHash,
    sourceGitCommitSha = gitCommit,
    publicInitialization
});
MakeReadOnly(initialPath);

var entropy = new byte[EntropyBytes];
var nonce = new byte[NonceBytes];
var reseedEntropy = new byte[EntropyBytes];
HmacDrbgSession? session = null;
var partialPath = Path.Combine(sampleDirectory, "sample.bin.partial");
var samplePath = Path.Combine(sampleDirectory, "sample.bin");
try
{
    var entropyProvider = new AutoOsEntropyProvider();
    var readiness = entropyProvider.CheckReadiness();
    if (!readiness.Ready)
    {
        throw new CryptographicException(string.Join("; ", readiness.Blockers));
    }

    var runtime = new HmacDrbgRuntime();
    var health = runtime.RunHealthChecks();
    if (!health.IsReady)
    {
        throw new CryptographicException(string.Join("; ", health.Blockers));
    }

    entropyProvider.Fill(entropy);
    entropyProvider.Fill(nonce);
    entropyProvider.Fill(reseedEntropy);
    session = runtime.Instantiate(
        CertifiedCsprngHashAlgorithm.Sha256,
        entropy,
        nonce,
        personalization,
        securityStrengthBits: 256);
    runtime.Reseed(session, reseedEntropy, personalization);

    using var sampleHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    await using (var output = new FileStream(
        partialPath,
        FileMode.CreateNew,
        FileAccess.Write,
        FileShare.None,
        ChunkBytes,
        FileOptions.SequentialScan))
    {
        long remaining = options.ByteCount;
        while (remaining > 0)
        {
            var count = checked((int)Math.Min(ChunkBytes, remaining));
            var bytes = runtime.Generate(session, count);
            try
            {
                await output.WriteAsync(bytes);
                sampleHash.AppendData(bytes);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(bytes);
            }

            remaining -= count;
        }

        await output.FlushAsync();
        output.Flush(flushToDisk: true);
    }

    File.Move(partialPath, samplePath);
    var completedAt = DateTimeOffset.UtcNow;
    var rawSha256 = Convert.ToHexString(sampleHash.GetHashAndReset()).ToLowerInvariant();
    var assemblyPath = Assembly.GetExecutingAssembly().Location;
    var payload = new
    {
        schemaVersion = "1.0.0",
        qualificationPackageId = PackageId,
        sampleId = options.SampleId,
        executionId = options.SampleId,
        status = "COMPLETED",
        generatedAtUtc = generatedAt,
        completedAtUtc = completedAt,
        algorithm = "HMAC_DRBG-SHA-256",
        securityStrengthBits = 256,
        qualifiedImplementationHash = actualImplementationHash,
        qualifiedImplementationSource = Path.GetRelativePath(repositoryRoot, sourcePath),
        sourceGitCommitSha = gitCommit,
        streamSizeBytes = options.ByteCount,
        streamSizeBits = checked(options.ByteCount * 8),
        rawSampleSha256 = rawSha256,
        rawFormat = "application/octet-stream; untransformed",
        generatorInvocation = Environment.CommandLine,
        generator = new
        {
            project = "GameEngine.CsprngExternalSampleGenerator",
            assemblySha256 = Sha256File(assemblyPath),
            framework = RuntimeInformation.FrameworkDescription
        },
        environment = new
        {
            os = RuntimeInformation.OSDescription,
            architecture = RuntimeInformation.OSArchitecture.ToString(),
            machine = Environment.MachineName,
            processArchitecture = RuntimeInformation.ProcessArchitecture.ToString()
        },
        intendedSuites = options.Suites,
        evidencePath = Path.GetRelativePath(repositoryRoot, sampleDirectory),
        samplePath = "sample.bin",
        publicInitialization,
        handling = new
        {
            appendOnlyIdentity = true,
            overwritePermitted = false,
            classification = "QUALIFICATION_SAMPLE_NOT_YET_STATISTICALLY_QUALIFIED"
        }
    };
    var payloadJson = JsonSerializer.Serialize(payload);
    var manifest = new
    {
        manifestPayload = payload,
        manifestPayloadSha256 = Sha256(Encoding.UTF8.GetBytes(payloadJson))
    };
    var manifestPath = Path.Combine(sampleDirectory, "manifest.json");
    WriteNewJson(manifestPath, manifest);
    var manifestFileHash = Sha256File(manifestPath);
    File.WriteAllText(
        Path.Combine(sampleDirectory, "manifest.json.sha256"),
        $"{manifestFileHash}  manifest.json{Environment.NewLine}",
        new UTF8Encoding(false));
    MakeReadOnly(samplePath);
    MakeReadOnly(manifestPath);
    MakeReadOnly(Path.Combine(sampleDirectory, "manifest.json.sha256"));
    Console.WriteLine(manifestPath);
}
catch (Exception error)
{
    WriteNewJson(Path.Combine(sampleDirectory, "manifest.failed.json"), new
    {
        qualificationPackageId = PackageId,
        sampleId = options.SampleId,
        status = "FAILED_PRESERVED",
        failedAtUtc = DateTimeOffset.UtcNow,
        failureType = error.GetType().Name,
        failureReason = error.Message
    });
    throw;
}
finally
{
    session?.Dispose();
    CryptographicOperations.ZeroMemory(entropy);
    CryptographicOperations.ZeroMemory(nonce);
    CryptographicOperations.ZeroMemory(reseedEntropy);
    CryptographicOperations.ZeroMemory(personalization);
}

static GeneratorOptions ParseArguments(string[] arguments)
{
    string? sampleId = null;
    string outputRoot = ".qa/csprng-1.2a/evidence";
    long byteCount = 1024 * 1024;
    var suites = new[] { "PractRand", "dieharder", "NIST_SP_800_22_STS" };
    for (var index = 0; index < arguments.Length; index++)
    {
        var value = index + 1 < arguments.Length ? arguments[index + 1] : null;
        switch (arguments[index])
        {
            case "--sample-id": sampleId = value; index++; break;
            case "--output-root": outputRoot = value ?? throw new ArgumentException("--output-root requires a value."); index++; break;
            case "--bytes": byteCount = long.Parse(value ?? "", System.Globalization.CultureInfo.InvariantCulture); index++; break;
            case "--suites": suites = (value ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries); index++; break;
            default: throw new ArgumentException($"Unknown argument: {arguments[index]}");
        }
    }

    if (string.IsNullOrWhiteSpace(sampleId) || !Regex.IsMatch(sampleId, "^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$"))
    {
        throw new ArgumentException("--sample-id must be 3-128 safe identity characters.");
    }

    if (byteCount <= 0 || byteCount > long.MaxValue / 8)
    {
        throw new ArgumentOutOfRangeException(nameof(byteCount));
    }

    if (suites.Length == 0)
    {
        throw new ArgumentException("At least one intended suite is required.");
    }

    return new GeneratorOptions(sampleId, outputRoot, byteCount, suites);
}

static string FindRepositoryRoot()
{
    var current = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (current is not null)
    {
        if (Directory.Exists(Path.Combine(current.FullName, ".git")) && File.Exists(Path.Combine(current.FullName, "package.json")))
        {
            return current.FullName;
        }
        current = current.Parent;
    }
    throw new InvalidOperationException("Repository root was not found.");
}

static string Run(string file, string arguments, string workingDirectory)
{
    using var process = Process.Start(new ProcessStartInfo(file, arguments)
    {
        WorkingDirectory = workingDirectory,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false
    }) ?? throw new InvalidOperationException($"Could not start {file}.");
    var stdout = process.StandardOutput.ReadToEnd();
    var stderr = process.StandardError.ReadToEnd();
    process.WaitForExit();
    if (process.ExitCode != 0) throw new InvalidOperationException($"{file} failed: {stderr.Trim()}");
    return stdout;
}

static void WriteNewJson(string path, object value)
{
    var json = JsonSerializer.Serialize(value, JsonConfig.Options) + Environment.NewLine;
    using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
    using var writer = new StreamWriter(stream, new UTF8Encoding(false));
    writer.Write(json);
}

static string Sha256File(string path)
{
    using var stream = File.OpenRead(path);
    return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
}

static string Sha256(ReadOnlySpan<byte> value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

static bool FixedHashEquals(string left, string right) => CryptographicOperations.FixedTimeEquals(
    Encoding.ASCII.GetBytes(left.ToLowerInvariant()),
    Encoding.ASCII.GetBytes(right.ToLowerInvariant()));

static void MakeReadOnly(string path)
{
    File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.ReadOnly);
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
}

internal sealed record GeneratorOptions(string SampleId, string OutputRoot, long ByteCount, string[] Suites);

internal static class JsonConfig
{
    internal static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };
}
