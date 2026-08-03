using CreditWalletService.Contracts;

namespace CreditWalletService.Application;

public sealed class CreditWalletContractService
{
    public CreditWalletErrorResponse CreateNotImplementedError(string correlationId)
    {
        return new CreditWalletErrorResponse(
            new CreditWalletErrorDto(
                CreditWalletErrorCodes.NotImplemented,
                "Credit Wallet Service contract surface is available, but production credit operations are not implemented here yet."),
            correlationId);
    }

    public CreditWalletErrorResponse CreateMissingIdempotencyKeyError(string correlationId)
    {
        return new CreditWalletErrorResponse(
            new CreditWalletErrorDto(
                CreditWalletErrorCodes.ValidationFailed,
                "Idempotency-Key header is required for credit wallet command endpoints.",
                new Dictionary<string, object?>
                {
                    ["header"] = CreditWalletHeaders.IdempotencyKey
                }),
            correlationId);
    }

    public CreditWalletErrorResponse CreateValidationError(
        string correlationId,
        string message,
        string field)
    {
        return new CreditWalletErrorResponse(
            new CreditWalletErrorDto(
                CreditWalletErrorCodes.ValidationFailed,
                message,
                new Dictionary<string, object?>
                {
                    ["field"] = field
                }),
            correlationId);
    }

    public bool HasPositiveMoney(CreditWalletMoneyDto? money)
    {
        return money is not null
            && money.Amount > 0
            && IsIso4217Currency(money.Currency);
    }

    public bool HasNonNegativeMoney(CreditWalletMoneyDto? money)
    {
        return money is not null
            && money.Amount >= 0
            && IsIso4217Currency(money.Currency);
    }

    public bool HasNonZeroMoney(CreditWalletMoneyDto? money)
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
