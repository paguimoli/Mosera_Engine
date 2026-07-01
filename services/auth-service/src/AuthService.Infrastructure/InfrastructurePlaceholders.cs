namespace AuthService.Infrastructure;

public sealed record AuthInfrastructureStatus(
    bool DatabaseWiringEnabled,
    bool TokenSigningEnabled,
    bool PasswordHashingEnabled,
    bool OAuthRuntimeEnabled,
    string Reason);

public sealed class AuthInfrastructureStatusProvider
{
    public AuthInfrastructureStatus GetStatus()
    {
        return new AuthInfrastructureStatus(
            DatabaseWiringEnabled: false,
            TokenSigningEnabled: false,
            PasswordHashingEnabled: false,
            OAuthRuntimeEnabled: false,
            Reason: "Phase 23.1 defines architecture and models only.");
    }
}
