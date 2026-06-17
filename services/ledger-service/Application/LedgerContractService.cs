using LedgerService.Contracts;

namespace LedgerService.Application;

public sealed class LedgerContractService
{
    public ErrorResponse CreateNotImplementedError(string correlationId)
    {
        return new ErrorResponse(
            new ErrorDto(
                LedgerErrorCodes.NotImplemented,
                "Ledger Service contract surface is available, but production ledger posting is not implemented here yet."),
            correlationId);
    }

    public ErrorResponse CreateMissingIdempotencyKeyError(string correlationId)
    {
        return new ErrorResponse(
            new ErrorDto(
                LedgerErrorCodes.ValidationFailed,
                "Idempotency-Key header is required for ledger command endpoints.",
                new Dictionary<string, object?>
                {
                    ["header"] = LedgerHeaders.IdempotencyKey
                }),
            correlationId);
    }

    public ErrorResponse CreateValidationError(
        string correlationId,
        string message,
        string field)
    {
        return new ErrorResponse(
            new ErrorDto(
                LedgerErrorCodes.ValidationFailed,
                message,
                new Dictionary<string, object?>
                {
                    ["field"] = field
                }),
            correlationId);
    }

    public bool HasValidMoney(MoneyDto? money)
    {
        return money is not null
            && money.Amount > 0
            && IsIso4217Currency(money.Currency);
    }

    public bool IsIso4217Currency(string? currency)
    {
        return !string.IsNullOrWhiteSpace(currency)
            && currency.Length == 3
            && currency.All(static character => character is >= 'A' and <= 'Z');
    }
}
