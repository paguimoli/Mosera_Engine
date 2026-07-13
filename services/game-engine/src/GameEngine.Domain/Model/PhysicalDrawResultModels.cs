namespace GameEngine.Domain.Model;

public enum PhysicalDrawAuthorityType
{
    GovernmentLottery,
    Regulator,
    LicensedOperator,
    IndependentSupervisor
}

public enum PhysicalDrawAuthorityLifecycleState
{
    Draft,
    Active,
    Suspended,
    Retired,
    Superseded,
    Revoked
}

public enum PhysicalDrawFailureMode
{
    FailClosed,
    Disabled
}

public enum PhysicalDrawResultSchemaType
{
    UniqueNumberSet,
    OrderedNumberSequence,
    BonusNumberSet,
    SupplementaryNumberSet,
    Composite
}

public enum PhysicalDrawCustodyState
{
    Received,
    WitnessVerified,
    EquipmentVerified,
    AuthorityVerified,
    Normalized,
    Certified,
    Disputed,
    Superseded,
    Rejected
}

public enum PhysicalDrawVerificationStatus
{
    Pending,
    Verified,
    Rejected,
    Conflict,
    SupersessionRequired
}

public enum PhysicalDrawEquipmentLifecycleState
{
    Active,
    Suspended,
    Retired,
    Revoked
}

public sealed record PhysicalDrawWitnessPolicy(
    bool OperatorRequired,
    bool PrimaryWitnessRequired,
    bool SecondaryWitnessRequired,
    bool RegulatorWitnessRequired,
    int MinimumWitnessCount);

public sealed record PhysicalDrawTimestampPolicy(
    TimeSpan MaxClockSkew,
    TimeSpan? MaxDrawAge,
    bool FutureTimestampsRejected);

public sealed record PhysicalDrawAuthorityDefinition(
    Guid Id,
    string AuthorityId,
    string AuthorityVersion,
    string AuthorityName,
    PhysicalDrawAuthorityType AuthorityType,
    string Country,
    string? Jurisdiction,
    string Operator,
    string Facility,
    string DrawMachineIdentifier,
    string BallSetIdentifier,
    string ApprovedProceduresVersion,
    IReadOnlyCollection<string> SupportedGameIdentifiers,
    IReadOnlyCollection<PhysicalDrawResultSchemaType> SupportedResultSchemas,
    PhysicalDrawWitnessPolicy WitnessPolicy,
    PhysicalDrawTimestampPolicy TimestampPolicy,
    bool ProductionEligible,
    PhysicalDrawAuthorityLifecycleState LifecycleState,
    PhysicalDrawFailureMode FailureMode,
    string ContentHash,
    string? CertificationBinding);

public sealed record PhysicalDrawEquipmentReference(
    string EquipmentId,
    string EquipmentType,
    string EquipmentVersion,
    PhysicalDrawEquipmentLifecycleState LifecycleState,
    string InspectionReference,
    string MaintenanceReference,
    string CalibrationReference,
    string SealReference,
    bool Approved);

public sealed record PhysicalDrawWitnessEvidence(
    string? OperatorIdentity,
    string? PrimaryWitness,
    string? SecondaryWitness,
    string? RegulatorWitness,
    IReadOnlyCollection<string> DigitalApprovalReferences,
    IReadOnlyCollection<string> ManualCertificationReferences);

public sealed record PhysicalDrawResultEnvelope(
    Guid DrawEventId,
    string IdempotencyKey,
    string DrawIdentifier,
    string ProviderId,
    string ProviderVersion,
    string AuthorityId,
    string AuthorityVersion,
    string ManifestId,
    string ManifestVersion,
    string GameIdentifier,
    DateTimeOffset DrawTimestamp,
    DateTimeOffset ScheduledTimestamp,
    DateTimeOffset ReceivedTimestamp,
    PhysicalDrawResultSchemaType SchemaType,
    IReadOnlyDictionary<string, object?> ResultPayload,
    string MachineId,
    string BallSetId,
    string DrawOperator,
    PhysicalDrawWitnessEvidence WitnessEvidence,
    IReadOnlyCollection<PhysicalDrawEquipmentReference> EquipmentReferences,
    IReadOnlyCollection<string> MediaReferences,
    string? VideoHash,
    string? ImageHash,
    string OfficialReportReference,
    string ProceduralEvidenceHash,
    string ContentHash);

public sealed record PhysicalDrawNormalizedPayload(
    PhysicalDrawResultSchemaType SchemaType,
    IReadOnlyDictionary<string, object?> Payload,
    string CanonicalPayload,
    string CanonicalPayloadHash);

public sealed record PhysicalDrawVerificationEvidence(
    Guid EvidenceId,
    Guid DrawEventId,
    string AuthorityId,
    string AuthorityVersion,
    string ProviderId,
    string ProviderVersion,
    string DrawIdentifier,
    PhysicalDrawVerificationStatus Status,
    PhysicalDrawCustodyState CustodyState,
    string CanonicalResultHash,
    string EventContentHash,
    string? FailureCode,
    string? FailureReason,
    string EvidenceHash,
    DateTimeOffset VerifiedAt);

public sealed record PhysicalDrawRuntimeReadiness(
    bool AuthorityRepositoryReady,
    bool WitnessValidationReady,
    bool EquipmentValidationReady,
    bool SchemaNormalizationReady,
    bool EvidenceRepositoryReady,
    bool DurableIdempotencyReady,
    bool AdvisoryLockingReady,
    bool ProductionGenerationDisabled,
    IReadOnlyCollection<string> CapabilityMarkers,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
