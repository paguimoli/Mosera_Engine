using LedgerService.Configuration;
using LedgerService.Contracts;
using LedgerService.Infrastructure;
using Npgsql;

namespace LedgerService.Application;

public static class FinancialPostingRuleIds
{
    public const string SettlementPayout = "SETTLEMENT_PAYOUT";
    public const string SettlementRefund = "SETTLEMENT_REFUND";
    public const string AgentCommissionAccrual = "AGENT_COMMISSION_ACCRUAL";
    public const string PlayerRebateCredit = "PLAYER_REBATE_CREDIT";
    public const string PromotionalCredit = "PROMOTIONAL_CREDIT";
    public const string ManualCreditAdjustment = "MANUAL_CREDIT_ADJUSTMENT";
    public const string ManualDebitAdjustment = "MANUAL_DEBIT_ADJUSTMENT";
    public const string CurrentVersion = "1.0.0";
    public const string LegacyRuleId = "LEGACY_MINIMAL_BALANCED_JOURNAL";
    public const string LegacyRuleVersion = "1.0.0";
}

public sealed record FinancialPostingRule(
    string RuleId,
    string Version,
    string InstructionType,
    string OriginatingAuthority,
    string DebitAccountRole,
    string CreditAccountRole,
    string AmountSource,
    string CurrencyPolicy,
    string ReversalPolicy,
    string EffectiveDatePolicy,
    string Lifecycle,
    bool PostingEnabled,
    string? ReadinessBlocker,
    string ContentHash);

public sealed record FinancialPostingCatalogReadiness(
    bool CatalogLoaded,
    bool RequiredLaunchMappingsPresent,
    bool ExactRuleResolutionReady,
    bool AccountRoleResolutionReady,
    bool SettlementMappingsReady,
    bool CommissionAccrualMappingReady,
    bool RebateMappingReady,
    bool PromotionMappingReady,
    bool ManualAdjustmentMappingReady,
    bool StakeRecognitionReady,
    bool FreePlayReady,
    bool CashierMappingsDisabled,
    IReadOnlyList<string> Blockers);

public sealed class FinancialPostingCatalog
{
    private static readonly IReadOnlyDictionary<(string InstructionType, string Authority), (string RuleId, string Version)>
        ImmutablePolicyBindings =
            new Dictionary<(string, string), (string, string)>
            {
                [("LEDGER_PAYOUT", "settlement-service")] =
                    (FinancialPostingRuleIds.SettlementPayout, FinancialPostingRuleIds.CurrentVersion),
                [("LEDGER_REFUND", "settlement-service")] =
                    (FinancialPostingRuleIds.SettlementRefund, FinancialPostingRuleIds.CurrentVersion)
            };
    private static readonly IReadOnlySet<string> CatalogInstructionTypes =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "LEDGER_PAYOUT", "LEDGER_REFUND", "AGENT_COMMISSION_ACCRUAL",
            "PLAYER_REBATE_ACCRUAL", "PLAYER_REBATE_CREDIT", "PROMOTIONAL_CREDIT",
            "MANUAL_CREDIT_ADJUSTMENT", "MANUAL_DEBIT_ADJUSTMENT",
            "WAGER_ACCEPTED_STAKE", "FREE_PLAY_ISSUANCE", "FREE_PLAY_CONVERSION",
            "AGENT_COMMISSION_PAYMENT", "CASHIER_DEPOSIT", "CASHIER_WITHDRAWAL"
        };

    private readonly ServiceConfiguration configuration;

    public FinancialPostingCatalog(ServiceConfiguration configuration)
    {
        this.configuration = configuration;
    }

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<FinancialPostingRule> ResolveAsync(
        CreateLedgerEntryRequest request,
        CancellationToken cancellationToken)
    {
        var ruleId = request.PostingRuleId?.Trim();
        var ruleVersion = request.PostingRuleVersion?.Trim();
        if (string.IsNullOrWhiteSpace(request.PostingRuleId)
            || string.IsNullOrWhiteSpace(request.PostingRuleVersion))
        {
            if (CatalogInstructionTypes.Contains(request.InstructionType))
            {
                if (string.Equals(
                    request.OriginatingAuthority,
                    "nextjs-ledger-authority-router",
                    StringComparison.Ordinal))
                {
                    return LegacyRule(request);
                }

                if (!ImmutablePolicyBindings.TryGetValue(
                    (request.InstructionType, request.OriginatingAuthority),
                    out var binding))
                {
                    throw new FinancialPostingCatalogException(
                        "Catalog-controlled instructions require an exact postingRuleId and postingRuleVersion.");
                }

                ruleId = binding.RuleId;
                ruleVersion = binding.Version;
            }
            else
            {
                return LegacyRule(request);
            }
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select rule_id, rule_version, instruction_type, originating_authority,
       debit_account_role, credit_account_role, amount_source, currency_policy,
       reversal_policy, effective_date_policy, lifecycle, posting_enabled,
       readiness_blocker, content_hash
from ledger_service.financial_posting_rules
where rule_id = @rule_id and rule_version = @rule_version;
""";
        command.Parameters.AddWithValue("rule_id", ruleId!);
        command.Parameters.AddWithValue("rule_version", ruleVersion!);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new FinancialPostingCatalogException("The exact financial posting rule version does not exist.");
        }

        var rule = new FinancialPostingRule(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
            reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7),
            reader.GetString(8), reader.GetString(9), reader.GetString(10), reader.GetBoolean(11),
            reader.IsDBNull(12) ? null : reader.GetString(12), reader.GetString(13));
        ValidateExactMatch(rule, request);
        return rule;
    }

    public async Task<FinancialPostingCatalogReadiness> GetReadinessAsync(CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            return new(false, false, false, false, false, false, false, false, false,
                false, false, true, ["DATABASE_URL is not configured for the posting catalog."]);
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select rule_id, posting_enabled, readiness_blocker
from ledger_service.financial_posting_rules
where rule_version = '1.0.0';
""";
        var rules = new Dictionary<string, (bool Enabled, string? Blocker)>(StringComparer.Ordinal);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            rules[reader.GetString(0)] = (reader.GetBoolean(1), reader.IsDBNull(2) ? null : reader.GetString(2));
        }

        bool Enabled(string id) => rules.TryGetValue(id, out var value) && value.Enabled;
        var required = new[] { FinancialPostingRuleIds.SettlementPayout, FinancialPostingRuleIds.SettlementRefund,
            FinancialPostingRuleIds.AgentCommissionAccrual, FinancialPostingRuleIds.PlayerRebateCredit,
            FinancialPostingRuleIds.PromotionalCredit, FinancialPostingRuleIds.ManualCreditAdjustment,
            FinancialPostingRuleIds.ManualDebitAdjustment };
        var blockers = rules.Values.Where(value => !string.IsNullOrWhiteSpace(value.Blocker))
            .Select(value => value.Blocker!).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        return new(
            rules.Count > 0,
            required.All(Enabled),
            true,
            true,
            Enabled(FinancialPostingRuleIds.SettlementPayout) && Enabled(FinancialPostingRuleIds.SettlementRefund),
            Enabled(FinancialPostingRuleIds.AgentCommissionAccrual),
            Enabled(FinancialPostingRuleIds.PlayerRebateCredit),
            Enabled(FinancialPostingRuleIds.PromotionalCredit),
            Enabled(FinancialPostingRuleIds.ManualCreditAdjustment) && Enabled(FinancialPostingRuleIds.ManualDebitAdjustment),
            Enabled("WAGER_ACCEPTED_STAKE"),
            Enabled("FREE_PLAY_ISSUANCE") && Enabled("FREE_PLAY_CONVERSION"),
            rules.TryGetValue("CASHIER_DEPOSIT", out var deposit) && !deposit.Enabled
                && rules.TryGetValue("CASHIER_WITHDRAWAL", out var withdrawal) && !withdrawal.Enabled,
            blockers);
    }

    private static void ValidateExactMatch(FinancialPostingRule rule, CreateLedgerEntryRequest request)
    {
        if (!string.Equals(rule.InstructionType, request.InstructionType, StringComparison.Ordinal)
            || !string.Equals(rule.OriginatingAuthority, request.OriginatingAuthority, StringComparison.Ordinal))
        {
            throw new FinancialPostingCatalogException("Posting rule does not exactly match instruction type and authority.");
        }
        if (!string.Equals(rule.Lifecycle, "ACTIVE", StringComparison.Ordinal) || !rule.PostingEnabled)
        {
            throw new FinancialPostingCatalogException(rule.ReadinessBlocker ?? "Posting rule is inactive or disabled.");
        }
        if (rule.CurrencyPolicy != "INSTRUCTION_CURRENCY")
        {
            throw new FinancialPostingCatalogException("Posting rule currency policy is unsupported.");
        }

        var metadata = request.Metadata ?? new Dictionary<string, object?>();
        if (rule.RuleId == FinancialPostingRuleIds.AgentCommissionAccrual)
        {
            RequireMetadata(metadata, "agentReference", "tenantId", "brandId");
        }
        if (rule.RuleId == FinancialPostingRuleIds.PromotionalCredit)
        {
            RequireMetadata(metadata, "promotionReference", "playerReference");
        }
        if (rule.RuleId is FinancialPostingRuleIds.ManualCreditAdjustment
            or FinancialPostingRuleIds.ManualDebitAdjustment)
        {
            RequireMetadata(metadata, "reasonCode", "operatorReference", "approvalMetadata");
        }
    }

    private static void RequireMetadata(IReadOnlyDictionary<string, object?> metadata, params string[] names)
    {
        var missing = names.Where(name => !metadata.TryGetValue(name, out var value)
            || value is null || string.IsNullOrWhiteSpace(value.ToString())).ToArray();
        if (missing.Length > 0)
        {
            throw new FinancialPostingCatalogException($"Required instruction metadata is missing: {string.Join(", ", missing)}.");
        }
    }

    private static FinancialPostingRule LegacyRule(CreateLedgerEntryRequest request)
    {
        var settlement = request.OriginatingAuthority.Contains("settlement", StringComparison.OrdinalIgnoreCase)
            || request.InstructionType.Contains("SETTLEMENT", StringComparison.OrdinalIgnoreCase);
        return new(
            FinancialPostingRuleIds.LegacyRuleId, FinancialPostingRuleIds.LegacyRuleVersion,
            request.InstructionType, request.OriginatingAuthority,
            request.Direction == LedgerDirection.CREDIT ? (settlement ? "SETTLEMENT_CLEARING" : "OPERATOR_CLEARING") : "PLAYER_LIABILITY",
            request.Direction == LedgerDirection.CREDIT ? "PLAYER_LIABILITY" : (settlement ? "SETTLEMENT_CLEARING" : "OPERATOR_CLEARING"),
            "AUTHORITATIVE_INSTRUCTION_AMOUNT", "INSTRUCTION_CURRENCY", "EXACT_COMPENSATING_JOURNAL",
            "INSTRUCTION_EFFECTIVE_AT", "ACTIVE", true, null, "sha256:" + new string('0', 64));
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!Configured) throw new FinancialPostingCatalogException("DATABASE_URL is not configured.");
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

public sealed class FinancialPostingCatalogException : Exception
{
    public FinancialPostingCatalogException(string message) : base(message) { }
}
