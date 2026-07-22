using System.Reflection;
using System.Text.Json;
using LedgerService.Configuration;
using LedgerService.Contracts;
using LedgerService.Infrastructure;
using Npgsql;

namespace LedgerService.Application;

public sealed record LedgerPostingExecutionResult(
    LedgerEntryDto LedgerEntry,
    LedgerPostingRequestDto PostingRequest);

public sealed class LedgerPostingService
{
    private readonly DurableLedgerService durableLedgerService;
    private readonly DurableLedgerRepository ledgerRepository;
    private readonly LedgerPostingEvidenceRepository evidenceRepository;
    private readonly LedgerAccountingPeriodRepository accountingPeriodRepository;
    private readonly LedgerJournalRepository journalRepository;
    private readonly FinancialPostingCatalog postingCatalog;
    private readonly string runtimeProvenance;
    private readonly string buildProvenance;

    public LedgerPostingService(
        DurableLedgerService durableLedgerService,
        DurableLedgerRepository ledgerRepository,
        LedgerPostingEvidenceRepository evidenceRepository,
        LedgerAccountingPeriodRepository accountingPeriodRepository,
        LedgerJournalRepository journalRepository,
        FinancialPostingCatalog postingCatalog,
        ServiceConfiguration configuration)
    {
        this.durableLedgerService = durableLedgerService;
        this.ledgerRepository = ledgerRepository;
        this.evidenceRepository = evidenceRepository;
        this.accountingPeriodRepository = accountingPeriodRepository;
        this.journalRepository = journalRepository;
        this.postingCatalog = postingCatalog;
        runtimeProvenance = $".NET {Environment.Version};{configuration.Environment}";
        buildProvenance =
            Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                ?.InformationalVersion
            ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
            ?? "unknown";
    }

    public bool DurablePostingRequestsReady => evidenceRepository.Configured;
    public bool PostingAttemptsReady => evidenceRepository.Configured;
    public bool UnknownResultRecoveryReady => evidenceRepository.Configured;
    public bool ReplayVerificationReady => evidenceRepository.Configured;
    public bool BalancedJournalReady => journalRepository.Configured;
    public bool JournalPersistenceReady => journalRepository.Configured;
    public bool JournalRecoveryReady => journalRepository.Configured;
    public bool ReversalJournalReady => journalRepository.Configured;

    public async Task<LedgerPostingExecutionResult> PostAsync(
        CreateLedgerEntryRequest request,
        string idempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var rule = await postingCatalog.ResolveAsync(request, cancellationToken);
        var accounting = await accountingPeriodRepository.ResolveAsync(
            request.WalletId, request.AccountingMarketId, request.EffectiveAt,
            request.AccountingPostedAt, cancellationToken);
        var governedRequest = ApplyAccountingContext(request, accounting);
        var durableRequest = BuildRequest(governedRequest, idempotencyKey, correlationId, rule, accounting);
        return await ExecuteAsync(
            durableRequest,
            () => durableLedgerService.PostEntryAsync(governedRequest, idempotencyKey, cancellationToken),
            cancellationToken);
    }

    public async Task<LedgerPostingExecutionResult?> ReverseAsync(
        Guid originalEntryId,
        ReverseLedgerEntryRequest request,
        string idempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var accounting = await accountingPeriodRepository.ResolveAsync(
            request.WalletId, request.AccountingMarketId, request.EffectiveAt,
            request.AccountingPostedAt, cancellationToken);
        var governedRequest = ApplyAccountingContext(request, accounting);
        var durableRequest = BuildRequest(governedRequest, idempotencyKey, correlationId, accounting);
        try
        {
            return await ExecuteAsync(
                durableRequest,
                async () =>
                {
                    var entry = await durableLedgerService.ReverseEntryAsync(
                        originalEntryId,
                        governedRequest,
                        idempotencyKey,
                        cancellationToken);
                    return entry ?? throw new LedgerPostingOriginalEntryNotFoundException();
                },
                cancellationToken);
        }
        catch (LedgerPostingOriginalEntryNotFoundException)
        {
            return null;
        }
    }

    public async Task<LedgerPostingRequestDto?> FindRequestAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        var request = await evidenceRepository.FindByIdAsync(requestId, cancellationToken);
        return request is null ? null : ToDto(request);
    }

    public async Task<IReadOnlyList<LedgerPostingAttemptDto>> ListAttemptsAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        var attempts = await evidenceRepository.ListAttemptsAsync(requestId, cancellationToken);
        return attempts.Select(ToDto).ToArray();
    }

    public async Task<LedgerPostingExecutionResult> RecoverAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        var request = await evidenceRepository.FindByIdAsync(requestId, cancellationToken)
            ?? throw new LedgerPostingRequestNotFoundException();

        var entry = await ledgerRepository.FindByIdempotencyKeyAsync(
            request.IdempotencyKey,
            cancellationToken);
        if (entry is null)
        {
            return await ResumeUncommittedAsync(request, startedAt, cancellationToken);
        }

        var mismatches = Verify(request, entry);
        if (mismatches.Count > 0)
        {
            await evidenceRepository.RecordStatusAsync(
                request.Id,
                LedgerPostingRequestStatus.UNKNOWN,
                "LEDGER_RESULT_MISMATCH",
                string.Join(" ", mismatches),
                cancellationToken);
            await AppendAttemptAsync(
                request,
                startedAt,
                DateTimeOffset.UtcNow,
                LedgerPostingAttemptResult.UNKNOWN,
                "RESULT_MISMATCH",
                entry.Id.ToString(),
                entry.CanonicalRequestHash,
                cancellationToken);
            throw new LedgerUnknownResultException(
                "Ledger posting result conflicts with durable request evidence.");
        }

        var journal = await journalRepository.EnsureAndVerifyAsync(request, entry, cancellationToken);
        var completed = await evidenceRepository.CompleteAsync(
            request.Id,
            entry,
            journal.Id,
            cancellationToken);
        await AppendAttemptAsync(
            completed,
            startedAt,
            DateTimeOffset.UtcNow,
            LedgerPostingAttemptResult.REUSED,
            "RECOVERED_EXISTING_ENTRY",
            entry.Id.ToString(),
            entry.CanonicalRequestHash,
            cancellationToken);
        return new LedgerPostingExecutionResult(ToEntryDto(entry), ToDto(completed));
    }

    private async Task<LedgerPostingExecutionResult> ResumeUncommittedAsync(
        LedgerPostingRequestRecord request,
        DateTimeOffset startedAt,
        CancellationToken cancellationToken)
    {
        try
        {
            var operation = request.RequestKind == "REVERSAL"
                ? BuildReversalResume(request, cancellationToken)
                : BuildPostingResume(request, cancellationToken);
            return await ExecuteAsync(request, operation, cancellationToken);
        }
        catch (LedgerUnknownResultException error)
        {
            await evidenceRepository.RecordStatusAsync(
                request.Id,
                LedgerPostingRequestStatus.UNKNOWN,
                "CANONICAL_RECOVERY_INCONCLUSIVE",
                error.Message,
                cancellationToken);
            await AppendAttemptAsync(
                request,
                startedAt,
                DateTimeOffset.UtcNow,
                LedgerPostingAttemptResult.UNKNOWN,
                "CANONICAL_EVIDENCE_MISMATCH",
                null,
                null,
                cancellationToken);
            throw;
        }
    }

    private Func<Task<LedgerEntryDto>> BuildPostingResume(
        LedgerPostingRequestRecord request,
        CancellationToken cancellationToken)
    {
        var posting = new CreateLedgerEntryRequest(
            request.WalletId,
            request.LedgerAccountId,
            request.InstructionId,
            request.InstructionType,
            request.InstructionHash,
            request.OriginatingAuthority,
            request.SettlementRecordId,
            request.TransactionType,
            request.Direction,
            new MoneyDto(request.Amount, request.Currency),
            request.MinorUnitPrecision,
            request.CanonicalRequestHash,
            request.EffectiveAt,
            new LedgerReferenceDto(
                MetadataString(request.Metadata, "referenceType"),
                MetadataString(request.Metadata, "referenceId")),
            null,
            request.Metadata,
            MetadataString(request.Metadata, "postingRuleId"),
            MetadataString(request.Metadata, "postingRuleVersion"),
            request.AccountingPostedAt,
            request.AccountingMarketId);
        var canonicalHash = CanonicalLedgerRequestHasher.ComputePostingHash(posting, request.IdempotencyKey);
        if (!string.Equals(canonicalHash, request.CanonicalRequestHash, StringComparison.Ordinal))
        {
            throw new LedgerUnknownResultException(
                "Stored posting request canonical evidence does not reproduce; recovery remains fail-closed.");
        }
        return () => durableLedgerService.PostEntryAsync(posting, request.IdempotencyKey, cancellationToken);
    }

    private Func<Task<LedgerEntryDto>> BuildReversalResume(
        LedgerPostingRequestRecord request,
        CancellationToken cancellationToken)
    {
        if (!request.OriginalLedgerEntryId.HasValue
            || string.IsNullOrWhiteSpace(request.OriginalLedgerEntryHash)
            || !request.LedgerAccountId.HasValue)
        {
            throw new LedgerUnknownResultException(
                "Reversal recovery evidence is incomplete and cannot be resumed safely.");
        }

        var reversal = new ReverseLedgerEntryRequest(
            request.OriginalLedgerEntryId.Value,
            request.OriginalLedgerEntryHash,
            request.WalletId,
            request.LedgerAccountId.Value,
            request.Direction,
            new MoneyDto(request.Amount, request.Currency),
            request.InstructionId,
            request.InstructionType,
            request.InstructionHash,
            request.OriginatingAuthority,
            MetadataString(request.Metadata, "reasonCode") ?? "RECOVERY",
            MetadataString(request.Metadata, "reversalPolicyVersion") ?? "ledger-reversal-v1",
            request.CanonicalRequestHash,
            request.EffectiveAt,
            request.MinorUnitPrecision,
            null,
            request.Metadata,
            request.AccountingPostedAt,
            request.AccountingMarketId);
        var canonicalHash = CanonicalLedgerRequestHasher.ComputeReversalHash(reversal, request.IdempotencyKey);
        if (!string.Equals(canonicalHash, request.CanonicalRequestHash, StringComparison.Ordinal))
        {
            throw new LedgerUnknownResultException(
                "Stored reversal request canonical evidence does not reproduce; recovery remains fail-closed.");
        }
        return async () =>
            await durableLedgerService.ReverseEntryAsync(
                request.OriginalLedgerEntryId.Value,
                reversal,
                request.IdempotencyKey,
                cancellationToken)
            ?? throw new LedgerPostingOriginalEntryNotFoundException();
    }

    public async Task<LedgerReplayEvidenceDto> ReplayAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        var request = await evidenceRepository.FindByIdAsync(requestId, cancellationToken)
            ?? throw new LedgerPostingRequestNotFoundException();
        if (!request.LedgerEntryId.HasValue)
        {
            throw new LedgerUnknownResultException(
                "Ledger posting request has no completed immutable entry reference.");
        }

        var entry = await ledgerRepository.FindByIdAsync(request.LedgerEntryId.Value, cancellationToken);
        var mismatches = entry is null
            ? new List<string> { "Referenced immutable Ledger entry does not exist." }
            : Verify(request, entry);
        if (entry is not null)
        {
            try
            {
                await journalRepository.VerifyAsync(request, entry, cancellationToken);
            }
            catch (LedgerJournalException error)
            {
                mismatches.Add(error.Message);
            }
        }
        var result = entry is null
            ? LedgerReplayResult.INCONCLUSIVE
            : mismatches.Count == 0 ? LedgerReplayResult.MATCH : LedgerReplayResult.MISMATCH;
        var entryHash = entry?.CanonicalRequestHash ?? "missing";
        var verifiedAt = DateTimeOffset.UtcNow;
        var evidenceHash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["entryHash"] = entryHash,
                ["ledgerEntryId"] = request.LedgerEntryId.Value.ToString("D"),
                ["mismatches"] = mismatches.Order(StringComparer.Ordinal).ToArray(),
                ["postingRequestId"] = request.Id.ToString("D"),
                ["replayResult"] = result.ToString(),
                ["requestHash"] = request.CanonicalRequestHash,
                ["verifiedAt"] = verifiedAt.ToUniversalTime().ToString("O")
            });

        var evidence = await evidenceRepository.AppendReplayEvidenceAsync(
            request.Id,
            request.LedgerEntryId.Value,
            result,
            mismatches,
            request.CanonicalRequestHash,
            entryHash,
            evidenceHash,
            cancellationToken);
        return ToDto(evidence);
    }

    private async Task<LedgerPostingExecutionResult> ExecuteAsync(
        LedgerPostingRequestRecord requested,
        Func<Task<LedgerEntryDto>> post,
        CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        var claim = await evidenceRepository.ClaimAsync(requested, cancellationToken);
        var stored = claim.Request;

        if (!string.Equals(
            stored.CanonicalRequestHash,
            requested.CanonicalRequestHash,
            StringComparison.Ordinal))
        {
            await AppendAttemptAsync(
                stored,
                startedAt,
                DateTimeOffset.UtcNow,
                LedgerPostingAttemptResult.CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                null,
                null,
                cancellationToken);
            throw new LedgerPostingRequestConflictException();
        }

        if (stored.Status == LedgerPostingRequestStatus.COMPLETED && stored.LedgerEntryId.HasValue)
        {
            var completedEntry = await ledgerRepository.FindByIdAsync(
                stored.LedgerEntryId.Value,
                cancellationToken);
            if (completedEntry is null || Verify(stored, completedEntry).Count > 0)
            {
                throw new LedgerUnknownResultException(
                    "Completed Ledger posting request cannot be proven against its immutable entry.");
            }

            var completedJournal = await journalRepository.EnsureAndVerifyAsync(
                stored,
                completedEntry,
                cancellationToken);
            if (stored.JournalTransactionId is null)
            {
                stored = await evidenceRepository.CompleteAsync(
                    stored.Id,
                    completedEntry,
                    completedJournal.Id,
                    cancellationToken);
            }
            else if (stored.JournalTransactionId != completedJournal.Id)
            {
                throw new LedgerUnknownResultException(
                    "Completed Ledger posting request does not reference its balanced journal.");
            }

            await AppendAttemptAsync(
                stored,
                startedAt,
                DateTimeOffset.UtcNow,
                LedgerPostingAttemptResult.REUSED,
                "COMPLETED_REQUEST_REUSED",
                completedEntry.Id.ToString(),
                completedEntry.CanonicalRequestHash,
                cancellationToken);
            return new LedgerPostingExecutionResult(ToEntryDto(completedEntry), ToDto(stored));
        }

        try
        {
            var entryDto = await post();
            var entry = await ledgerRepository.FindByIdAsync(entryDto.Id, cancellationToken)
                ?? throw new LedgerUnknownResultException(
                    "Authoritative Ledger entry could not be read back after posting.");
            var mismatches = Verify(stored, entry);
            if (mismatches.Count > 0)
            {
                throw new LedgerUnknownResultException(string.Join(" ", mismatches));
            }

            var journal = await journalRepository.EnsureAndVerifyAsync(stored, entry, cancellationToken);
            var completed = await evidenceRepository.CompleteAsync(
                stored.Id,
                entry,
                journal.Id,
                cancellationToken);
            await AppendAttemptAsync(
                completed,
                startedAt,
                DateTimeOffset.UtcNow,
                claim.Created
                    ? LedgerPostingAttemptResult.SUCCEEDED
                    : LedgerPostingAttemptResult.REUSED,
                claim.Created ? null : "IDEMPOTENT_RETRY",
                entry.Id.ToString(),
                entry.CanonicalRequestHash,
                cancellationToken);
            return new LedgerPostingExecutionResult(entryDto, ToDto(completed));
        }
        catch (Exception error)
        {
            var failure = error;
            var existingEntry = await ledgerRepository.FindByIdempotencyKeyAsync(
                stored.IdempotencyKey,
                cancellationToken);
            if (existingEntry is not null && Verify(stored, existingEntry).Count == 0)
            {
                try
                {
                    var journal = await journalRepository.EnsureAndVerifyAsync(
                        stored,
                        existingEntry,
                        cancellationToken);
                    var completed = await evidenceRepository.CompleteAsync(
                        stored.Id,
                        existingEntry,
                        journal.Id,
                        cancellationToken);
                    await AppendAttemptAsync(
                        completed,
                        startedAt,
                        DateTimeOffset.UtcNow,
                        LedgerPostingAttemptResult.REUSED,
                        "RECOVERED_AFTER_POST_RESPONSE_FAILURE",
                        existingEntry.Id.ToString(),
                        existingEntry.CanonicalRequestHash,
                        cancellationToken);
                    return new LedgerPostingExecutionResult(ToEntryDto(existingEntry), ToDto(completed));
                }
                catch (LedgerJournalException journalError)
                {
                    failure = journalError;
                }
            }

            var knownFailure = IsKnownFailure(failure);
            var status = knownFailure
                ? LedgerPostingRequestStatus.FAILED
                : LedgerPostingRequestStatus.UNKNOWN;
            var result = knownFailure
                ? LedgerPostingAttemptResult.FAILED
                : LedgerPostingAttemptResult.UNKNOWN;
            await evidenceRepository.RecordStatusAsync(
                stored.Id,
                status,
                failure.GetType().Name,
                failure.Message,
                cancellationToken);
            await AppendAttemptAsync(
                stored,
                startedAt,
                DateTimeOffset.UtcNow,
                result,
                knownFailure ? "BUSINESS_OR_VALIDATION_FAILURE" : "RESULT_UNPROVEN",
                null,
                null,
                cancellationToken);
            if (failure is LedgerJournalException)
            {
                throw new LedgerUnknownResultException(failure.Message);
            }

            throw;
        }
    }

    private async Task AppendAttemptAsync(
        LedgerPostingRequestRecord request,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt,
        LedgerPostingAttemptResult result,
        string? failureClassification,
        string? targetResponseReference,
        string? responseHash,
        CancellationToken cancellationToken)
    {
        var evidenceHash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["buildProvenance"] = buildProvenance,
                ["completedAt"] = completedAt.ToUniversalTime().ToString("O"),
                ["failureClassification"] = failureClassification,
                ["postingRequestId"] = request.Id.ToString("D"),
                ["requestHash"] = request.CanonicalRequestHash,
                ["responseHash"] = responseHash,
                ["result"] = result.ToString(),
                ["runtimeProvenance"] = runtimeProvenance,
                ["startedAt"] = startedAt.ToUniversalTime().ToString("O"),
                ["targetResponseReference"] = targetResponseReference
            });
        await evidenceRepository.AppendAttemptAsync(
            request.Id,
            startedAt,
            completedAt,
            result,
            failureClassification,
            targetResponseReference,
            responseHash,
            runtimeProvenance,
            buildProvenance,
            evidenceHash,
            cancellationToken);
    }

    private static LedgerPostingRequestRecord BuildRequest(
        CreateLedgerEntryRequest request,
        string idempotencyKey,
        string correlationId,
        FinancialPostingRule rule,
        LedgerAccountingPeriodContext accounting)
    {
        var metadata = request.Metadata is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(request.Metadata);
        metadata["correlationId"] = correlationId;
        metadata["referenceType"] = request.Reference?.Type;
        metadata["referenceId"] = request.Reference?.Id;
        metadata["postingRuleId"] = rule.RuleId;
        metadata["postingRuleVersion"] = rule.Version;
        metadata["postingRuleContentHash"] = rule.ContentHash;
        metadata["debitAccountRole"] = rule.DebitAccountRole;
        metadata["creditAccountRole"] = rule.CreditAccountRole;
        return new LedgerPostingRequestRecord(
            Guid.NewGuid(),
            "POSTING",
            request.InstructionId,
            request.InstructionType,
            request.InstructionHash,
            request.OriginatingAuthority,
            request.SettlementRecordId,
            request.WalletId,
            request.LedgerAccountId,
            request.Direction,
            request.Money.Amount,
            request.Money.Currency,
            request.MinorUnitPrecision,
            request.TransactionType,
            idempotencyKey,
            request.CanonicalRequestHash,
            request.EffectiveAt,
            accounting.AccountingPostedAt,
            accounting.BrandId,
            accounting.MarketId,
            accounting.OriginalAccountingPeriodId,
            accounting.PostingAccountingPeriodId,
            request.ReversalOfLedgerEntryId,
            null,
            LedgerPostingRequestStatus.CLAIMED,
            DateTimeOffset.UtcNow,
            null,
            null,
            null,
            null,
            null,
            null,
            metadata);
    }

    private static CreateLedgerEntryRequest ApplyAccountingContext(
        CreateLedgerEntryRequest request,
        LedgerAccountingPeriodContext accounting)
    {
        var metadata = request.Metadata is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(request.Metadata);
        AddAccountingMetadata(metadata, accounting);
        return request with
        {
            AccountingPostedAt = accounting.AccountingPostedAt,
            AccountingMarketId = accounting.MarketId,
            Metadata = metadata
        };
    }

    private static ReverseLedgerEntryRequest ApplyAccountingContext(
        ReverseLedgerEntryRequest request,
        LedgerAccountingPeriodContext accounting)
    {
        var metadata = request.Metadata is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(request.Metadata);
        AddAccountingMetadata(metadata, accounting);
        return request with
        {
            AccountingPostedAt = accounting.AccountingPostedAt,
            AccountingMarketId = accounting.MarketId,
            Metadata = metadata
        };
    }

    private static void AddAccountingMetadata(
        IDictionary<string, object?> metadata,
        LedgerAccountingPeriodContext accounting)
    {
        metadata["accountingBrandId"] = accounting.BrandId;
        metadata["accountingMarketId"] = accounting.MarketId;
        metadata["accountingPostedAt"] = accounting.AccountingPostedAt;
        metadata["originalAccountingPeriodId"] = accounting.OriginalAccountingPeriodId;
        metadata["postingAccountingPeriodId"] = accounting.PostingAccountingPeriodId;
    }

    private static LedgerPostingRequestRecord BuildRequest(
        ReverseLedgerEntryRequest request,
        string idempotencyKey,
        string correlationId,
        LedgerAccountingPeriodContext accounting)
    {
        var metadata = request.Metadata is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(request.Metadata);
        metadata["correlationId"] = correlationId;
        metadata["reasonCode"] = request.ReasonCode;
        metadata["reversalPolicyVersion"] = request.ReversalPolicyVersion;
        return new LedgerPostingRequestRecord(
            Guid.NewGuid(),
            "REVERSAL",
            request.InstructionId,
            request.InstructionType,
            request.InstructionHash,
            request.OriginatingAuthority,
            null,
            request.WalletId,
            request.LedgerAccountId,
            request.Direction,
            request.Money.Amount,
            request.Money.Currency,
            request.MinorUnitPrecision,
            LedgerTransactionType.REVERSAL,
            idempotencyKey,
            request.CanonicalReversalHash,
            request.EffectiveAt,
            accounting.AccountingPostedAt,
            accounting.BrandId,
            accounting.MarketId,
            accounting.OriginalAccountingPeriodId,
            accounting.PostingAccountingPeriodId,
            request.OriginalLedgerEntryId,
            request.OriginalLedgerEntryHash,
            LedgerPostingRequestStatus.CLAIMED,
            DateTimeOffset.UtcNow,
            null,
            null,
            null,
            null,
            null,
            null,
            metadata);
    }

    private static List<string> Verify(
        LedgerPostingRequestRecord request,
        DurableLedgerEntry entry)
    {
        var mismatches = new List<string>();
        Compare(mismatches, "canonical request hash", request.CanonicalRequestHash, entry.CanonicalRequestHash);
        Compare(mismatches, "wallet", request.WalletId, entry.WalletId);
        if (request.LedgerAccountId.HasValue)
        {
            Compare(mismatches, "account", request.LedgerAccountId.Value, entry.AccountId);
        }
        Compare(mismatches, "amount", request.Amount, entry.Amount);
        Compare(mismatches, "currency", request.Currency, entry.CurrencyCode);
        Compare(mismatches, "direction", request.Direction, entry.Direction);
        Compare(mismatches, "transaction type", request.TransactionType, entry.TransactionType);
        Compare(mismatches, "idempotency key", request.IdempotencyKey, entry.IdempotencyKey);
        Compare(mismatches, "original entry", request.OriginalLedgerEntryId, entry.ReversalOfLedgerEntryId);
        Compare(mismatches, "original entry hash", request.OriginalLedgerEntryHash, entry.OriginalLedgerEntryHash);
        Compare(mismatches, "instruction id", request.InstructionId, MetadataString(entry.Metadata, "instructionId"));
        Compare(mismatches, "instruction type", request.InstructionType, MetadataString(entry.Metadata, "instructionType"));
        Compare(mismatches, "instruction hash", request.InstructionHash, MetadataString(entry.Metadata, "instructionHash"));
        Compare(mismatches, "originating authority", request.OriginatingAuthority, MetadataString(entry.Metadata, "originatingAuthority"));

        var effectiveAt = MetadataString(entry.Metadata, "effectiveAt");
        if (!DateTimeOffset.TryParse(effectiveAt, out var storedEffectiveAt)
            || ToPostgresTimestamp(storedEffectiveAt) != ToPostgresTimestamp(request.EffectiveAt))
        {
            mismatches.Add("Effective timestamp does not match.");
        }

        return mismatches;
    }

    private static DateTimeOffset ToPostgresTimestamp(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return new DateTimeOffset(utc.Ticks - (utc.Ticks % 10), TimeSpan.Zero);
    }

    private static string? MetadataString(
        IReadOnlyDictionary<string, object?> metadata,
        string key)
    {
        if (!metadata.TryGetValue(key, out var value) || value is null)
        {
            return null;
        }

        return value is JsonElement element
            ? element.ValueKind == JsonValueKind.String ? element.GetString() : element.ToString()
            : value.ToString();
    }

    private static void Compare<T>(List<string> mismatches, string field, T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            mismatches.Add($"{field} does not match.");
        }
    }

    private static bool IsKnownFailure(Exception error)
    {
        return DurableLedgerService.IsBusinessRuleError(error)
            || error is DurableLedgerRepositoryException
                or DurableLedgerIdempotencyConflictException
                or DurableLedgerReversalConflictException
                or LedgerAccountingPeriodException
                or LedgerPostingOriginalEntryNotFoundException;
    }

    private static LedgerPostingRequestDto ToDto(LedgerPostingRequestRecord request)
    {
        return new LedgerPostingRequestDto(
            request.Id,
            request.RequestKind,
            request.InstructionId,
            request.InstructionType,
            request.InstructionHash,
            request.OriginatingAuthority,
            request.SettlementRecordId,
            request.WalletId,
            request.LedgerAccountId,
            request.Direction,
            new MoneyDto(request.Amount, request.Currency),
            request.MinorUnitPrecision,
            request.TransactionType,
            request.IdempotencyKey,
            request.CanonicalRequestHash,
            request.EffectiveAt,
            request.AccountingPostedAt,
            request.AccountingBrandId,
            request.AccountingMarketId,
            request.OriginalAccountingPeriodId,
            request.PostingAccountingPeriodId,
            request.OriginalLedgerEntryId,
            request.OriginalLedgerEntryHash,
            request.Status,
            request.CreatedAt,
            request.CompletedAt,
            request.FailureCode,
            request.FailureReason,
            request.LedgerEntryId,
            request.LedgerEntryHash,
            request.JournalTransactionId,
            request.Metadata);
    }

    private static LedgerPostingAttemptDto ToDto(LedgerPostingAttemptRecord attempt)
    {
        return new LedgerPostingAttemptDto(
            attempt.Id,
            attempt.PostingRequestId,
            attempt.AttemptNumber,
            attempt.StartedAt,
            attempt.CompletedAt,
            attempt.Result,
            attempt.FailureClassification,
            attempt.TargetResponseReference,
            attempt.ResponseHash,
            attempt.RuntimeProvenance,
            attempt.BuildProvenance,
            attempt.CanonicalEvidenceHash,
            attempt.CreatedAt);
    }

    private static LedgerReplayEvidenceDto ToDto(LedgerReplayEvidenceRecord evidence)
    {
        return new LedgerReplayEvidenceDto(
            evidence.Id,
            evidence.PostingRequestId,
            evidence.LedgerEntryId,
            evidence.Result,
            evidence.Mismatches,
            evidence.RequestHash,
            evidence.EntryHash,
            evidence.CanonicalEvidenceHash,
            evidence.VerifiedAt);
    }

    private static LedgerEntryDto ToEntryDto(DurableLedgerEntry entry)
    {
        return new LedgerEntryDto(
            entry.Id,
            entry.WalletId,
            entry.AccountId,
            entry.TransactionType,
            entry.Direction,
            new MoneyDto(entry.Amount, entry.CurrencyCode),
            new MoneyDto(entry.BalanceAfter, entry.CurrencyCode),
            entry.ReferenceType is null && entry.ReferenceId is null
                ? null
                : new LedgerReferenceDto(entry.ReferenceType, entry.ReferenceId),
            entry.IdempotencyKey,
            entry.CanonicalRequestHash,
            entry.ReversalOfLedgerEntryId,
            entry.OriginalLedgerEntryHash,
            entry.ReversalReasonCode,
            entry.ReversalPolicyVersion,
            entry.CanonicalReversalHash,
            entry.Metadata,
            entry.CreatedAt);
    }

    private sealed class LedgerPostingOriginalEntryNotFoundException : Exception;
}

public sealed class LedgerPostingRequestConflictException : Exception;

public sealed class LedgerPostingRequestNotFoundException : Exception;

public sealed class LedgerUnknownResultException : Exception
{
    public LedgerUnknownResultException(string message)
        : base(message)
    {
    }
}
