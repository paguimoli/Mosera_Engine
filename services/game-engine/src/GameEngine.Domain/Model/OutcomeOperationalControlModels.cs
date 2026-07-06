namespace GameEngine.Domain.Model;

public enum OutcomeOperationalControlType
{
    EmergencyDisable,
    DrawCancel,
    OutcomeVoid,
    OutcomeSupersede,
    OutcomeReplay,
    OutcomeDispute
}

public enum OutcomeOperationalTargetArtifactType
{
    Draw,
    OutcomeEvent,
    OutcomeCertificate,
    OutcomeStrategy,
    RngProvider
}

public enum DualApprovalStatus
{
    Requested,
    Approved,
    Rejected,
    Expired
}

public sealed record OutcomeOperationalControl(
    Guid ControlId,
    OutcomeOperationalControlType ControlType,
    OutcomeOperationalTargetArtifactType TargetArtifactType,
    string TargetArtifactId,
    string ReasonCode,
    string RequestedBy,
    string? ApprovedBy,
    DualApprovalStatus DualApprovalStatus,
    bool ProductionAffecting,
    DateTimeOffset EffectiveAt,
    DateTimeOffset? ExpiresAt,
    Guid? RenewedByControlId,
    Guid? OriginalOutcomeCertificateId,
    string EvidenceHash,
    IReadOnlyDictionary<string, object?> AuditEvidence,
    SignatureMetadata? SigningMetadata);

public sealed record OutcomeCustodyEvent(
    Guid CustodyEventId,
    Guid OutcomeCertificateId,
    OutcomeCustodyState? FromState,
    OutcomeCustodyState ToState,
    Guid? ControlId,
    string ReasonCode,
    string EvidenceHash,
    DateTimeOffset CreatedAt,
    SignatureMetadata? SigningMetadata);

public sealed record OutcomeCustodyTransitionResult(
    bool IsAllowed,
    IReadOnlyCollection<string> Errors);
