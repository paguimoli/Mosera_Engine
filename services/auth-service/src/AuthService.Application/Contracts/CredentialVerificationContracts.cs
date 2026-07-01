using AuthService.Domain.Models;

namespace AuthService.Application.Contracts;

public sealed record CredentialVerificationRequest(
    string LoginIdOrAlias,
    CredentialType CredentialType,
    Guid? CredentialId,
    IReadOnlyDictionary<string, string> PublicInputs,
    IReadOnlyCollection<string> RequestedScopes,
    string CorrelationId);

public interface ICredentialVerifier
{
    CredentialType CredentialType { get; }

    Task<CredentialVerificationResult> VerifyAsync(
        CredentialVerificationRequest request,
        CancellationToken cancellationToken);
}

public interface IPasswordCredentialVerifier : ICredentialVerifier
{
}

public interface ITotpCredentialVerifier : ICredentialVerifier
{
}

public interface IWebAuthnCredentialVerifier : ICredentialVerifier
{
}

public interface IFederatedCredentialVerifier : ICredentialVerifier
{
}

public interface IPamCredentialVerifier : ICredentialVerifier
{
}

public interface IApiKeyCredentialVerifier : ICredentialVerifier
{
}

public interface IClientSecretCredentialVerifier : ICredentialVerifier
{
}

public interface ICertificateCredentialVerifier : ICredentialVerifier
{
}

public interface ICredentialVerificationPolicy
{
    AuthenticationEligibilityResult EvaluateEligibility(Identity identity);

    MfaRequirementResult EvaluateMfaRequirement(
        Identity identity,
        IReadOnlyCollection<SecurityRiskFlag> riskFlags,
        IReadOnlyCollection<string> requestedOperations);
}

public interface ICredentialVerificationAuditSink
{
    Task RecordAsync(CredentialAuditEvent auditEvent, CancellationToken cancellationToken);
}
