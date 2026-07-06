namespace GameEngine.Domain.Model;

public enum CertificationPackState
{
    None,
    InternalVerified,
    LabSubmitted,
    Certified
}

public sealed record ArtifactReference(
    string ArtifactType,
    string ArtifactId,
    string ArtifactVersion,
    string ContentHash);

public sealed record CertificateArtifactReference(
    Guid CertificateId,
    string CertificateHash);

public sealed record CertificationPackV1(
    Guid Id,
    string CertificationPackId,
    string CertificationVersion,
    ArtifactReference GameManifestReference,
    ArtifactReference OutcomeStrategyReference,
    ArtifactReference RngProviderReference,
    ArtifactReference MathModelReference,
    ArtifactReference PaytableReference,
    IReadOnlyCollection<CertificateArtifactReference> OutcomeCertificateReferences,
    IReadOnlyCollection<CertificateArtifactReference> MathEvaluationCertificateReferences,
    IReadOnlyDictionary<string, object?> SourceBuildMetadata,
    IReadOnlyDictionary<string, object?> SbomImageDigestReferences,
    IReadOnlyCollection<string> JurisdictionProfileReferences,
    CertificationPackState CertificationState,
    string ContentHash,
    SignatureMetadata? SigningMetadata);

public sealed record AuthorityChainExportV1(
    string ExportVersion,
    string CertificationPackId,
    string CertificationVersion,
    string HashChainRoot,
    IReadOnlyCollection<ArtifactReference> ArtifactReferences,
    IReadOnlyCollection<CertificateArtifactReference> CertificateReferences,
    IReadOnlyCollection<string> ReplayFixtureReferences,
    IReadOnlyDictionary<string, object?> EvidenceIndex,
    IReadOnlyDictionary<string, object?> SourceBuildMetadata,
    IReadOnlyDictionary<string, object?> SbomImageDigestReferences);

public sealed record CertificationPackExportResult(
    CertificationPackV1 CertificationPack,
    AuthorityChainExportV1 AuthorityChainExport,
    string CanonicalJson,
    string HashChainRoot,
    DateTimeOffset ExportedAt);
