namespace GameEngine.Domain.Model;

public enum MathEvaluationMode
{
    DryRun,
    Simulation,
    ProductionDisabled
}

public enum PrizeOutcome
{
    Win,
    Loss,
    Push,
    Rejected
}

public sealed record MathEvaluationRequest(
    Guid RequestId,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string GameManifestReference,
    string MathModelId,
    string MathModelVersion,
    string MathModelHash,
    string PaytableId,
    string PaytableVersion,
    string PaytableHash,
    string TicketReference,
    IReadOnlyDictionary<string, object?> WagerPayload,
    string IdempotencyKey,
    MathEvaluationMode Mode);

public sealed record PrizeFacts(
    PrizeOutcome Outcome,
    string PrizeTier,
    decimal Multiplier,
    decimal PayoutUnits,
    IReadOnlyDictionary<string, object?> OutcomeDerivedFacts);

public sealed record MathEvaluationCertificate(
    Guid CertificateId,
    Guid MathEvaluationId,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string MathModelId,
    string MathModelVersion,
    string MathModelHash,
    string PaytableId,
    string PaytableVersion,
    string PaytableHash,
    string TicketReference,
    string CanonicalPrizeFactsHash,
    string RtpMathMetadataReference,
    SignatureMetadata? SigningMetadata,
    DateTimeOffset IssuedAt);

public sealed record MathEvaluationResult(
    Guid MathEvaluationId,
    Guid RequestId,
    string IdempotencyKey,
    MathEvaluationMode Mode,
    PrizeFacts PrizeFacts,
    string CanonicalPrizeFactsJson,
    string CanonicalPrizeFactsHash,
    MathEvaluationCertificate Certificate,
    DateTimeOffset EvaluatedAt);
