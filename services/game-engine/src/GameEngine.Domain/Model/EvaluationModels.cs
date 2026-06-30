namespace GameEngine.Domain.Model;

public enum GameEvaluationOutcome
{
    Pending,
    Win,
    Loss,
    Push,
    Void,
    Rejected
}

public enum GameEvaluationReason
{
    None,
    FixtureMatch,
    NoMatch,
    InvalidTicket,
    InvalidDrawResult,
    UnsupportedWagerType,
    UnsupportedGameType,
    KenoSpotMatch,
    KenoSpotMiss,
    KenoBullseyeMatch,
    KenoBullseyeMiss,
    KenoDerivedMatch,
    KenoDerivedMiss
}

public sealed record GameEvaluationAmount(
    string Currency,
    decimal StakeAmount,
    decimal PayoutAmount,
    decimal NetAmount);

public sealed record GameEvaluationMetadata(
    string ModuleId,
    string ModuleVersion,
    string EvaluatorVersion,
    string PaytableVersion,
    string DrawGeneratorVersion,
    string GameDefinitionVersion,
    string PrngProviderVersion,
    string DrawAuthorityVersion,
    string EvaluationHash);

public sealed record GameEvaluationInput(
    Guid TicketId,
    Guid DrawScheduleId,
    GameType GameType,
    WagerType WagerType,
    IReadOnlyDictionary<string, object?> TicketPayload,
    IReadOnlyDictionary<string, object?> DrawResultPayload,
    GameEvaluationAmount Stake,
    GameEvaluationMetadata Metadata);

public sealed record GameEvaluationOutput(
    Guid TicketId,
    GameEvaluationOutcome Outcome,
    GameEvaluationReason Reason,
    GameEvaluationAmount Amount,
    GameEvaluationMetadata Metadata,
    ValidationResult ValidationResult,
    IReadOnlyDictionary<string, object?> SettlementFacts);
