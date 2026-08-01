using System.Security.Cryptography;
using System.Text;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IProductionSigningKeyResolver
{
    bool CanResolve(SigningProviderDefinition provider);

    bool Verify(
        SigningProviderDefinition provider,
        string canonicalPayloadHash,
        string signatureValue,
        out string? error);
}

public sealed class DisabledProductionSigningKeyResolver : IProductionSigningKeyResolver
{
    public bool CanResolve(SigningProviderDefinition provider) => false;

    public bool Verify(SigningProviderDefinition provider, string canonicalPayloadHash, string signatureValue, out string? error)
    {
        error = "Production signing public key is not configured.";
        return false;
    }
}

public sealed class PemProductionSigningKeyResolver(GameEngineProductionActivationOptions options)
    : IProductionSigningKeyResolver
{
    public bool CanResolve(SigningProviderDefinition provider)
    {
        if (!Matches(provider) || string.IsNullOrWhiteSpace(options.SigningPublicKeyPem)) return false;
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(options.SigningPublicKeyPem);
            return rsa.KeySize >= 3072;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    public bool Verify(SigningProviderDefinition provider, string canonicalPayloadHash, string signatureValue, out string? error)
    {
        error = null;
        if (!CanResolve(provider))
        {
            error = "Production signing public key is unavailable or weaker than RSA-3072.";
            return false;
        }

        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(options.SigningPublicKeyPem);
            var signature = Convert.FromBase64String(signatureValue);
            return rsa.VerifyData(
                Encoding.UTF8.GetBytes(canonicalPayloadHash),
                signature,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1);
        }
        catch (Exception exception) when (exception is CryptographicException or FormatException)
        {
            error = exception.Message;
            return false;
        }
    }

    private bool Matches(SigningProviderDefinition provider) =>
        provider.ProviderType == SigningProviderType.SoftwareKey &&
        string.Equals(provider.ProviderId, options.SigningProviderId, StringComparison.Ordinal) &&
        string.Equals(provider.ProviderVersion, options.SigningProviderVersion, StringComparison.Ordinal) &&
        string.Equals(provider.KeyIdentifier, options.SigningKeyVersion, StringComparison.Ordinal) &&
        string.Equals(provider.Algorithm, "RSA_SHA256", StringComparison.Ordinal);
}

public sealed class CertificateVerificationService(
    IProductionSigningKeyResolver? productionKeyResolver = null)
{
    public const string LocalTestAlgorithm = "LOCAL_TEST_SHA256";
    public const string ProductionSoftwareAlgorithm = "RSA_SHA256";
    private readonly IProductionSigningKeyResolver productionKeyResolver =
        productionKeyResolver ?? new DisabledProductionSigningKeyResolver();

    public CertificateSignature CreateLocalTestSignature(
        string certificateReferenceType,
        Guid certificateId,
        string canonicalPayloadHash,
        SigningProviderDefinition signingProvider,
        DateTimeOffset issuedAt)
    {
        var providerErrors = ValidateProvider(signingProvider, productionMode: false);
        if (providerErrors.Count > 0)
        {
            throw new InvalidOperationException(string.Join(" ", providerErrors));
        }

        if (signingProvider.ProviderType is not (SigningProviderType.LocalTest or SigningProviderType.Simulation))
        {
            throw new InvalidOperationException("Only local test and simulation providers can create local deterministic signatures.");
        }

        if (!string.Equals(signingProvider.Algorithm, LocalTestAlgorithm, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Local deterministic signing requires LOCAL_TEST_SHA256.");
        }

        return new CertificateSignature(
            DeterministicGuid($"{certificateReferenceType}:{certificateId}:{canonicalPayloadHash}:{signingProvider.ContentHash}"),
            certificateReferenceType,
            certificateId,
            signingProvider.ProviderId,
            signingProvider.ProviderVersion,
            signingProvider.Algorithm,
            signingProvider.AlgorithmVersion,
            canonicalPayloadHash,
            ComputeLocalTestSignature(canonicalPayloadHash, signingProvider),
            SignatureVerificationStatus.Verified,
            issuedAt);
    }

    public CertificateVerificationResult Verify(CertificateVerificationRequest request)
    {
        var errors = new List<string>();
        var productionMode = request.Mode is CertificateVerificationMode.ProductionDisabled or CertificateVerificationMode.Production;

        if (request.Mode == CertificateVerificationMode.ProductionDisabled)
        {
            errors.Add("Production certificate verification is disabled for this phase.");
        }

        if (string.IsNullOrWhiteSpace(request.CertificateReferenceType))
        {
            errors.Add("Certificate reference type is required.");
        }

        if (string.IsNullOrWhiteSpace(request.CanonicalPayloadHash))
        {
            errors.Add("Canonical payload hash is required.");
        }

        if (Hash(request.CanonicalPayloadJson) != request.CanonicalPayloadHash)
        {
            errors.Add("Canonical payload hash does not match the payload.");
        }

        errors.AddRange(ValidateProvider(request.SigningProvider, productionMode));

        if (request.Signature.CertificateId != request.CertificateId ||
            !string.Equals(request.Signature.CertificateReferenceType, request.CertificateReferenceType, StringComparison.Ordinal))
        {
            errors.Add("Signature certificate reference does not match the verification request.");
        }

        if (!string.Equals(request.Signature.ProviderId, request.SigningProvider.ProviderId, StringComparison.Ordinal) ||
            !string.Equals(request.Signature.ProviderVersion, request.SigningProvider.ProviderVersion, StringComparison.Ordinal))
        {
            errors.Add("Signature provider reference does not match the signing provider.");
        }

        if (!string.Equals(request.Signature.Algorithm, request.SigningProvider.Algorithm, StringComparison.Ordinal) ||
            !string.Equals(request.Signature.AlgorithmVersion, request.SigningProvider.AlgorithmVersion, StringComparison.Ordinal))
        {
            errors.Add("Signature algorithm does not match the signing provider.");
        }

        if (!string.Equals(request.Signature.CanonicalPayloadHash, request.CanonicalPayloadHash, StringComparison.Ordinal))
        {
            errors.Add("Signature canonical payload hash does not match the requested payload hash.");
        }

        if (request.SigningProvider.ProviderType is SigningProviderType.LocalTest or SigningProviderType.Simulation)
        {
            var expectedSignature = ComputeLocalTestSignature(request.CanonicalPayloadHash, request.SigningProvider);
            if (!string.Equals(request.Signature.SignatureValue, expectedSignature, StringComparison.Ordinal))
            {
                errors.Add("Signature value does not verify against the canonical payload hash.");
            }
        }
        else if (request.SigningProvider.ProviderType == SigningProviderType.SoftwareKey &&
                 request.Mode == CertificateVerificationMode.Production)
        {
            if (!productionKeyResolver.Verify(
                    request.SigningProvider,
                    request.CanonicalPayloadHash,
                    request.Signature.SignatureValue,
                    out var error))
            {
                errors.Add(error ?? "Production software signature verification failed.");
            }
        }
        else
        {
            errors.Add("Real signing provider verification is deferred until KMS/HSM integration.");
        }

        if (request.PreviousCertificates.Any(reference =>
                reference.CertificateId is null || string.IsNullOrWhiteSpace(reference.CertificateHash)))
        {
            errors.Add("Certificate chain references must include certificate id and hash.");
        }

        return new CertificateVerificationResult(
            errors.Count == 0,
            errors,
            errors.Count == 0 ? SignatureVerificationStatus.Verified : SignatureVerificationStatus.Failed);
    }

    public bool SupportsProductionAlgorithm(SigningProviderDefinition provider) =>
        provider.ProviderType == SigningProviderType.SoftwareKey &&
        string.Equals(provider.Algorithm, ProductionSoftwareAlgorithm, StringComparison.Ordinal);

    public IReadOnlyCollection<string> CheckProductionReadiness(SigningProviderDefinition provider)
    {
        var errors = ValidateProvider(provider, productionMode: true).ToList();
        if (!SupportsProductionAlgorithm(provider))
            errors.Add("Production activation currently supports only SOFTWARE_KEY with RSA_SHA256 verification.");
        if (!productionKeyResolver.CanResolve(provider))
            errors.Add("Configured production signing public key is unavailable or invalid.");
        return errors;
    }

    private static IReadOnlyCollection<string> ValidateProvider(SigningProviderDefinition signingProvider, bool productionMode)
    {
        var errors = new List<string>();

        if (string.IsNullOrWhiteSpace(signingProvider.ProviderId))
        {
            errors.Add("Signing provider id is required.");
        }

        if (string.IsNullOrWhiteSpace(signingProvider.ProviderVersion))
        {
            errors.Add("Signing provider version is required.");
        }

        if (signingProvider.LifecycleState != SigningProviderLifecycleState.Active)
        {
            errors.Add("Signing provider must be active.");
        }

        if (signingProvider.ProviderType is SigningProviderType.LocalTest or SigningProviderType.Simulation &&
            signingProvider.ProductionEligible)
        {
            errors.Add("LOCAL_TEST and SIMULATION signing providers can never be production eligible.");
        }

        if (productionMode && !signingProvider.ProductionEligible)
        {
            errors.Add("Production verification requires a production-eligible signing provider.");
        }

        if (signingProvider.ProductionEligible)
        {
            if (string.IsNullOrWhiteSpace(signingProvider.KeyIdentifier))
            {
                errors.Add("Production signing providers require an active key reference.");
            }

            if (!signingProvider.VerificationSupport)
            {
                errors.Add("Production signing providers require verification support.");
            }

            if (!signingProvider.KeyRotationSupport)
            {
                errors.Add("Production signing providers require key rotation support.");
            }

            if (signingProvider.FailureMode != SigningFailureMode.FailClosed)
            {
                errors.Add("Production signing providers must fail closed.");
            }
        }

        return errors;
    }

    private static string ComputeLocalTestSignature(string canonicalPayloadHash, SigningProviderDefinition signingProvider)
    {
        return Hash(string.Join(
            "|",
            canonicalPayloadHash,
            signingProvider.ProviderId,
            signingProvider.ProviderVersion,
            signingProvider.KeyIdentifier,
            signingProvider.ContentHash));
    }

    private static string Hash(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value)).Take(16).ToArray();
        return new Guid(bytes);
    }
}
