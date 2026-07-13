namespace GameEngine.Domain.Model;

public enum ExternalResultSourceType
{
    OfficialApi,
    SignedFileFeed,
    ApprovedOperatorFeed,
    ManualRegulatorImport
}

public enum ExternalResultAuthenticationMethod
{
    None,
    ApiKeyReference,
    MutualTls,
    SignedPayload,
    DetachedSignature,
    OperatorAttestation
}

public enum ExternalResultSignatureRequirement
{
    NotRequired,
    DetachedRequired,
    SignedEnvelopeRequired
}

public enum ExternalResultTransportSecurityRequirement
{
    HttpsRequired,
    MutualTlsRequired,
    OfflineSignedFile
}

public enum ExternalResultSourceLifecycleState
{
    Draft,
    Active,
    Suspended,
    Retired,
    Superseded,
    Revoked
}

public enum ExternalResultFailureMode
{
    FailClosed,
    Disabled
}

public enum ExternalResultSchemaType
{
    UniqueNumberSet,
    OrderedNumberSequence,
    BonusNumberSet,
    SymbolSequence,
    Composite
}

public enum ExternalResultCustodyState
{
    Received,
    Authenticated,
    Verified,
    Normalized,
    Certified,
    Disputed,
    Superseded,
    Rejected
}

public enum ExternalResultVerificationStatus
{
    Pending,
    Verified,
    Rejected,
    Conflict,
    SupersessionRequired
}

public sealed record ExternalResultPublicationDelayPolicy(
    TimeSpan MaxClockSkew,
    TimeSpan? MaxResultAge,
    bool FutureTimestampsRejected);

public sealed record ExternalResultSourceDefinition(
    Guid Id,
    string SourceId,
    string SourceVersion,
    string SourceName,
    ExternalResultSourceType SourceType,
    IReadOnlyDictionary<string, object?> EndpointReferenceMetadata,
    ExternalResultAuthenticationMethod AuthenticationMethod,
    ExternalResultSignatureRequirement SignatureRequirement,
    ExternalResultTransportSecurityRequirement TransportSecurityRequirement,
    IReadOnlyCollection<string> SupportedGameIdentifiers,
    IReadOnlyCollection<ExternalResultSchemaType> SupportedResultSchemas,
    string SourceTimezone,
    ExternalResultPublicationDelayPolicy PublicationDelayPolicy,
    bool ReplayRetrievalCapability,
    bool ProductionEligible,
    ExternalResultSourceLifecycleState LifecycleState,
    ExternalResultFailureMode FailureMode,
    string ContentHash,
    string? CertificationBinding,
    string? VerificationKeyId,
    string? VerificationAlgorithmVersion,
    DateTimeOffset? VerificationKeyRevokedAt,
    string? SupersedesSourceVersion);

public sealed record ExternalOfficialResultEnvelope(
    Guid IngestionRequestId,
    string IdempotencyKey,
    string SourceId,
    string SourceVersion,
    string ProviderId,
    string ProviderVersion,
    string ManifestId,
    string ManifestVersion,
    string GameIdentifier,
    string DrawingId,
    string ExternalDrawId,
    DateTimeOffset PublicationTimestamp,
    DateTimeOffset SourceTimestamp,
    DateTimeOffset ReceivedTimestamp,
    string SourcePayloadHash,
    string? SourceSignature,
    string SignatureAlgorithmVersion,
    string SchemaVersion,
    ExternalResultSchemaType SchemaType,
    IReadOnlyDictionary<string, object?> ResultPayload,
    string TransportEvidenceReference,
    string SourceMetadataReference);

public sealed record ExternalResultNormalizedPayload(
    ExternalResultSchemaType SchemaType,
    IReadOnlyDictionary<string, object?> Payload,
    string CanonicalPayload,
    string CanonicalPayloadHash);

public sealed record ExternalResultVerificationEvidence(
    Guid EvidenceId,
    Guid IngestionRequestId,
    string SourceId,
    string SourceVersion,
    string ProviderId,
    string ProviderVersion,
    string ExternalDrawId,
    ExternalResultVerificationStatus Status,
    ExternalResultCustodyState CustodyState,
    string CanonicalResultHash,
    string SourcePayloadHash,
    string? FailureCode,
    string? FailureReason,
    string EvidenceHash,
    DateTimeOffset VerifiedAt);

public sealed record ExternalResultRuntimeReadiness(
    bool SourceRepositoryReady,
    bool SignatureVerificationReady,
    bool SchemaNormalizationReady,
    bool IngestionEvidenceRepositoryReady,
    bool DurableIdempotencyReady,
    bool AdvisoryLockingReady,
    bool ProductionGenerationDisabled,
    IReadOnlyCollection<string> CapabilityMarkers,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
