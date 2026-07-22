using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

namespace CreditWalletService.Application;

public sealed class CanonicalWalletOperationService(CanonicalWalletOperationRepository repository)
{
    public async Task<CanonicalWalletOperationResponse> ExecuteAsync(
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string authenticatedCaller,
        string correlationId,
        CancellationToken cancellationToken)
    {
        Validate(request, idempotencyKey, authenticatedCaller);
        var hash = CanonicalWalletRequestHasher.Compute(request, idempotencyKey);
        var operationId = CanonicalWalletRequestHasher.ComputeOperationId(idempotencyKey);
        return await repository.ExecuteAsync(
            request, idempotencyKey.Trim(), hash, operationId, correlationId, cancellationToken);
    }

    private static void Validate(
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string authenticatedCaller)
    {
        if (request.RequestId == Guid.Empty || request.TenantId == Guid.Empty || request.BrandId == Guid.Empty ||
            request.PlayerId == Guid.Empty || request.WalletId == Guid.Empty)
        {
            throw new CanonicalWalletOperationValidationException(
                "Request, tenant, brand, player, and wallet identifiers are required.");
        }
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 250)
        {
            throw new CanonicalWalletOperationValidationException("A valid Idempotency-Key is required.");
        }
        if (request.Money.Amount <= 0 || request.Money.Currency.Length != 3 ||
            request.Money.Currency.Any(character => character is < 'A' or > 'Z'))
        {
            throw new CanonicalWalletOperationValidationException(
                "Money must use a positive integer minor-unit amount and uppercase ISO-4217 currency.");
        }
        if (string.IsNullOrWhiteSpace(request.Authority) || request.EffectiveAt == default)
        {
            throw new CanonicalWalletOperationValidationException("Authority and effectiveAt are required.");
        }
        if (request.Operation == WalletOperationType.RESERVE && request.TicketId is null)
        {
            throw new CanonicalWalletOperationValidationException("RESERVE requires ticketId.");
        }
        if (request.Operation is WalletOperationType.RELEASE or WalletOperationType.CANCEL or WalletOperationType.SETTLE or WalletOperationType.REVERSE &&
            (request.TicketId is null || request.ReservationId is null))
        {
            throw new CanonicalWalletOperationValidationException(
                "RELEASE, CANCEL, SETTLE, and REVERSE require ticketId and reservationId.");
        }
        if (request.Operation is WalletOperationType.RELEASE or WalletOperationType.CANCEL &&
            string.IsNullOrWhiteSpace(request.ReasonCode))
        {
            throw new CanonicalWalletOperationValidationException("RELEASE and CANCEL require a reasonCode.");
        }
        if (request.Operation is WalletOperationType.SETTLE or WalletOperationType.REVERSE &&
            (request.SettlementId is null || request.SettlementBatchId is null ||
             request.SettlementInstructionId is null || request.SettlementInstructionSequence is null or < 0 ||
             string.IsNullOrWhiteSpace(request.SettlementInstructionHash) ||
             string.IsNullOrWhiteSpace(request.SettlementVersion) ||
             string.IsNullOrWhiteSpace(request.SettlementHash) ||
             request.SettlementOutcome is null || request.BalanceImpact is null ||
             request.LedgerPostingRequired is null ||
             request.BalanceImpact.Currency != request.Money.Currency))
        {
            throw new CanonicalWalletOperationValidationException(
                "SETTLE and REVERSE require authoritative Settlement provenance, Ledger policy, outcome, and a same-currency balanceImpact.");
        }
        if (request.Operation is WalletOperationType.SETTLE or WalletOperationType.REVERSE &&
            (!string.Equals(request.Authority, "settlement-service", StringComparison.Ordinal) ||
             !string.Equals(request.SourceService, "settlement-service", StringComparison.Ordinal) ||
             !string.Equals(authenticatedCaller, "settlement-service", StringComparison.Ordinal)))
        {
            throw new CanonicalWalletOperationValidationException(
                "Authoritative settlement operations require the authenticated settlement-service authority and service identity.");
        }
        if (!string.IsNullOrWhiteSpace(request.SourceService) &&
            !string.Equals(request.SourceService, authenticatedCaller, StringComparison.Ordinal))
        {
            throw new CanonicalWalletOperationValidationException(
                "sourceService must match the authenticated internal caller.");
        }
        if (request.Operation is WalletOperationType.SETTLE or WalletOperationType.REVERSE &&
            request.LedgerInstructionId is null)
        {
            throw new CanonicalWalletOperationValidationException(
                "Settlement operations require the preceding Ledger instruction reference, including explicit no-post instructions.");
        }
        if (request.Operation == WalletOperationType.REVERSE &&
            (request.OriginalOperationId is null || string.IsNullOrWhiteSpace(request.ReasonCode)))
        {
            throw new CanonicalWalletOperationValidationException(
                "REVERSE requires originalOperationId and reasonCode.");
        }
    }
}
