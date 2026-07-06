using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class CertificationPackExportService
{
    public CertificationPackExportResult BuildExport(
        CertificationPackV1 certificationPack,
        IReadOnlyCollection<string> replayFixtureReferences)
    {
        Validate(certificationPack);

        var artifacts = new[]
        {
            certificationPack.GameManifestReference,
            certificationPack.OutcomeStrategyReference,
            certificationPack.RngProviderReference,
            certificationPack.MathModelReference,
            certificationPack.PaytableReference
        };

        var certificates = certificationPack.OutcomeCertificateReferences
            .Concat(certificationPack.MathEvaluationCertificateReferences)
            .OrderBy(reference => reference.CertificateId)
            .ToArray();

        var evidenceIndex = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["gameManifest"] = certificationPack.GameManifestReference.ContentHash,
            ["outcomeStrategy"] = certificationPack.OutcomeStrategyReference.ContentHash,
            ["rngProvider"] = certificationPack.RngProviderReference.ContentHash,
            ["mathModel"] = certificationPack.MathModelReference.ContentHash,
            ["paytable"] = certificationPack.PaytableReference.ContentHash,
            ["outcomeCertificates"] = certificationPack.OutcomeCertificateReferences
                .Select(reference => reference.CertificateHash)
                .Order(StringComparer.Ordinal)
                .ToArray(),
            ["mathEvaluationCertificates"] = certificationPack.MathEvaluationCertificateReferences
                .Select(reference => reference.CertificateHash)
                .Order(StringComparer.Ordinal)
                .ToArray()
        };

        var rootMaterial = string.Join(
            "|",
            artifacts.Select(artifact => artifact.ContentHash)
                .Concat(certificates.Select(certificate => certificate.CertificateHash))
                .Order(StringComparer.Ordinal));
        var hashChainRoot = Hash(rootMaterial);

        var export = new AuthorityChainExportV1(
            "certification-pack-v1",
            certificationPack.CertificationPackId,
            certificationPack.CertificationVersion,
            hashChainRoot,
            artifacts.OrderBy(artifact => artifact.ArtifactType, StringComparer.Ordinal).ToArray(),
            certificates,
            replayFixtureReferences.Order(StringComparer.Ordinal).ToArray(),
            evidenceIndex,
            certificationPack.SourceBuildMetadata,
            certificationPack.SbomImageDigestReferences);

        var canonicalJson = JsonSerializer.Serialize(
            export,
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        return new CertificationPackExportResult(
            certificationPack with { ContentHash = hashChainRoot },
            export,
            canonicalJson,
            hashChainRoot,
            DateTimeOffset.UtcNow);
    }

    private static void Validate(CertificationPackV1 certificationPack)
    {
        RequireReference(certificationPack.GameManifestReference, "GameManifest");
        RequireReference(certificationPack.OutcomeStrategyReference, "OutcomeStrategy");
        RequireReference(certificationPack.RngProviderReference, "RngProvider");
        RequireReference(certificationPack.MathModelReference, "MathModel");
        RequireReference(certificationPack.PaytableReference, "Paytable");
        RequireText(certificationPack.CertificationPackId, nameof(certificationPack.CertificationPackId));
        RequireText(certificationPack.CertificationVersion, nameof(certificationPack.CertificationVersion));

        if (certificationPack.OutcomeCertificateReferences.Count == 0)
        {
            throw new InvalidOperationException("Certification Pack v1 requires at least one outcome certificate reference.");
        }

        if (certificationPack.MathEvaluationCertificateReferences.Count == 0)
        {
            throw new InvalidOperationException("Certification Pack v1 requires at least one math evaluation certificate reference.");
        }
    }

    private static void RequireReference(ArtifactReference reference, string expectedType)
    {
        if (!string.Equals(reference.ArtifactType, expectedType, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Expected {expectedType} artifact reference.");
        }

        RequireText(reference.ArtifactId, $"{expectedType}.ArtifactId");
        RequireText(reference.ArtifactVersion, $"{expectedType}.ArtifactVersion");
        RequireText(reference.ContentHash, $"{expectedType}.ContentHash");
    }

    private static void RequireText(string value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"{fieldName} is required.");
        }
    }

    private static string Hash(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }
}
