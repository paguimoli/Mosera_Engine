using CreditWalletService.Contracts;

namespace CreditWalletService.Application;

public sealed class CreditWalletContractService
{
    public ErrorResponse CreateNotImplementedError(string correlationId)
    {
        return new ErrorResponse(
            new ErrorDto(
                CreditWalletErrorCodes.NotImplemented,
                "Credit Wallet Service contract surface is available, but production credit operations are not implemented here yet."),
            correlationId);
    }

    public ErrorResponse CreateMissingIdempotencyKeyError(string correlationId)
    {
        return new ErrorResponse(
            new ErrorDto(
                CreditWalletErrorCodes.ValidationFailed,
                "Idempotency-Key header is required for credit wallet command endpoints.",
                new Dictionary<string, object?>
                {
                    ["header"] = CreditWalletHeaders.IdempotencyKey
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
                CreditWalletErrorCodes.ValidationFailed,
                message,
                new Dictionary<string, object?>
                {
                    ["field"] = field
                }),
            correlationId);
    }

    public bool HasPositiveMoney(MoneyDto? money)
    {
        return money is not null
            && money.Amount > 0
            && IsIso4217Currency(money.Currency);
    }

    public bool HasNonNegativeMoney(MoneyDto? money)
    {
        return money is not null
            && money.Amount >= 0
            && IsIso4217Currency(money.Currency);
    }

    public bool HasNonZeroMoney(MoneyDto? money)
    {
        return money is not null
            && money.Amount != 0
            && IsIso4217Currency(money.Currency);
    }

    public bool IsIso4217Currency(string? currency)
    {
        return !string.IsNullOrWhiteSpace(currency)
            && currency.Length == 3
            && currency.All(static character => character is >= 'A' and <= 'Z');
    }
}
