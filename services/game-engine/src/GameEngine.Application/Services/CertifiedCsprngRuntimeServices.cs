using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed record OsEntropyReadiness(
    OsEntropyPlatform Platform,
    bool Supported,
    bool Ready,
    IReadOnlyCollection<string> Blockers);

public interface IOsEntropyProvider
{
    OsEntropyPlatform Platform { get; }

    bool IsSupported { get; }

    void Fill(byte[] buffer);

    OsEntropyReadiness CheckReadiness();
}

public sealed class AutoOsEntropyProvider : IOsEntropyProvider
{
    private readonly IOsEntropyProvider inner = CreateProvider();

    public OsEntropyPlatform Platform => inner.Platform;

    public bool IsSupported => inner.IsSupported;

    public void Fill(byte[] buffer)
    {
        inner.Fill(buffer);
    }

    public OsEntropyReadiness CheckReadiness()
    {
        return inner.CheckReadiness();
    }

    private static IOsEntropyProvider CreateProvider()
    {
        if (OperatingSystem.IsLinux())
        {
            return new LinuxGetRandomEntropyProvider();
        }

        if (OperatingSystem.IsWindows())
        {
            return new WindowsBCryptEntropyProvider();
        }

        if (OperatingSystem.IsMacOS())
        {
            return new MacOsSecRandomEntropyProvider();
        }

        return new UnsupportedOsEntropyProvider();
    }
}

public sealed class UnsupportedOsEntropyProvider : IOsEntropyProvider
{
    public OsEntropyPlatform Platform => OsEntropyPlatform.Unsupported;

    public bool IsSupported => false;

    public void Fill(byte[] buffer)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        throw new PlatformNotSupportedException("No supported OS entropy provider is available. Certified CSPRNG fails closed.");
    }

    public OsEntropyReadiness CheckReadiness()
    {
        return new OsEntropyReadiness(
            Platform,
            Supported: false,
            Ready: false,
            ["No supported OS entropy provider is available."]);
    }
}

public sealed class LinuxGetRandomEntropyProvider : IOsEntropyProvider
{
    public OsEntropyPlatform Platform => OsEntropyPlatform.Linux;

    public bool IsSupported => OperatingSystem.IsLinux();

    public void Fill(byte[] buffer)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        if (!IsSupported)
        {
            throw new PlatformNotSupportedException("Linux getrandom() entropy provider is not supported on this OS.");
        }

        var offset = 0;
        while (offset < buffer.Length)
        {
            var chunk = new byte[buffer.Length - offset];
            try
            {
                var read = GetRandom(chunk, (nuint)chunk.Length, 0);
                if (read <= 0)
                {
                    throw new CryptographicException($"getrandom() failed with errno {Marshal.GetLastPInvokeError()}.");
                }

                Buffer.BlockCopy(chunk, 0, buffer, offset, (int)read);
                offset += (int)read;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(chunk);
            }
        }
    }

    public OsEntropyReadiness CheckReadiness()
    {
        if (!IsSupported)
        {
            return new OsEntropyReadiness(Platform, Supported: false, Ready: false, ["Linux getrandom() is unavailable on this OS."]);
        }

        var probe = new byte[32];
        try
        {
            Fill(probe);
            return new OsEntropyReadiness(Platform, Supported: true, Ready: true, []);
        }
        catch (Exception error) when (error is CryptographicException or PlatformNotSupportedException)
        {
            return new OsEntropyReadiness(Platform, Supported: true, Ready: false, [error.Message]);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(probe);
        }
    }

    [DllImport("libc", EntryPoint = "getrandom", SetLastError = true)]
    private static extern nint GetRandom(byte[] buffer, nuint length, uint flags);
}

public sealed class WindowsBCryptEntropyProvider : IOsEntropyProvider
{
    private const int BCryptUseSystemPreferredRng = 0x00000002;

    public OsEntropyPlatform Platform => OsEntropyPlatform.Windows;

    public bool IsSupported => OperatingSystem.IsWindows();

    public void Fill(byte[] buffer)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        if (!IsSupported)
        {
            throw new PlatformNotSupportedException("Windows BCryptGenRandom() entropy provider is not supported on this OS.");
        }

        var status = BCryptGenRandom(nint.Zero, buffer, buffer.Length, BCryptUseSystemPreferredRng);
        if (status != 0)
        {
            throw new CryptographicException($"BCryptGenRandom() failed with status 0x{status:x8}.");
        }
    }

    public OsEntropyReadiness CheckReadiness()
    {
        if (!IsSupported)
        {
            return new OsEntropyReadiness(Platform, Supported: false, Ready: false, ["BCryptGenRandom() is unavailable on this OS."]);
        }

        var probe = new byte[32];
        try
        {
            Fill(probe);
            return new OsEntropyReadiness(Platform, Supported: true, Ready: true, []);
        }
        catch (Exception error) when (error is CryptographicException or PlatformNotSupportedException)
        {
            return new OsEntropyReadiness(Platform, Supported: true, Ready: false, [error.Message]);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(probe);
        }
    }

    [DllImport("bcrypt.dll", EntryPoint = "BCryptGenRandom")]
    private static extern int BCryptGenRandom(nint algorithm, byte[] buffer, int bufferLength, int flags);
}

public sealed class MacOsSecRandomEntropyProvider : IOsEntropyProvider
{
    public OsEntropyPlatform Platform => OsEntropyPlatform.MacOS;

    public bool IsSupported => OperatingSystem.IsMacOS();

    public void Fill(byte[] buffer)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        if (!IsSupported)
        {
            throw new PlatformNotSupportedException("macOS SecRandomCopyBytes() entropy provider is not supported on this OS.");
        }

        var status = SecRandomCopyBytes(nint.Zero, (nuint)buffer.Length, buffer);
        if (status != 0)
        {
            throw new CryptographicException($"SecRandomCopyBytes() failed with status {status}.");
        }
    }

    public OsEntropyReadiness CheckReadiness()
    {
        if (!IsSupported)
        {
            return new OsEntropyReadiness(Platform, Supported: false, Ready: false, ["SecRandomCopyBytes() is unavailable on this OS."]);
        }

        var probe = new byte[32];
        try
        {
            Fill(probe);
            return new OsEntropyReadiness(Platform, Supported: true, Ready: true, []);
        }
        catch (Exception error) when (error is CryptographicException or PlatformNotSupportedException)
        {
            return new OsEntropyReadiness(Platform, Supported: true, Ready: false, [error.Message]);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(probe);
        }
    }

    [DllImport("/System/Library/Frameworks/Security.framework/Security", EntryPoint = "SecRandomCopyBytes")]
    private static extern int SecRandomCopyBytes(nint random, nuint count, byte[] bytes);
}

public sealed record HmacDrbgKnownAnswerResult(
    string VectorId,
    CertifiedCsprngHashAlgorithm HashAlgorithm,
    bool Passed,
    string? FailureReason);

public sealed record HmacDrbgRuntimeReadiness(
    bool StartupSelfTestPassed,
    IReadOnlyCollection<HmacDrbgKnownAnswerResult> KnownAnswerResults,
    bool ContinuousTestReady,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}

public interface IHmacDrbgRuntime
{
    HmacDrbgSession Instantiate(
        CertifiedCsprngHashAlgorithm hashAlgorithm,
        ReadOnlySpan<byte> entropy,
        ReadOnlySpan<byte> nonce,
        ReadOnlySpan<byte> personalization,
        int securityStrengthBits);

    byte[] Generate(HmacDrbgSession session, int byteCount, ReadOnlySpan<byte> additionalInput = default);

    void Reseed(HmacDrbgSession session, ReadOnlySpan<byte> entropy, ReadOnlySpan<byte> additionalInput = default);

    void Destroy(HmacDrbgSession session);

    HmacDrbgRuntimeReadiness RunHealthChecks();
}

public sealed class HmacDrbgSession : IDisposable
{
    internal HmacDrbgSession(CertifiedCsprngHashAlgorithm hashAlgorithm, byte[] key, byte[] value, int securityStrengthBits)
    {
        HashAlgorithm = hashAlgorithm;
        Key = key;
        Value = value;
        SecurityStrengthBits = securityStrengthBits;
        ReseedCounter = 1;
        GeneratedOutputHash = new byte[SHA256.HashSizeInBytes];
    }

    public CertifiedCsprngHashAlgorithm HashAlgorithm { get; }

    public int SecurityStrengthBits { get; }

    public long ReseedCounter { get; internal set; }

    public bool Destroyed { get; private set; }

    public long GeneratedByteCount { get; private set; }

    internal byte[] Key { get; set; }

    internal byte[] Value { get; set; }

    internal byte[]? PreviousGeneratedBlock { get; set; }

    internal byte[] GeneratedOutputHash { get; private set; }

    internal void RecordGeneratedOutput(ReadOnlySpan<byte> output)
    {
        var material = new byte[GeneratedOutputHash.Length + output.Length];
        try
        {
            GeneratedOutputHash.CopyTo(material, 0);
            output.CopyTo(material.AsSpan(GeneratedOutputHash.Length));
            var previous = GeneratedOutputHash;
            GeneratedOutputHash = SHA256.HashData(material);
            CryptographicOperations.ZeroMemory(previous);
            GeneratedByteCount = checked(GeneratedByteCount + output.Length);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(material);
        }
    }

    public string GetGeneratedBytesHash()
    {
        if (Destroyed)
        {
            throw new ObjectDisposedException(nameof(HmacDrbgSession));
        }

        return $"sha256:{Convert.ToHexString(GeneratedOutputHash).ToLowerInvariant()}";
    }

    internal void MarkDestroyed()
    {
        if (Destroyed)
        {
            return;
        }

        CryptographicOperations.ZeroMemory(Key);
        CryptographicOperations.ZeroMemory(Value);
        if (PreviousGeneratedBlock is not null)
        {
            CryptographicOperations.ZeroMemory(PreviousGeneratedBlock);
        }

        CryptographicOperations.ZeroMemory(GeneratedOutputHash);
        Destroyed = true;
    }

    public void Dispose()
    {
        MarkDestroyed();
    }
}

public sealed class HmacDrbgRuntime : IHmacDrbgRuntime
{
    public const int MaximumBytesPerGenerateRequest = 65_536;
    public const long MaximumReseedInterval = 1L << 48;

    private static readonly IReadOnlySet<int> SupportedSecurityStrengths =
        new HashSet<int> { 128, 192, 256 };

    public HmacDrbgSession Instantiate(
        CertifiedCsprngHashAlgorithm hashAlgorithm,
        ReadOnlySpan<byte> entropy,
        ReadOnlySpan<byte> nonce,
        ReadOnlySpan<byte> personalization,
        int securityStrengthBits)
    {
        ValidateProfile(hashAlgorithm, securityStrengthBits);

        var minimumEntropyBytes = MinimumEntropyBytes(securityStrengthBits);
        if (entropy.Length < minimumEntropyBytes)
        {
            throw new CryptographicException(
                $"Entropy input must be at least {minimumEntropyBytes} bytes for the selected HMAC-DRBG profile.");
        }

        var minimumNonceBytes = MinimumNonceBytes(securityStrengthBits);
        if (nonce.Length < minimumNonceBytes)
        {
            throw new CryptographicException(
                $"Nonce input must be at least {minimumNonceBytes} bytes for the selected HMAC-DRBG profile.");
        }

        var outputLength = OutputLength(hashAlgorithm);
        var key = new byte[outputLength];
        var value = Enumerable.Repeat((byte)0x01, outputLength).ToArray();
        var seedMaterial = Combine(entropy, nonce, personalization);

        try
        {
            Update(hashAlgorithm, ref key, ref value, seedMaterial);
            return new HmacDrbgSession(hashAlgorithm, key, value, securityStrengthBits);
        }
        catch
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(value);
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(seedMaterial);
        }
    }

    public byte[] Generate(HmacDrbgSession session, int byteCount, ReadOnlySpan<byte> additionalInput = default)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.Destroyed)
        {
            throw new ObjectDisposedException(nameof(HmacDrbgSession), "HMAC-DRBG session has been destroyed.");
        }

        if (byteCount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(byteCount), "Byte count must be positive.");
        }

        if (byteCount > MaximumBytesPerGenerateRequest)
        {
            throw new ArgumentOutOfRangeException(
                nameof(byteCount),
                $"Byte count must not exceed {MaximumBytesPerGenerateRequest} bytes per HMAC-DRBG Generate request.");
        }

        if (session.ReseedCounter > MaximumReseedInterval)
        {
            throw new CryptographicException("HMAC-DRBG reseed is required before another Generate request.");
        }

        var output = new byte[byteCount];
        var offset = 0;
        try
        {
            if (!additionalInput.IsEmpty)
            {
                var additional = additionalInput.ToArray();
                try
                {
                    UpdateSession(session, additional);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(additional);
                }
            }

            while (offset < byteCount)
            {
                var value = session.Value;
                ReplaceWithHmac(session.HashAlgorithm, ref value, session.Key, value);
                session.Value = value;
                VerifyContinuousTest(session, session.Value);

                var copyLength = Math.Min(session.Value.Length, byteCount - offset);
                Buffer.BlockCopy(session.Value, 0, output, offset, copyLength);
                offset += copyLength;
            }

            var postGenerationInput = additionalInput.IsEmpty
                ? ReadOnlySpan<byte>.Empty
                : additionalInput;
            UpdateSession(session, postGenerationInput);
            session.ReseedCounter++;
            session.RecordGeneratedOutput(output);
            return output;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(output);
            session.MarkDestroyed();
            throw;
        }
    }

    public void Reseed(HmacDrbgSession session, ReadOnlySpan<byte> entropy, ReadOnlySpan<byte> additionalInput = default)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.Destroyed)
        {
            throw new ObjectDisposedException(nameof(HmacDrbgSession), "HMAC-DRBG session has been destroyed.");
        }

        var minimumEntropyBytes = MinimumEntropyBytes(session.SecurityStrengthBits);
        if (entropy.Length < minimumEntropyBytes)
        {
            throw new CryptographicException(
                $"Reseed entropy must be at least {minimumEntropyBytes} bytes for the selected HMAC-DRBG profile.");
        }

        var seedMaterial = Combine(entropy, additionalInput);
        try
        {
            UpdateSession(session, seedMaterial);
            session.ReseedCounter = 1;
            if (session.PreviousGeneratedBlock is not null)
            {
                CryptographicOperations.ZeroMemory(session.PreviousGeneratedBlock);
                session.PreviousGeneratedBlock = null;
            }
        }
        catch
        {
            session.MarkDestroyed();
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(seedMaterial);
        }
    }

    public void Destroy(HmacDrbgSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        session.MarkDestroyed();
    }

    public HmacDrbgRuntimeReadiness RunHealthChecks()
    {
        var blockers = new List<string>();
        var results = new List<HmacDrbgKnownAnswerResult>();
        var conformance = new OutcomeAuthorityHardeningService(this, new OutcomeValidationFrameworkService())
            .RunHmacDrbgConformanceVectors("mosera-game-engine-hmac-drbg-runtime");

        foreach (var result in conformance.VectorResults)
        {
            if (!result.Passed)
            {
                blockers.Add($"{result.HashAlgorithm} official HMAC-DRBG conformance vector failed: {result.FailureReason}");
            }

            results.Add(new HmacDrbgKnownAnswerResult(
                result.VectorId,
                result.HashAlgorithm,
                result.Passed,
                result.FailureReason));
        }

        var cavp = RunNistCavpSha256ReseedVector();
        results.Add(cavp);
        if (!cavp.Passed)
        {
            blockers.Add($"{cavp.VectorId} failed: {cavp.FailureReason}");
        }

        return new HmacDrbgRuntimeReadiness(
            StartupSelfTestPassed: blockers.Count == 0,
            KnownAnswerResults: results,
            ContinuousTestReady: true,
            Blockers: blockers);
    }

    private HmacDrbgKnownAnswerResult RunNistCavpSha256ReseedVector()
    {
        const string vectorId = "nist-cavp-cavs14.3-drbg-pr-false-hmac-sha256-count0";
        const string expected =
            "76fc79fe9b50beccc991a11b5635783a83536add03c157fb30645e611c2898bb" +
            "2b1bc215000209208cd506cb28da2a51bdb03826aaf2bd2335d576d519160842" +
            "e7158ad0949d1a9ec3e66ea1b1a064b005de914eac2e9d4f2d72a8616a8022" +
            "5422918250ff66a41bd2f864a6a38cc5b6499dc43f7f2bd09e1e0f8f5885935124";

        var entropy = Convert.FromHexString(
            "06032cd5eed33f39265f49ecb142c511da9aff2af71203bffaf34a9ca5bd9c0d");
        var nonce = Convert.FromHexString("0e66f71edc43e42a45ad3c6fc6cdc4df");
        var reseedEntropy = Convert.FromHexString(
            "01920a4e669ed3a85ae8a33b35a74ad7fb2a6bb4cf395ce00334a9c9a5a5d552");
        var first = Array.Empty<byte>();
        var second = Array.Empty<byte>();
        var expectedBytes = Convert.FromHexString(expected);
        HmacDrbgSession? session = null;
        try
        {
            session = Instantiate(
                CertifiedCsprngHashAlgorithm.Sha256,
                entropy,
                nonce,
                ReadOnlySpan<byte>.Empty,
                256);
            Reseed(session, reseedEntropy);
            first = Generate(session, expectedBytes.Length);
            second = Generate(session, expectedBytes.Length);
            var passed = CryptographicOperations.FixedTimeEquals(second, expectedBytes);
            return new HmacDrbgKnownAnswerResult(
                vectorId,
                CertifiedCsprngHashAlgorithm.Sha256,
                passed,
                passed ? null : "ReturnedBits did not match the NIST CAVP response vector.");
        }
        catch (Exception error) when (error is CryptographicException or ArgumentException)
        {
            return new HmacDrbgKnownAnswerResult(
                vectorId,
                CertifiedCsprngHashAlgorithm.Sha256,
                false,
                error.Message);
        }
        finally
        {
            if (session is not null)
            {
                Destroy(session);
            }

            CryptographicOperations.ZeroMemory(entropy);
            CryptographicOperations.ZeroMemory(nonce);
            CryptographicOperations.ZeroMemory(reseedEntropy);
            CryptographicOperations.ZeroMemory(first);
            CryptographicOperations.ZeroMemory(second);
            CryptographicOperations.ZeroMemory(expectedBytes);
        }
    }

    private static void VerifyContinuousTest(HmacDrbgSession session, byte[] currentBlock)
    {
        if (session.PreviousGeneratedBlock is not null &&
            CryptographicOperations.FixedTimeEquals(session.PreviousGeneratedBlock, currentBlock))
        {
            throw new CryptographicException("HMAC-DRBG continuous repetition test failed.");
        }

        if (session.PreviousGeneratedBlock is not null)
        {
            CryptographicOperations.ZeroMemory(session.PreviousGeneratedBlock);
        }

        session.PreviousGeneratedBlock = currentBlock.ToArray();
    }

    private static void Update(
        CertifiedCsprngHashAlgorithm hashAlgorithm,
        ref byte[] key,
        ref byte[] value,
        ReadOnlySpan<byte> providedData)
    {
        var firstMaterial = Combine(value, (byte)0x00, providedData);
        try
        {
            ReplaceWithHmac(hashAlgorithm, ref key, key, firstMaterial);
            ReplaceWithHmac(hashAlgorithm, ref value, key, value);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(firstMaterial);
        }

        if (providedData.IsEmpty)
        {
            return;
        }

        var secondMaterial = Combine(value, (byte)0x01, providedData);
        try
        {
            ReplaceWithHmac(hashAlgorithm, ref key, key, secondMaterial);
            ReplaceWithHmac(hashAlgorithm, ref value, key, value);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secondMaterial);
        }
    }

    private static void UpdateSession(HmacDrbgSession session, ReadOnlySpan<byte> providedData)
    {
        var key = session.Key;
        var value = session.Value;
        try
        {
            Update(session.HashAlgorithm, ref key, ref value, providedData);
            session.Key = key;
            session.Value = value;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(value);
            throw;
        }
    }

    private static void ReplaceWithHmac(
        CertifiedCsprngHashAlgorithm hashAlgorithm,
        ref byte[] target,
        byte[] key,
        byte[] value)
    {
        var old = target;
        target = Hmac(hashAlgorithm, key, value);
        CryptographicOperations.ZeroMemory(old);
    }

    private static byte[] Hmac(CertifiedCsprngHashAlgorithm hashAlgorithm, byte[] key, byte[] value)
    {
        using HMAC hmac = hashAlgorithm switch
        {
            CertifiedCsprngHashAlgorithm.Sha256 => new HMACSHA256(key),
            CertifiedCsprngHashAlgorithm.Sha384 => new HMACSHA384(key),
            CertifiedCsprngHashAlgorithm.Sha512 => new HMACSHA512(key),
            _ => throw new ArgumentOutOfRangeException(nameof(hashAlgorithm), hashAlgorithm, "Unsupported HMAC-DRBG hash algorithm.")
        };

        return hmac.ComputeHash(value);
    }

    private static int OutputLength(CertifiedCsprngHashAlgorithm hashAlgorithm)
    {
        return hashAlgorithm switch
        {
            CertifiedCsprngHashAlgorithm.Sha256 => 32,
            CertifiedCsprngHashAlgorithm.Sha384 => 48,
            CertifiedCsprngHashAlgorithm.Sha512 => 64,
            _ => throw new ArgumentOutOfRangeException(nameof(hashAlgorithm), hashAlgorithm, "Unsupported HMAC-DRBG hash algorithm.")
        };
    }

    private static void ValidateProfile(
        CertifiedCsprngHashAlgorithm hashAlgorithm,
        int securityStrengthBits)
    {
        _ = OutputLength(hashAlgorithm);
        if (!SupportedSecurityStrengths.Contains(securityStrengthBits))
        {
            throw new CryptographicException(
                "HMAC-DRBG security strength must be one of the supported profiles: 128, 192, or 256 bits.");
        }
    }

    private static int MinimumEntropyBytes(int securityStrengthBits) =>
        checked((securityStrengthBits + 7) / 8);

    private static int MinimumNonceBytes(int securityStrengthBits) =>
        checked(((securityStrengthBits / 2) + 7) / 8);

    private static byte[] Combine(ReadOnlySpan<byte> first, ReadOnlySpan<byte> second)
    {
        var output = new byte[first.Length + second.Length];
        first.CopyTo(output);
        second.CopyTo(output.AsSpan(first.Length));
        return output;
    }

    private static byte[] Combine(ReadOnlySpan<byte> first, ReadOnlySpan<byte> second, ReadOnlySpan<byte> third)
    {
        var output = new byte[first.Length + second.Length + third.Length];
        first.CopyTo(output);
        second.CopyTo(output.AsSpan(first.Length));
        third.CopyTo(output.AsSpan(first.Length + second.Length));
        return output;
    }

    private static byte[] Combine(ReadOnlySpan<byte> first, byte marker, ReadOnlySpan<byte> third)
    {
        var length = first.Length + 1 + third.Length;
        var output = new byte[length];
        first.CopyTo(output);
        output[first.Length] = marker;
        third.CopyTo(output.AsSpan(first.Length + 1));

        return output;
    }
}

public interface ICertifiedCsprngSampler
{
    int NextInt32(HmacDrbgSession session, int minInclusive, int maxInclusive);

    IReadOnlyList<int> FisherYatesShuffle(HmacDrbgSession session, IReadOnlyList<int> values);

    IReadOnlyList<int> UniqueNumbers(HmacDrbgSession session, int minInclusive, int maxInclusive, int count);

    IReadOnlyList<int> SelectNumbers(
        HmacDrbgSession session,
        IReadOnlyList<int> universe,
        int count,
        bool unique,
        bool withReplacement,
        OutcomeNumberOrdering ordering);

    string WeightedSelection(HmacDrbgSession session, IReadOnlyDictionary<string, long> weights);
}

public sealed class CertifiedCsprngSampler(IHmacDrbgRuntime drbgRuntime) : ICertifiedCsprngSampler
{
    public int NextInt32(HmacDrbgSession session, int minInclusive, int maxInclusive)
    {
        if (minInclusive > maxInclusive)
        {
            throw new ArgumentException("Minimum value must be less than or equal to maximum value.");
        }

        var range = (ulong)((long)maxInclusive - minInclusive + 1L);
        var value = NextUInt64Below(session, range);
        return checked((int)(minInclusive + (long)value));
    }

    public IReadOnlyList<int> FisherYatesShuffle(HmacDrbgSession session, IReadOnlyList<int> values)
    {
        ArgumentNullException.ThrowIfNull(values);
        var copy = values.ToArray();
        for (var i = copy.Length - 1; i > 0; i--)
        {
            var j = NextInt32(session, 0, i);
            (copy[i], copy[j]) = (copy[j], copy[i]);
        }

        return copy;
    }

    public IReadOnlyList<int> UniqueNumbers(HmacDrbgSession session, int minInclusive, int maxInclusive, int count)
    {
        if (count <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(count), "Count must be positive.");
        }

        var rangeSize = checked(maxInclusive - minInclusive + 1);
        if (count > rangeSize)
        {
            throw new ArgumentException("Count cannot exceed the inclusive range size.");
        }

        var values = Enumerable.Range(minInclusive, rangeSize).ToArray();
        for (var i = 0; i < count; i++)
        {
            var j = NextInt32(session, i, values.Length - 1);
            (values[i], values[j]) = (values[j], values[i]);
        }

        return values.Take(count).ToArray();
    }

    public IReadOnlyList<int> SelectNumbers(
        HmacDrbgSession session,
        IReadOnlyList<int> universe,
        int count,
        bool unique,
        bool withReplacement,
        OutcomeNumberOrdering ordering)
    {
        ArgumentNullException.ThrowIfNull(universe);
        if (universe.Count == 0 || universe.Distinct().Count() != universe.Count)
        {
            throw new ArgumentException("Number universe must contain distinct values.");
        }

        if (count <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(count), "Count must be positive.");
        }

        if (unique && withReplacement)
        {
            throw new ArgumentException("Unique generation cannot use replacement.");
        }

        if (!withReplacement && count > universe.Count)
        {
            throw new ArgumentException("Count cannot exceed the universe without replacement.");
        }

        int[] selected;
        if (withReplacement)
        {
            selected = Enumerable.Range(0, count)
                .Select(_ => universe[NextInt32(session, 0, universe.Count - 1)])
                .ToArray();
        }
        else
        {
            var shuffled = universe.ToArray();
            for (var i = 0; i < count; i++)
            {
                var j = NextInt32(session, i, shuffled.Length - 1);
                (shuffled[i], shuffled[j]) = (shuffled[j], shuffled[i]);
            }

            selected = shuffled.Take(count).ToArray();
        }

        if (unique && selected.Distinct().Count() != selected.Length)
        {
            throw new CryptographicException("Unique number generation produced a duplicate.");
        }

        return ordering switch
        {
            OutcomeNumberOrdering.DrawOrder => selected,
            OutcomeNumberOrdering.Ascending => selected.Order().ToArray(),
            _ => throw new ArgumentOutOfRangeException(nameof(ordering), ordering, null)
        };
    }

    public string WeightedSelection(HmacDrbgSession session, IReadOnlyDictionary<string, long> weights)
    {
        ArgumentNullException.ThrowIfNull(weights);
        if (weights.Count == 0)
        {
            throw new ArgumentException("Weighted selection requires at least one item.");
        }

        long total = 0;
        foreach (var weight in weights.Values)
        {
            if (weight <= 0)
            {
                throw new ArgumentException("Weighted selection requires positive integer weights.");
            }

            total = checked(total + weight);
        }

        var draw = (long)NextUInt64Below(session, (ulong)total) + 1L;
        long cumulative = 0;
        foreach (var pair in weights.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            cumulative += pair.Value;
            if (draw <= cumulative)
            {
                return pair.Key;
            }
        }

        throw new CryptographicException("Weighted selection failed closed.");
    }

    private ulong NextUInt64Below(HmacDrbgSession session, ulong exclusiveUpperBound)
    {
        if (exclusiveUpperBound == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(exclusiveUpperBound), "Upper bound must be positive.");
        }

        var threshold = (0UL - exclusiveUpperBound) % exclusiveUpperBound;
        var buffer = Array.Empty<byte>();
        try
        {
            while (true)
            {
                buffer = drbgRuntime.Generate(session, sizeof(ulong));
                var value = BinaryPrimitives.ReadUInt64BigEndian(buffer);
                if (value >= threshold)
                {
                    return value % exclusiveUpperBound;
                }

                CryptographicOperations.ZeroMemory(buffer);
                buffer = [];
            }
        }
        finally
        {
            if (buffer.Length > 0)
            {
                CryptographicOperations.ZeroMemory(buffer);
            }
        }
    }
}
