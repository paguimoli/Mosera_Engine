namespace AuthService.Domain.Models;

public enum AuthRuntimeGateStatus
{
    Disabled,
    Blocked,
    Ready
}

public sealed record AuthRuntimeGateBlocker(
    string Code,
    string Description,
    bool Resolved);

public sealed record TokenIssuanceActivationGate(
    AuthRuntimeGateStatus Status,
    bool EnabledByDefault,
    IReadOnlyCollection<AuthRuntimeGateBlocker> Blockers);

public sealed record OAuthRuntimeActivationGate(
    AuthRuntimeGateStatus Status,
    bool EnabledByDefault,
    IReadOnlyCollection<AuthRuntimeGateBlocker> Blockers);

public sealed record SessionRuntimeActivationGate(
    AuthRuntimeGateStatus Status,
    bool EnabledByDefault,
    IReadOnlyCollection<AuthRuntimeGateBlocker> Blockers);
