namespace AuthService.Domain.Models;

public enum AuthMigrationGateStatus
{
    Blocked,
    Ready,
    Complete
}

public sealed record AuthMigrationBlocker(
    string Code,
    string Description,
    bool Resolved);

public sealed record AuthMigrationGate(
    string Code,
    AuthMigrationGateStatus Status,
    IReadOnlyCollection<AuthMigrationBlocker> Blockers);

public sealed record AuthMigrationReadiness(
    AuthMigrationGateStatus Status,
    IReadOnlyCollection<AuthMigrationGate> Gates,
    IReadOnlyCollection<AuthMigrationBlocker> Blockers,
    DateTimeOffset EvaluatedAt);
