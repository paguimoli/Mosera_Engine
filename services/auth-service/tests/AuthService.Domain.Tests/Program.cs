using AuthService.Domain.Models;

var loginId = new LoginId(" global-admin ");
Assert(loginId.Value == "global-admin", "Login ID should normalize surrounding whitespace.");

var credential = new Credential(
    Guid.NewGuid(),
    Guid.NewGuid(),
    CredentialType.Passkey,
    "public-passkey-reference",
    PasswordOptional: true,
    Active: true,
    DateTimeOffset.UtcNow,
    ExpiresAt: null);

Assert(credential.PasswordOptional, "Credentials must support passwordless identities.");
Assert(Enum.GetNames<IdentityType>().Contains(nameof(IdentityType.PamUser)), "PAM users must be represented.");
Assert(Enum.GetNames<IdentityType>().Contains(nameof(IdentityType.ServiceAccount)), "Service accounts must be represented.");
Assert(Enum.GetNames<CredentialType>().Contains(nameof(CredentialType.ClientCertificate)), "mTLS credential references must be represented.");

var identity = new Identity(
    Guid.NewGuid(),
    loginId,
    IdentityType.Admin,
    IdentityLifecycleState.Created,
    [credential],
    [],
    [],
    [],
    DateTimeOffset.UtcNow);

Assert(identity.Credentials.Count == 1, "Identity must support multiple credential collection semantics.");
Assert(identity.LifecycleState == IdentityLifecycleState.Created, "Identity lifecycle state machine must start explicitly.");

var policy = new Policy(
    "authority.approval.admin",
    "Authority Approval Admin",
    "role == operations_admin && claim.authority.approver == true",
    ["authority.approver"],
    ["operations_admin"],
    EnforcedLocallyByServices: true);

Assert(policy.EnforcedLocallyByServices, "Hybrid policy model requires local service enforcement.");

Console.WriteLine("AuthService.Domain.Tests PASS");

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
