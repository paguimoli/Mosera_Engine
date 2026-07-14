using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace SettlementService.Infrastructure;

public sealed record ResettlementSettlementRequestContext(
    Guid SettlementRequestId,
    string IdempotencyKey,
    Guid SettlementInputId,
    string SettlementInputHash,
    Guid MathEvaluationCertificateId,
    string MathEvaluationCertificateHash,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string TicketId,
    string TicketLineId,
    string PlayerAccountReference,
    string AcceptedWagerFinancialContextReference,
    long AcceptedStakeAmountMinor,
    string Currency,
    int MinorUnitPrecision,
    string RoundingPolicyReference,
    string? CreditReservationReference,
    string SettlementPolicyVersion,
    DateTimeOffset AcceptedAt);

public sealed class ResettlementRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<ResettlementRequestDto?> GetRequestAsync(Guid requestId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select * from settlement_service.resettlement_requests where resettlement_request_id = @id;";
        command.Parameters.AddWithValue("id", requestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRequest(reader) : null;
    }

    public async Task<ResettlementChainDto?> GetChainAsync(Guid requestId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select * from settlement_service.resettlement_records where resettlement_request_id = @id;";
        command.Parameters.AddWithValue("id", requestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapChain(reader) : null;
    }

    public async Task<IReadOnlyList<ResettlementEventDto>> ListEventsAsync(Guid requestId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.resettlement_events
where resettlement_request_id = @id
order by created_at asc;
""";
        command.Parameters.AddWithValue("id", requestId);
        var events = new List<ResettlementEventDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            events.Add(MapEvent(reader));
        }

        return events;
    }

    public async Task<ResettlementSettlementRequestContext?> GetSettlementRequestContextAsync(
        Guid settlementRequestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  settlement_request_id,
  idempotency_key,
  settlement_input_id,
  settlement_input_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_id,
  ticket_line_id,
  player_account_reference,
  accepted_wager_financial_context_reference,
  accepted_stake_amount_minor,
  currency,
  minor_unit_precision,
  rounding_policy_reference,
  credit_reservation_reference,
  settlement_policy_version,
  accepted_at
from settlement_service.settlement_requests
where settlement_request_id = @settlement_request_id;
""";
        command.Parameters.AddWithValue("settlement_request_id", settlementRequestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var creditOrdinal = reader.GetOrdinal("credit_reservation_reference");
        return new ResettlementSettlementRequestContext(
            reader.GetGuid(reader.GetOrdinal("settlement_request_id")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetGuid(reader.GetOrdinal("settlement_input_id")),
            reader.GetString(reader.GetOrdinal("settlement_input_hash")),
            reader.GetGuid(reader.GetOrdinal("math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("math_evaluation_certificate_hash")),
            reader.GetGuid(reader.GetOrdinal("outcome_certificate_id")),
            reader.GetString(reader.GetOrdinal("outcome_certificate_hash")),
            reader.GetString(reader.GetOrdinal("ticket_id")),
            reader.GetString(reader.GetOrdinal("ticket_line_id")),
            reader.GetString(reader.GetOrdinal("player_account_reference")),
            reader.GetString(reader.GetOrdinal("accepted_wager_financial_context_reference")),
            reader.GetInt64(reader.GetOrdinal("accepted_stake_amount_minor")),
            reader.GetString(reader.GetOrdinal("currency")),
            reader.GetInt32(reader.GetOrdinal("minor_unit_precision")),
            reader.GetString(reader.GetOrdinal("rounding_policy_reference")),
            reader.IsDBNull(creditOrdinal) ? null : reader.GetString(creditOrdinal),
            reader.GetString(reader.GetOrdinal("settlement_policy_version")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("accepted_at")));
    }

    public async Task<(ResettlementRequestDto Request, ResettlementEventDto Event, bool Duplicate)> ClaimRequestAsync(
        ResettlementCreateRequest request,
        string canonicalRequestHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await GetRequestByIdempotencyAsync(connection, transaction, request.IdempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalRequestHash, canonicalRequestHash, StringComparison.Ordinal))
            {
                var conflict = await AppendEventAsync(
                    connection,
                    transaction,
                    existing.ResettlementRequestId,
                    null,
                    ResettlementLifecycleState.Failed,
                    "Conflict",
                    ["Conflicting canonical resettlement request hash for idempotency key."],
                    cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                throw new SettlementExecutionConflictException("Conflicting resettlement payload for the same idempotency key.");
            }

            var reused = await AppendEventAsync(
                connection,
                transaction,
                existing.ResettlementRequestId,
                null,
                ResettlementLifecycleState.Requested,
                "DuplicateRequestReused",
                [],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return (existing, reused, true);
        }

        var requestId = request.ResettlementRequestId ??
            CreateDeterministicGuid($"{request.IdempotencyKey}:{canonicalRequestHash}");
        await using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
insert into settlement_service.resettlement_requests (
  resettlement_request_id,
  idempotency_key,
  canonical_request_hash,
  original_settlement_id,
  original_settlement_hash,
  original_settlement_input_id,
  original_settlement_input_hash,
  corrected_settlement_input_id,
  corrected_settlement_input_hash,
  original_math_evaluation_certificate_id,
  original_math_evaluation_certificate_hash,
  corrected_math_evaluation_certificate_id,
  corrected_math_evaluation_certificate_hash,
  reason_code,
  requestor_reference,
  approval_metadata,
  requested_at,
  provenance,
  mode
)
values (
  @resettlement_request_id,
  @idempotency_key,
  @canonical_request_hash,
  @original_settlement_id,
  @original_settlement_hash,
  @original_settlement_input_id,
  @original_settlement_input_hash,
  @corrected_settlement_input_id,
  @corrected_settlement_input_hash,
  @original_math_evaluation_certificate_id,
  @original_math_evaluation_certificate_hash,
  @corrected_math_evaluation_certificate_id,
  @corrected_math_evaluation_certificate_hash,
  @reason_code,
  @requestor_reference,
  cast(@approval_metadata as jsonb),
  @requested_at,
  cast(@provenance as jsonb),
  @mode
);
""";
        insert.Parameters.AddWithValue("resettlement_request_id", requestId);
        insert.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        insert.Parameters.AddWithValue("canonical_request_hash", canonicalRequestHash);
        insert.Parameters.AddWithValue("original_settlement_id", request.OriginalSettlementId);
        insert.Parameters.AddWithValue("original_settlement_hash", request.OriginalSettlementHash);
        insert.Parameters.AddWithValue("original_settlement_input_id", request.OriginalSettlementInputId);
        insert.Parameters.AddWithValue("original_settlement_input_hash", request.OriginalSettlementInputHash);
        insert.Parameters.AddWithValue("corrected_settlement_input_id", request.CorrectedSettlementInputId);
        insert.Parameters.AddWithValue("corrected_settlement_input_hash", request.CorrectedSettlementInputHash);
        insert.Parameters.AddWithValue("original_math_evaluation_certificate_id", request.OriginalMathEvaluationCertificateId);
        insert.Parameters.AddWithValue("original_math_evaluation_certificate_hash", request.OriginalMathEvaluationCertificateHash);
        insert.Parameters.AddWithValue("corrected_math_evaluation_certificate_id", request.CorrectedMathEvaluationCertificateId);
        insert.Parameters.AddWithValue("corrected_math_evaluation_certificate_hash", request.CorrectedMathEvaluationCertificateHash);
        insert.Parameters.AddWithValue("reason_code", request.ReasonCode);
        insert.Parameters.AddWithValue("requestor_reference", request.RequestorReference);
        insert.Parameters.AddWithValue("approval_metadata", JsonSerializer.Serialize(request.ApprovalMetadata ?? new Dictionary<string, object?>(), JsonOptions));
        insert.Parameters.AddWithValue("requested_at", request.RequestedAt);
        insert.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(request.Provenance ?? new Dictionary<string, object?>(), JsonOptions));
        insert.Parameters.AddWithValue("mode", request.Mode.ToString());
        await insert.ExecuteNonQueryAsync(cancellationToken);

        var inserted = await GetRequestAsync(connection, transaction, requestId, cancellationToken)
            ?? throw new InvalidOperationException("Resettlement request insert did not read back.");
        var ev = await AppendEventAsync(
            connection,
            transaction,
            inserted.ResettlementRequestId,
            null,
            ResettlementLifecycleState.Requested,
            "Requested",
            [],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return (inserted, ev, false);
    }

    public async Task<ResettlementEventDto> AppendEventAsync(
        Guid requestId,
        Guid? recordId,
        ResettlementLifecycleState state,
        string eventType,
        IReadOnlyList<string> errors,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var ev = await AppendEventAsync(connection, transaction, requestId, recordId, state, eventType, errors, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return ev;
    }

    public async Task<ResettlementChainDto> CreateChainAsync(
        ResettlementRequestDto request,
        SettlementRecordResponse original,
        SettlementRecordResponse reversal,
        SettlementRecordResponse corrected,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await GetChainAsync(connection, transaction, request.ResettlementRequestId, cancellationToken);
        if (existing is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return existing;
        }

        var recordId = CreateDeterministicGuid($"resettlement-record:{request.ResettlementRequestId:N}");
        var chainHash = SettlementExecutionService.HashCanonical(
            $"{request.ResettlementRequestId:N}|{original.SettlementId:N}|{original.CanonicalSettlementHash}|{reversal.SettlementId:N}|{reversal.CanonicalSettlementHash}|{corrected.SettlementId:N}|{corrected.CanonicalSettlementHash}");
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.resettlement_records (
  resettlement_record_id,
  resettlement_request_id,
  lifecycle_state,
  original_settlement_id,
  original_settlement_hash,
  original_settlement_input_id,
  reversal_settlement_id,
  reversal_settlement_hash,
  corrected_settlement_input_id,
  corrected_settlement_id,
  corrected_settlement_hash,
  chain_hash
)
values (
  @resettlement_record_id,
  @resettlement_request_id,
  'Completed',
  @original_settlement_id,
  @original_settlement_hash,
  @original_settlement_input_id,
  @reversal_settlement_id,
  @reversal_settlement_hash,
  @corrected_settlement_input_id,
  @corrected_settlement_id,
  @corrected_settlement_hash,
  @chain_hash
);
""";
        command.Parameters.AddWithValue("resettlement_record_id", recordId);
        command.Parameters.AddWithValue("resettlement_request_id", request.ResettlementRequestId);
        command.Parameters.AddWithValue("original_settlement_id", original.SettlementId);
        command.Parameters.AddWithValue("original_settlement_hash", original.CanonicalSettlementHash);
        command.Parameters.AddWithValue("original_settlement_input_id", original.SettlementInputId);
        command.Parameters.AddWithValue("reversal_settlement_id", reversal.SettlementId);
        command.Parameters.AddWithValue("reversal_settlement_hash", reversal.CanonicalSettlementHash);
        command.Parameters.AddWithValue("corrected_settlement_input_id", corrected.SettlementInputId);
        command.Parameters.AddWithValue("corrected_settlement_id", corrected.SettlementId);
        command.Parameters.AddWithValue("corrected_settlement_hash", corrected.CanonicalSettlementHash);
        command.Parameters.AddWithValue("chain_hash", chainHash);
        await command.ExecuteNonQueryAsync(cancellationToken);

        var chain = await GetChainAsync(connection, transaction, request.ResettlementRequestId, cancellationToken)
            ?? throw new InvalidOperationException("Resettlement chain insert did not read back.");
        await AppendEventAsync(connection, transaction, request.ResettlementRequestId, chain.ResettlementRecordId, ResettlementLifecycleState.Completed, "Completed", [], cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return chain;
    }

    public async Task<SettlementRecordResponse> CreateReversalRecordAsync(
        ResettlementRequestDto request,
        SettlementRecordResponse original,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var reversalRequestId = CreateDeterministicGuid($"resettlement-reversal-request:{request.ResettlementRequestId:N}");
        var existing = await GetRecordByRequestIdAsync(connection, transaction, reversalRequestId, cancellationToken);
        if (existing is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return existing;
        }

        var reversalId = CreateDeterministicGuid($"resettlement-reversal-settlement:{request.ResettlementRequestId:N}:{original.SettlementId:N}");
        await InsertReversalSettlementRequestAsync(
            connection,
            transaction,
            reversalRequestId,
            request,
            original,
            cancellationToken);
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["resettlementRequestId"] = request.ResettlementRequestId,
            ["resettlementRole"] = "reversal",
            ["originalSettlementId"] = original.SettlementId,
            ["originalSettlementHash"] = original.CanonicalSettlementHash,
            ["policyVersion"] = $"{original.PolicyVersion}:reversal-v1"
        };
        var canonicalHash = SettlementExecutionService.HashCanonical(JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["resettlementRequestId"] = request.ResettlementRequestId,
            ["settlementId"] = reversalId,
            ["originalSettlementId"] = original.SettlementId,
            ["originalSettlementHash"] = original.CanonicalSettlementHash,
            ["netResultAmountMinor"] = -original.NetResultAmountMinor,
            ["policyVersion"] = $"{original.PolicyVersion}:reversal-v1"
        }, JsonOptions));
        await InsertSettlementRecordAsync(
            connection,
            transaction,
            reversalId,
            reversalRequestId,
            original.SettlementInputId,
            original.SettlementInputHash,
            original.MathEvaluationCertificateId,
            original.MathEvaluationCertificateHash,
            original.OutcomeCertificateId,
            original.OutcomeCertificateHash,
            original.TicketId,
            original.TicketLineId,
            original.PlayerAccountReference,
            original.Currency,
            original.MinorUnitPrecision,
            0,
            0,
            -original.NetResultAmountMinor,
            "VOID",
            $"{original.PolicyVersion}:reversal-v1",
            canonicalHash,
            $"resettlement-reversal:{request.ResettlementRequestId:N}",
            provenance,
            cancellationToken);
        var inserted = await GetRecordByRequestIdAsync(connection, transaction, reversalRequestId, cancellationToken)
            ?? throw new InvalidOperationException("Reversal SettlementRecord insert did not read back.");
        await AppendEventAsync(connection, transaction, request.ResettlementRequestId, null, ResettlementLifecycleState.ReversalPrepared, "ReversalPrepared", [], cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return inserted;
    }

    public async Task InsertReversalInstructionsAsync(
        ResettlementRequestDto request,
        SettlementRecordResponse original,
        SettlementRecordResponse reversal,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await CountInstructionsAsync(connection, transaction, reversal.SettlementId, cancellationToken);
        if (existing > 0)
        {
            await transaction.CommitAsync(cancellationToken);
            return;
        }

        var definitions = BuildReversalDefinitions(request, original, reversal);
        foreach (var definition in definitions)
        {
            await InsertInstructionAsync(connection, transaction, reversal, definition, cancellationToken);
        }

        await AppendEventAsync(connection, transaction, request.ResettlementRequestId, null, ResettlementLifecycleState.ReversalExecuting, "ReversalInstructionsGenerated", [], cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<bool> HasFinancialExecutionAsync(Guid settlementId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select exists (
  select 1
  from settlement_service.financial_instruction_execution_attempts
  where settlement_id = @settlement_id
    and status = 'Posted'
);
""";
        command.Parameters.AddWithValue("settlement_id", settlementId);
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    public async Task<ResettlementReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return new ResettlementReadiness(false, false, false, false, false, false, false, true, ["DATABASE_URL is not configured for resettlement."]);
        }

        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('settlement_service.resettlement_requests') is not null
  and to_regclass('settlement_service.resettlement_records') is not null
  and to_regclass('settlement_service.resettlement_events') is not null
  and to_regclass('settlement_service.authoritative_settlement_records') is not null
  and to_regclass('settlement_service.financial_instructions') is not null;
""";
            var ready = await command.ExecuteScalarAsync(cancellationToken) is true;
            return new ResettlementReadiness(true, ready, ready, ready, ready, ready, ready, true, ready ? [] : ["Resettlement tables are missing."]);
        }
        catch (Exception error) when (error is NpgsqlException or InvalidOperationException or OperationCanceledException)
        {
            return new ResettlementReadiness(true, false, false, false, false, false, false, true, [error.Message]);
        }
    }

    private static IReadOnlyList<FinancialInstructionDefinition> BuildReversalDefinitions(
        ResettlementRequestDto request,
        SettlementRecordResponse original,
        SettlementRecordResponse reversal)
    {
        var ledgerType = original.NetResultAmountMinor == 0 ? FinancialInstructionType.LEDGER_NOOP : FinancialInstructionType.LEDGER_REVERSAL;
        var creditType = original.NetResultAmountMinor == 0 ? FinancialInstructionType.CREDIT_NOOP : FinancialInstructionType.CREDIT_REFUND;
        return
        [
            BuildInstruction(request, reversal, ledgerType, "ledger-service", 1),
            BuildInstruction(request, reversal, creditType, "credit-wallet-service", 2)
        ];
    }

    private static FinancialInstructionDefinition BuildInstruction(
        ResettlementRequestDto request,
        SettlementRecordResponse reversal,
        FinancialInstructionType instructionType,
        string targetService,
        int sequence)
    {
        var instructionId = CreateDeterministicGuid($"resettlement-instruction:{request.ResettlementRequestId:N}:{reversal.SettlementId:N}:{instructionType}");
        var status = instructionType is FinancialInstructionType.LEDGER_NOOP or FinancialInstructionType.CREDIT_NOOP
            ? FinancialInstructionStatus.Skipped
            : FinancialInstructionStatus.Ready;
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["resettlementRequestId"] = request.ResettlementRequestId,
            ["resettlementRole"] = "reversal",
            ["originalSettlementId"] = request.OriginalSettlementId,
            ["stateTransition"] = status == FinancialInstructionStatus.Ready ? "Pending->Ready" : "Pending->Skipped"
        };
        var canonicalPayloadHash = FinancialInstructionService.HashCanonical(JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["instructionId"] = instructionId,
            ["instructionType"] = instructionType.ToString(),
            ["netResultAmountMinor"] = reversal.NetResultAmountMinor,
            ["originalSettlementId"] = request.OriginalSettlementId,
            ["resettlementRequestId"] = request.ResettlementRequestId,
            ["settlementId"] = reversal.SettlementId,
            ["targetService"] = targetService
        }, JsonOptions));

        return new FinancialInstructionDefinition(
            instructionId,
            instructionType,
            status,
            targetService,
            sequence,
            Math.Abs(reversal.NetResultAmountMinor),
            canonicalPayloadHash,
            $"resettlement-reversal-instruction:{request.ResettlementRequestId:N}:{instructionType}",
            provenance);
    }

    private static async Task InsertInstructionAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        SettlementRecordResponse settlementRecord,
        FinancialInstructionDefinition definition,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.financial_instructions (
  instruction_id,
  settlement_id,
  settlement_request_id,
  instruction_type,
  instruction_status,
  canonical_payload_hash,
  idempotency_key,
  target_service,
  instruction_sequence,
  attempt_count,
  created_at,
  completed_at,
  failure_reason,
  provenance
)
values (
  @instruction_id,
  @settlement_id,
  @settlement_request_id,
  @instruction_type,
  @instruction_status,
  @canonical_payload_hash,
  @idempotency_key,
  @target_service,
  @instruction_sequence,
  1,
  now(),
  null,
  null,
  cast(@provenance as jsonb)
);
""";
        command.Parameters.AddWithValue("instruction_id", definition.InstructionId);
        command.Parameters.AddWithValue("settlement_id", settlementRecord.SettlementId);
        command.Parameters.AddWithValue("settlement_request_id", settlementRecord.SettlementRequestId);
        command.Parameters.AddWithValue("instruction_type", definition.InstructionType.ToString());
        command.Parameters.AddWithValue("instruction_status", definition.InstructionStatus.ToString());
        command.Parameters.AddWithValue("canonical_payload_hash", definition.CanonicalPayloadHash);
        command.Parameters.AddWithValue("idempotency_key", definition.IdempotencyKey);
        command.Parameters.AddWithValue("target_service", definition.TargetService);
        command.Parameters.AddWithValue("instruction_sequence", definition.InstructionSequence);
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(definition.Provenance, JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertReversalSettlementRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid reversalRequestId,
        ResettlementRequestDto request,
        SettlementRecordResponse original,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.settlement_requests (
  settlement_request_id,
  idempotency_key,
  canonical_request_hash,
  settlement_input_id,
  settlement_input_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_id,
  ticket_line_id,
  player_account_reference,
  accepted_wager_financial_context_reference,
  accepted_stake_amount_minor,
  currency,
  minor_unit_precision,
  rounding_policy_reference,
  credit_reservation_reference,
  settlement_policy_version,
  accepted_at,
  mode,
  status,
  request_provenance
)
select
  @reversal_request_id,
  @idempotency_key,
  @canonical_request_hash,
  settlement_input_id,
  settlement_input_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_id,
  ticket_line_id,
  player_account_reference,
  accepted_wager_financial_context_reference,
  0,
  currency,
  minor_unit_precision,
  rounding_policy_reference,
  credit_reservation_reference,
  settlement_policy_version || ':resettlement-reversal-v1',
  accepted_at,
  'DryRun',
  'Accepted',
  jsonb_build_object(
    'source', 'resettlement-reversal',
    'resettlementRequestId', @resettlement_request_id::text,
    'originalSettlementId', @original_settlement_id::text,
    'originalSettlementHash', @original_settlement_hash
  )
from settlement_service.settlement_requests
where settlement_request_id = @original_request_id
on conflict (settlement_request_id) do nothing;
""";
        command.Parameters.AddWithValue("reversal_request_id", reversalRequestId);
        command.Parameters.AddWithValue("idempotency_key", $"resettlement-reversal:{request.ResettlementRequestId:N}");
        command.Parameters.AddWithValue("canonical_request_hash", SettlementExecutionService.HashCanonical(
            $"resettlement-reversal-request|{request.ResettlementRequestId:N}|{original.SettlementId:N}|{original.CanonicalSettlementHash}"));
        command.Parameters.AddWithValue("resettlement_request_id", request.ResettlementRequestId);
        command.Parameters.AddWithValue("original_settlement_id", original.SettlementId);
        command.Parameters.AddWithValue("original_settlement_hash", original.CanonicalSettlementHash);
        command.Parameters.AddWithValue("original_request_id", original.SettlementRequestId);
        var inserted = await command.ExecuteNonQueryAsync(cancellationToken);
        if (inserted == 0)
        {
            await using var verify = connection.CreateCommand();
            verify.Transaction = transaction;
            verify.CommandText = "select 1 from settlement_service.settlement_requests where settlement_request_id = @id;";
            verify.Parameters.AddWithValue("id", reversalRequestId);
            if (await verify.ExecuteScalarAsync(cancellationToken) is null)
            {
                throw new InvalidOperationException("Original settlement request was not found for reversal request creation.");
            }
        }
    }

    private static async Task<int> CountInstructionsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid settlementId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select count(*) from settlement_service.financial_instructions where settlement_id = @id;";
        command.Parameters.AddWithValue("id", settlementId);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    private static async Task InsertSettlementRecordAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid settlementId,
        Guid settlementRequestId,
        Guid settlementInputId,
        string settlementInputHash,
        Guid mathEvaluationCertificateId,
        string mathEvaluationCertificateHash,
        Guid outcomeCertificateId,
        string outcomeCertificateHash,
        string ticketId,
        string ticketLineId,
        string playerAccountReference,
        string currency,
        int minorUnitPrecision,
        long stakeAmountMinor,
        long grossPayoutAmountMinor,
        long netResultAmountMinor,
        string settlementOutcome,
        string policyVersion,
        string canonicalSettlementHash,
        string idempotencyKey,
        IReadOnlyDictionary<string, object?> provenance,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.authoritative_settlement_records (
  settlement_id, settlement_request_id, settlement_input_id, settlement_input_hash,
  math_evaluation_certificate_id, math_evaluation_certificate_hash,
  outcome_certificate_id, outcome_certificate_hash,
  ticket_id, ticket_line_id, player_account_reference, currency, minor_unit_precision,
  stake_amount_minor, gross_payout_amount_minor, net_result_amount_minor,
  settlement_outcome, policy_version, canonical_settlement_hash, idempotency_key,
  issued_at, provenance
) values (
  @settlement_id, @settlement_request_id, @settlement_input_id, @settlement_input_hash,
  @math_evaluation_certificate_id, @math_evaluation_certificate_hash,
  @outcome_certificate_id, @outcome_certificate_hash,
  @ticket_id, @ticket_line_id, @player_account_reference, @currency, @minor_unit_precision,
  @stake_amount_minor, @gross_payout_amount_minor, @net_result_amount_minor,
  @settlement_outcome, @policy_version, @canonical_settlement_hash, @idempotency_key,
  now(), cast(@provenance as jsonb)
);
""";
        command.Parameters.AddWithValue("settlement_id", settlementId);
        command.Parameters.AddWithValue("settlement_request_id", settlementRequestId);
        command.Parameters.AddWithValue("settlement_input_id", settlementInputId);
        command.Parameters.AddWithValue("settlement_input_hash", settlementInputHash);
        command.Parameters.AddWithValue("math_evaluation_certificate_id", mathEvaluationCertificateId);
        command.Parameters.AddWithValue("math_evaluation_certificate_hash", mathEvaluationCertificateHash);
        command.Parameters.AddWithValue("outcome_certificate_id", outcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", outcomeCertificateHash);
        command.Parameters.AddWithValue("ticket_id", ticketId);
        command.Parameters.AddWithValue("ticket_line_id", ticketLineId);
        command.Parameters.AddWithValue("player_account_reference", playerAccountReference);
        command.Parameters.AddWithValue("currency", currency);
        command.Parameters.AddWithValue("minor_unit_precision", minorUnitPrecision);
        command.Parameters.AddWithValue("stake_amount_minor", stakeAmountMinor);
        command.Parameters.AddWithValue("gross_payout_amount_minor", grossPayoutAmountMinor);
        command.Parameters.AddWithValue("net_result_amount_minor", netResultAmountMinor);
        command.Parameters.AddWithValue("settlement_outcome", settlementOutcome);
        command.Parameters.AddWithValue("policy_version", policyVersion);
        command.Parameters.AddWithValue("canonical_settlement_hash", canonicalSettlementHash);
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(provenance, JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<SettlementRecordResponse?> GetRecordByRequestIdAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select * from settlement_service.authoritative_settlement_records where settlement_request_id = @id;";
        command.Parameters.AddWithValue("id", requestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapSettlementRecord(reader) : null;
    }

    private static async Task<ResettlementRequestDto?> GetRequestByIdempotencyAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, string key, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select * from settlement_service.resettlement_requests where idempotency_key = @key for update;";
        command.Parameters.AddWithValue("key", key);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRequest(reader) : null;
    }

    private static async Task<ResettlementRequestDto?> GetRequestAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid requestId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select * from settlement_service.resettlement_requests where resettlement_request_id = @id;";
        command.Parameters.AddWithValue("id", requestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRequest(reader) : null;
    }

    private static async Task<ResettlementChainDto?> GetChainAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid requestId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select * from settlement_service.resettlement_records where resettlement_request_id = @id;";
        command.Parameters.AddWithValue("id", requestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapChain(reader) : null;
    }

    private static async Task<ResettlementEventDto> AppendEventAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid requestId,
        Guid? recordId,
        ResettlementLifecycleState state,
        string eventType,
        IReadOnlyList<string> errors,
        CancellationToken cancellationToken)
    {
        var eventId = Guid.NewGuid();
        var evidenceHash = SettlementExecutionService.HashCanonical($"{eventId:N}|{requestId:N}|{recordId?.ToString("N")}|{state}|{eventType}|{string.Join("|", errors)}");
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.resettlement_events (
  event_id, resettlement_request_id, resettlement_record_id, lifecycle_state,
  event_type, evidence_hash, errors
) values (
  @event_id, @resettlement_request_id, @resettlement_record_id, @lifecycle_state,
  @event_type, @evidence_hash, cast(@errors as jsonb)
) returning *;
""";
        command.Parameters.AddWithValue("event_id", eventId);
        command.Parameters.AddWithValue("resettlement_request_id", requestId);
        command.Parameters.Add("resettlement_record_id", NpgsqlDbType.Uuid).Value = (object?)recordId ?? DBNull.Value;
        command.Parameters.AddWithValue("lifecycle_state", state.ToString());
        command.Parameters.AddWithValue("event_type", eventType);
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        command.Parameters.AddWithValue("errors", JsonSerializer.Serialize(errors, JsonOptions));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Resettlement event did not read back.");
        }

        return MapEvent(reader);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            throw new InvalidOperationException("DATABASE_URL is not configured.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static ResettlementRequestDto MapRequest(NpgsqlDataReader reader)
    {
        return new ResettlementRequestDto(
            reader.GetGuid(reader.GetOrdinal("resettlement_request_id")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetString(reader.GetOrdinal("canonical_request_hash")),
            reader.GetGuid(reader.GetOrdinal("original_settlement_id")),
            reader.GetString(reader.GetOrdinal("original_settlement_hash")),
            reader.GetGuid(reader.GetOrdinal("original_settlement_input_id")),
            reader.GetString(reader.GetOrdinal("original_settlement_input_hash")),
            reader.GetGuid(reader.GetOrdinal("corrected_settlement_input_id")),
            reader.GetString(reader.GetOrdinal("corrected_settlement_input_hash")),
            reader.GetGuid(reader.GetOrdinal("original_math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("original_math_evaluation_certificate_hash")),
            reader.GetGuid(reader.GetOrdinal("corrected_math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("corrected_math_evaluation_certificate_hash")),
            reader.GetString(reader.GetOrdinal("reason_code")),
            reader.GetString(reader.GetOrdinal("requestor_reference")),
            Enum.Parse<ResettlementMode>(reader.GetString(reader.GetOrdinal("mode"))),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("requested_at")),
            ReadJsonObject(reader, "approval_metadata"),
            ReadJsonObject(reader, "provenance"));
    }

    private static ResettlementChainDto MapChain(NpgsqlDataReader reader)
    {
        return new ResettlementChainDto(
            reader.GetGuid(reader.GetOrdinal("resettlement_record_id")),
            reader.GetGuid(reader.GetOrdinal("resettlement_request_id")),
            Enum.Parse<ResettlementLifecycleState>(reader.GetString(reader.GetOrdinal("lifecycle_state"))),
            reader.GetGuid(reader.GetOrdinal("original_settlement_id")),
            reader.GetString(reader.GetOrdinal("original_settlement_hash")),
            reader.GetGuid(reader.GetOrdinal("original_settlement_input_id")),
            reader.GetGuid(reader.GetOrdinal("reversal_settlement_id")),
            reader.GetString(reader.GetOrdinal("reversal_settlement_hash")),
            reader.GetGuid(reader.GetOrdinal("corrected_settlement_input_id")),
            reader.GetGuid(reader.GetOrdinal("corrected_settlement_id")),
            reader.GetString(reader.GetOrdinal("corrected_settlement_hash")),
            reader.GetString(reader.GetOrdinal("chain_hash")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static ResettlementEventDto MapEvent(NpgsqlDataReader reader)
    {
        var recordOrdinal = reader.GetOrdinal("resettlement_record_id");
        return new ResettlementEventDto(
            reader.GetGuid(reader.GetOrdinal("event_id")),
            reader.GetGuid(reader.GetOrdinal("resettlement_request_id")),
            reader.IsDBNull(recordOrdinal) ? null : reader.GetGuid(recordOrdinal),
            Enum.Parse<ResettlementLifecycleState>(reader.GetString(reader.GetOrdinal("lifecycle_state"))),
            reader.GetString(reader.GetOrdinal("event_type")),
            reader.GetString(reader.GetOrdinal("evidence_hash")),
            JsonSerializer.Deserialize<IReadOnlyList<string>>(reader.GetString(reader.GetOrdinal("errors")), JsonOptions) ?? [],
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static SettlementRecordResponse MapSettlementRecord(NpgsqlDataReader reader)
    {
        var provenance = ReadJsonObject(reader, "provenance");
        return new SettlementRecordResponse(
            reader.GetGuid(reader.GetOrdinal("settlement_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_request_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_input_id")),
            reader.GetString(reader.GetOrdinal("settlement_input_hash")),
            reader.GetGuid(reader.GetOrdinal("math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("math_evaluation_certificate_hash")),
            reader.GetGuid(reader.GetOrdinal("outcome_certificate_id")),
            reader.GetString(reader.GetOrdinal("outcome_certificate_hash")),
            reader.GetString(reader.GetOrdinal("ticket_id")),
            reader.GetString(reader.GetOrdinal("ticket_line_id")),
            reader.GetString(reader.GetOrdinal("player_account_reference")),
            reader.GetString(reader.GetOrdinal("currency")),
            reader.GetInt32(reader.GetOrdinal("minor_unit_precision")),
            reader.GetInt64(reader.GetOrdinal("stake_amount_minor")),
            reader.GetInt64(reader.GetOrdinal("gross_payout_amount_minor")),
            reader.GetInt64(reader.GetOrdinal("net_result_amount_minor")),
            reader.GetString(reader.GetOrdinal("settlement_outcome")),
            reader.GetString(reader.GetOrdinal("policy_version")),
            reader.GetString(reader.GetOrdinal("canonical_settlement_hash")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("issued_at")),
            provenance);
    }

    private static IReadOnlyDictionary<string, object?> ReadJsonObject(NpgsqlDataReader reader, string column)
    {
        return JsonSerializer.Deserialize<Dictionary<string, object?>>(
            reader.GetString(reader.GetOrdinal(column)),
            JsonOptions) ?? new Dictionary<string, object?>();
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }
}
