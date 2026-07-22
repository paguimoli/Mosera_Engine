using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace SettlementService.Infrastructure;

public sealed record FinancialInstructionExecutionContext(
    FinancialInstructionDto Instruction,
    SettlementRecordResponse SettlementRecord,
    string? CreditReservationReference,
    Guid? LedgerInstructionId,
    FinancialInstructionType? LedgerInstructionType);

public sealed class FinancialInstructionRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<SettlementRecordResponse?> GetSettlementRecordAsync(
        Guid settlementId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.authoritative_settlement_records
where settlement_id = @settlement_id;
""";
        command.Parameters.AddWithValue("settlement_id", settlementId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapSettlementRecord(reader) : null;
    }

    public async Task<FinancialInstructionResult> GenerateAsync(
        SettlementRecordResponse settlementRecord,
        IReadOnlyList<FinancialInstructionDefinition> definitions,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var existing = await ListInstructionsAsync(connection, transaction, settlementRecord.SettlementId, cancellationToken);
        if (existing.Count > 0)
        {
            try
            {
                EnsureExistingMatchesDefinitions(existing, definitions);
            }
            catch (FinancialInstructionConflictException)
            {
                var conflictAttemptId = Guid.NewGuid();
                await AppendAttemptAsync(
                    connection,
                    transaction,
                    settlementRecord.SettlementId,
                    conflictAttemptId,
                    FinancialInstructionAttemptStatus.Conflict,
                    HashDefinitionSet(definitions),
                    ["Existing financial instructions conflict with deterministic generation."],
                    cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                throw;
            }

            var attemptId = Guid.NewGuid();
            var evidenceHash = await AppendAttemptAsync(
                connection,
                transaction,
                settlementRecord.SettlementId,
                attemptId,
                FinancialInstructionAttemptStatus.Reused,
                HashDefinitionSet(definitions),
                [],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            return new FinancialInstructionResult(
                "Reused",
                true,
                existing,
                attemptId,
                evidenceHash,
                correlationId);
        }

        foreach (var definition in definitions)
        {
            await InsertInstructionAsync(connection, transaction, settlementRecord, definition, cancellationToken);
        }

        var generated = await ListInstructionsAsync(connection, transaction, settlementRecord.SettlementId, cancellationToken);
        var generatedAttemptId = Guid.NewGuid();
        var generatedEvidenceHash = await AppendAttemptAsync(
            connection,
            transaction,
            settlementRecord.SettlementId,
            generatedAttemptId,
            FinancialInstructionAttemptStatus.Generated,
            HashDefinitionSet(definitions),
            [],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new FinancialInstructionResult(
            "Generated",
            false,
            generated,
            generatedAttemptId,
            generatedEvidenceHash,
            correlationId);
    }

    public async Task<FinancialInstructionResult> ReplayAsync(
        SettlementRecordResponse settlementRecord,
        IReadOnlyList<FinancialInstructionDefinition> definitions,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await ListInstructionsAsync(connection, transaction, settlementRecord.SettlementId, cancellationToken);
        if (existing.Count == 0)
        {
            throw new FinancialInstructionValidationException(["Financial instructions were not found for replay."]);
        }

        try
        {
            EnsureExistingMatchesDefinitions(existing, definitions);
        }
        catch (FinancialInstructionConflictException)
        {
            var mismatchAttemptId = Guid.NewGuid();
            var mismatchEvidenceHash = await AppendAttemptAsync(
                connection,
                transaction,
                settlementRecord.SettlementId,
                mismatchAttemptId,
                FinancialInstructionAttemptStatus.ReplayMismatch,
                HashDefinitionSet(definitions),
                ["Replay regenerated a different financial instruction set."],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            return new FinancialInstructionResult(
                "ReplayMismatch",
                true,
                existing,
                mismatchAttemptId,
                mismatchEvidenceHash,
                correlationId);
        }

        var attemptId = Guid.NewGuid();
        var evidenceHash = await AppendAttemptAsync(
            connection,
            transaction,
            settlementRecord.SettlementId,
            attemptId,
            FinancialInstructionAttemptStatus.ReplayVerified,
            HashDefinitionSet(definitions),
            [],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new FinancialInstructionResult(
            "ReplayVerified",
            true,
            existing,
            attemptId,
            evidenceHash,
            correlationId);
    }

    public async Task<FinancialInstructionReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return new FinancialInstructionReadiness(
                false,
                false,
                true,
                false,
                true,
                false,
                false,
                false,
                false,
                false,
                false,
                true,
                true,
                true,
                true,
                ["DATABASE_URL is not configured for Financial Instructions."]);
        }

        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('settlement_service.financial_instructions') is not null
  and to_regclass('settlement_service.financial_instruction_attempts') is not null
  and to_regclass('settlement_service.financial_instruction_execution_attempts') is not null
  and to_regclass('settlement_service.recovery_events') is not null
  and to_regclass('settlement_service.reconciliation_events') is not null
  and to_regclass('settlement_service.authoritative_settlement_records') is not null;
""";
            var ready = await command.ExecuteScalarAsync(cancellationToken) is true;
            return new FinancialInstructionReadiness(
                true,
                ready,
                ready,
                ready,
                ready,
                true,
                true,
                ready,
                ready,
                ready,
                true,
                true,
                true,
                true,
                true,
                ready ? [] : ["Financial instruction tables are missing."]);
        }
        catch (Exception error) when (error is NpgsqlException or InvalidOperationException or OperationCanceledException)
        {
            return new FinancialInstructionReadiness(
                true,
                false,
                true,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                true,
                true,
                true,
                true,
                [error.Message]);
        }
    }

    public async Task<FinancialInstructionExecutionContext?> GetExecutionContextAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  instruction.*,
  record.*,
  request.credit_reservation_reference,
  ledger_instruction.instruction_id as required_ledger_instruction_id,
  ledger_instruction.instruction_type as required_ledger_instruction_type
from settlement_service.financial_instructions instruction
join settlement_service.authoritative_settlement_records record
  on record.settlement_id = instruction.settlement_id
join settlement_service.settlement_requests request
  on request.settlement_request_id = record.settlement_request_id
left join lateral (
  select prior.instruction_id, prior.instruction_type
  from settlement_service.financial_instructions prior
  where prior.settlement_id = instruction.settlement_id
    and prior.target_service = 'ledger-service'
    and prior.instruction_sequence < instruction.instruction_sequence
  order by prior.instruction_sequence desc
  limit 1
) ledger_instruction on true
where instruction.instruction_id = @instruction_id;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new FinancialInstructionExecutionContext(
            MapInstruction(reader),
            MapSettlementRecord(reader),
            reader.IsDBNull(reader.GetOrdinal("credit_reservation_reference"))
                ? null
                : reader.GetString(reader.GetOrdinal("credit_reservation_reference")),
            reader.IsDBNull(reader.GetOrdinal("required_ledger_instruction_id"))
                ? null
                : reader.GetGuid(reader.GetOrdinal("required_ledger_instruction_id")),
            reader.IsDBNull(reader.GetOrdinal("required_ledger_instruction_type"))
                ? null
                : Enum.Parse<FinancialInstructionType>(reader.GetString(reader.GetOrdinal("required_ledger_instruction_type"))));
    }

    public async Task<IReadOnlyList<FinancialInstructionExecutionContext>> ListExecutionContextsAsync(
        Guid settlementId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  instruction.*,
  record.*,
  request.credit_reservation_reference,
  ledger_instruction.instruction_id as required_ledger_instruction_id,
  ledger_instruction.instruction_type as required_ledger_instruction_type
from settlement_service.financial_instructions instruction
join settlement_service.authoritative_settlement_records record
  on record.settlement_id = instruction.settlement_id
join settlement_service.settlement_requests request
  on request.settlement_request_id = record.settlement_request_id
left join lateral (
  select prior.instruction_id, prior.instruction_type
  from settlement_service.financial_instructions prior
  where prior.settlement_id = instruction.settlement_id
    and prior.target_service = 'ledger-service'
    and prior.instruction_sequence < instruction.instruction_sequence
  order by prior.instruction_sequence desc
  limit 1
) ledger_instruction on true
where instruction.settlement_id = @settlement_id
order by instruction.instruction_sequence asc;
""";
        command.Parameters.AddWithValue("settlement_id", settlementId);

        var contexts = new List<FinancialInstructionExecutionContext>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            contexts.Add(new FinancialInstructionExecutionContext(
                MapInstruction(reader),
                MapSettlementRecord(reader),
                reader.IsDBNull(reader.GetOrdinal("credit_reservation_reference"))
                    ? null
                    : reader.GetString(reader.GetOrdinal("credit_reservation_reference")),
                reader.IsDBNull(reader.GetOrdinal("required_ledger_instruction_id"))
                    ? null
                    : reader.GetGuid(reader.GetOrdinal("required_ledger_instruction_id")),
                reader.IsDBNull(reader.GetOrdinal("required_ledger_instruction_type"))
                    ? null
                    : Enum.Parse<FinancialInstructionType>(reader.GetString(reader.GetOrdinal("required_ledger_instruction_type")))));
        }

        return contexts;
    }

    public async Task<IReadOnlyList<FinancialInstructionExecutionContext>> ListIncompleteExecutionContextsAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  instruction.*,
  record.*,
  request.credit_reservation_reference,
  ledger_instruction.instruction_id as required_ledger_instruction_id,
  ledger_instruction.instruction_type as required_ledger_instruction_type
from settlement_service.financial_instructions instruction
join settlement_service.authoritative_settlement_records record
  on record.settlement_id = instruction.settlement_id
join settlement_service.settlement_requests request
  on request.settlement_request_id = record.settlement_request_id
left join lateral (
  select prior.instruction_id, prior.instruction_type
  from settlement_service.financial_instructions prior
  where prior.settlement_id = instruction.settlement_id
    and prior.target_service = 'ledger-service'
    and prior.instruction_sequence < instruction.instruction_sequence
  order by prior.instruction_sequence desc
  limit 1
) ledger_instruction on true
where not exists (
  select 1
  from settlement_service.financial_instruction_execution_attempts attempt
  where attempt.instruction_id = instruction.instruction_id
    and attempt.status in ('Posted', 'Skipped')
)
order by record.issued_at asc, instruction.instruction_sequence asc;
""";

        var contexts = new List<FinancialInstructionExecutionContext>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            contexts.Add(new FinancialInstructionExecutionContext(
                MapInstruction(reader),
                MapSettlementRecord(reader),
                reader.IsDBNull(reader.GetOrdinal("credit_reservation_reference"))
                    ? null
                    : reader.GetString(reader.GetOrdinal("credit_reservation_reference")),
                reader.IsDBNull(reader.GetOrdinal("required_ledger_instruction_id"))
                    ? null
                    : reader.GetGuid(reader.GetOrdinal("required_ledger_instruction_id")),
                reader.IsDBNull(reader.GetOrdinal("required_ledger_instruction_type"))
                    ? null
                    : Enum.Parse<FinancialInstructionType>(reader.GetString(reader.GetOrdinal("required_ledger_instruction_type")))));
        }

        return contexts;
    }

    public async Task<IReadOnlyList<FinancialInstructionExecutionAttemptDto>> ListExecutionAttemptsAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await ListExecutionAttemptsAsync(connection, null, instructionId, cancellationToken);
    }

    public async Task<RecoveryEventDto?> GetLatestRecoveryEventAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.recovery_events
where instruction_id = @instruction_id
order by created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRecoveryEvent(reader) : null;
    }

    public async Task<ReconciliationEventDto?> GetLatestReconciliationEventAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.reconciliation_events
where instruction_id = @instruction_id
order by created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapReconciliationEvent(reader) : null;
    }

    public async Task<RecoveryEventDto> AppendRecoveryEventAsync(
        Guid? settlementId,
        Guid? instructionId,
        Guid? executionAttemptId,
        SettlementRecoveryState recoveryState,
        string decision,
        string verificationResult,
        string? reason,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var eventId = Guid.NewGuid();
        var evidenceHash = FinancialInstructionService.HashCanonical(
            $"{eventId:N}|{FormatGuid(settlementId)}|{FormatGuid(instructionId)}|{FormatGuid(executionAttemptId)}|{recoveryState}|{decision}|{verificationResult}|{reason}");

        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into settlement_service.recovery_events (
  event_id,
  settlement_id,
  instruction_id,
  execution_attempt_id,
  recovery_state,
  decision,
  verification_result,
  reason,
  evidence_hash
)
values (
  @event_id,
  @settlement_id,
  @instruction_id,
  @execution_attempt_id,
  @recovery_state,
  @decision,
  @verification_result,
  @reason,
  @evidence_hash
)
returning *;
""";
        command.Parameters.AddWithValue("event_id", eventId);
        command.Parameters.Add("settlement_id", NpgsqlDbType.Uuid).Value = (object?)settlementId ?? DBNull.Value;
        command.Parameters.Add("instruction_id", NpgsqlDbType.Uuid).Value = (object?)instructionId ?? DBNull.Value;
        command.Parameters.Add("execution_attempt_id", NpgsqlDbType.Uuid).Value = (object?)executionAttemptId ?? DBNull.Value;
        command.Parameters.AddWithValue("recovery_state", recoveryState.ToString());
        command.Parameters.AddWithValue("decision", decision);
        command.Parameters.AddWithValue("verification_result", verificationResult);
        command.Parameters.Add("reason", NpgsqlDbType.Text).Value = (object?)reason ?? DBNull.Value;
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Recovery event did not read back.");
        }

        return MapRecoveryEvent(reader);
    }

    public async Task<ReconciliationEventDto> AppendReconciliationEventAsync(
        FinancialInstructionDto instruction,
        Guid? executionAttemptId,
        InstructionReconciliationStatus status,
        string targetIdempotencyKey,
        string? externalReferenceType,
        string? externalReferenceId,
        string? targetResponseHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var eventId = Guid.NewGuid();
        var evidenceHash = FinancialInstructionService.HashCanonical(
            $"{eventId:N}|{instruction.SettlementId:N}|{instruction.InstructionId:N}|{executionAttemptId:N}|{status}|{instruction.CanonicalPayloadHash}|{targetIdempotencyKey}|{externalReferenceType}|{externalReferenceId}|{targetResponseHash}");

        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into settlement_service.reconciliation_events (
  event_id,
  settlement_id,
  instruction_id,
  execution_attempt_id,
  reconciliation_status,
  local_payload_hash,
  target_idempotency_key,
  external_reference_type,
  external_reference_id,
  target_response_hash,
  evidence_hash
)
values (
  @event_id,
  @settlement_id,
  @instruction_id,
  @execution_attempt_id,
  @reconciliation_status,
  @local_payload_hash,
  @target_idempotency_key,
  @external_reference_type,
  @external_reference_id,
  @target_response_hash,
  @evidence_hash
)
returning *;
""";
        command.Parameters.AddWithValue("event_id", eventId);
        command.Parameters.AddWithValue("settlement_id", instruction.SettlementId);
        command.Parameters.AddWithValue("instruction_id", instruction.InstructionId);
        command.Parameters.Add("execution_attempt_id", NpgsqlDbType.Uuid).Value = (object?)executionAttemptId ?? DBNull.Value;
        command.Parameters.AddWithValue("reconciliation_status", status.ToString());
        command.Parameters.AddWithValue("local_payload_hash", instruction.CanonicalPayloadHash);
        command.Parameters.AddWithValue("target_idempotency_key", targetIdempotencyKey);
        command.Parameters.Add("external_reference_type", NpgsqlDbType.Text).Value = (object?)externalReferenceType ?? DBNull.Value;
        command.Parameters.Add("external_reference_id", NpgsqlDbType.Text).Value = (object?)externalReferenceId ?? DBNull.Value;
        command.Parameters.Add("target_response_hash", NpgsqlDbType.Text).Value = (object?)targetResponseHash ?? DBNull.Value;
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Reconciliation event did not read back.");
        }

        return MapReconciliationEvent(reader);
    }

    public async Task<FinancialInstructionExecutionAttemptDto> AppendExecutionAttemptAsync(
        FinancialInstructionDto instruction,
        FinancialInstructionExecutionAttemptStatus status,
        string targetIdempotencyKey,
        string? externalReferenceType,
        string? externalReferenceId,
        string? targetResponseHash,
        string? errorClassification,
        string? errorMessage,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existingTerminal = await GetTerminalExecutionAttemptAsync(connection, transaction, instruction.InstructionId, cancellationToken);
        if (existingTerminal is not null &&
            status is FinancialInstructionExecutionAttemptStatus.Posted or FinancialInstructionExecutionAttemptStatus.Skipped)
        {
            await transaction.CommitAsync(cancellationToken);
            return existingTerminal;
        }

        var attempt = await InsertExecutionAttemptAsync(
            connection,
            transaction,
            instruction,
            status,
            targetIdempotencyKey,
            externalReferenceType,
            externalReferenceId,
            targetResponseHash,
            errorClassification,
            errorMessage,
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return attempt;
    }

    private static void EnsureExistingMatchesDefinitions(
        IReadOnlyList<FinancialInstructionDto> existing,
        IReadOnlyList<FinancialInstructionDefinition> definitions)
    {
        if (existing.Count != definitions.Count)
        {
            throw new FinancialInstructionConflictException("Financial instruction count does not match deterministic generation.");
        }

        foreach (var definition in definitions)
        {
            var match = existing.FirstOrDefault(instruction => instruction.InstructionType == definition.InstructionType);
            if (match is null)
            {
                throw new FinancialInstructionConflictException($"Financial instruction {definition.InstructionType} is missing.");
            }

            if (!string.Equals(match.CanonicalPayloadHash, definition.CanonicalPayloadHash, StringComparison.Ordinal) ||
                !string.Equals(match.IdempotencyKey, definition.IdempotencyKey, StringComparison.Ordinal) ||
                !string.Equals(match.TargetService, definition.TargetService, StringComparison.Ordinal) ||
                match.InstructionSequence != definition.InstructionSequence ||
                match.InstructionStatus != definition.InstructionStatus)
            {
                throw new FinancialInstructionConflictException($"Financial instruction {definition.InstructionType} conflicts with deterministic payload.");
            }
        }
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

    private static async Task<IReadOnlyList<FinancialInstructionDto>> ListInstructionsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid settlementId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select *
from settlement_service.financial_instructions
where settlement_id = @settlement_id
order by instruction_sequence asc;
""";
        command.Parameters.AddWithValue("settlement_id", settlementId);

        var instructions = new List<FinancialInstructionDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            instructions.Add(MapInstruction(reader));
        }

        return instructions;
    }

    private static async Task<string> AppendAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid settlementId,
        Guid attemptId,
        FinancialInstructionAttemptStatus status,
        string instructionSetHash,
        IReadOnlyList<string> errors,
        CancellationToken cancellationToken)
    {
        var attemptNumber = await NextAttemptNumberAsync(connection, transaction, settlementId, cancellationToken);
        var evidenceHash = FinancialInstructionService.HashCanonical(
            $"{settlementId:N}|{attemptId:N}|{attemptNumber}|{status}|{instructionSetHash}|{string.Join("|", errors)}");

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.financial_instruction_attempts (
  attempt_id,
  settlement_id,
  attempt_number,
  status,
  instruction_set_hash,
  evidence_hash,
  errors
)
values (
  @attempt_id,
  @settlement_id,
  @attempt_number,
  @status,
  @instruction_set_hash,
  @evidence_hash,
  cast(@errors as jsonb)
);
""";
        command.Parameters.AddWithValue("attempt_id", attemptId);
        command.Parameters.AddWithValue("settlement_id", settlementId);
        command.Parameters.AddWithValue("attempt_number", attemptNumber);
        command.Parameters.AddWithValue("status", status.ToString());
        command.Parameters.AddWithValue("instruction_set_hash", instructionSetHash);
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        command.Parameters.AddWithValue("errors", JsonSerializer.Serialize(errors, JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
        return evidenceHash;
    }

    private static async Task<int> NextAttemptNumberAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid settlementId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from settlement_service.financial_instruction_attempts
where settlement_id = @settlement_id;
""";
        command.Parameters.AddWithValue("settlement_id", settlementId);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    private static async Task<IReadOnlyList<FinancialInstructionExecutionAttemptDto>> ListExecutionAttemptsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select *
from settlement_service.financial_instruction_execution_attempts
where instruction_id = @instruction_id
order by attempt_number asc;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);

        var attempts = new List<FinancialInstructionExecutionAttemptDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            attempts.Add(MapExecutionAttempt(reader));
        }

        return attempts;
    }

    private static async Task<FinancialInstructionExecutionAttemptDto?> GetTerminalExecutionAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select *
from settlement_service.financial_instruction_execution_attempts
where instruction_id = @instruction_id
  and status in ('Posted', 'Skipped')
order by attempt_number desc
limit 1;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapExecutionAttempt(reader) : null;
    }

    private static async Task<FinancialInstructionExecutionAttemptDto> InsertExecutionAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        FinancialInstructionDto instruction,
        FinancialInstructionExecutionAttemptStatus status,
        string targetIdempotencyKey,
        string? externalReferenceType,
        string? externalReferenceId,
        string? targetResponseHash,
        string? errorClassification,
        string? errorMessage,
        CancellationToken cancellationToken)
    {
        var attemptNumber = await NextExecutionAttemptNumberAsync(connection, transaction, instruction.InstructionId, cancellationToken);
        var attemptId = Guid.NewGuid();
        var evidenceHash = FinancialInstructionService.HashCanonical(
            $"{instruction.InstructionId:N}|{instruction.SettlementId:N}|{attemptId:N}|{attemptNumber}|{status}|{targetIdempotencyKey}|{externalReferenceType}|{externalReferenceId}|{targetResponseHash}|{errorClassification}|{errorMessage}");

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.financial_instruction_execution_attempts (
  attempt_id,
  instruction_id,
  settlement_id,
  attempt_number,
  status,
  target_service,
  target_idempotency_key,
  external_reference_type,
  external_reference_id,
  target_response_hash,
  error_classification,
  error_message,
  evidence_hash
)
values (
  @attempt_id,
  @instruction_id,
  @settlement_id,
  @attempt_number,
  @status,
  @target_service,
  @target_idempotency_key,
  @external_reference_type,
  @external_reference_id,
  @target_response_hash,
  @error_classification,
  @error_message,
  @evidence_hash
)
returning *;
""";
        command.Parameters.AddWithValue("attempt_id", attemptId);
        command.Parameters.AddWithValue("instruction_id", instruction.InstructionId);
        command.Parameters.AddWithValue("settlement_id", instruction.SettlementId);
        command.Parameters.AddWithValue("attempt_number", attemptNumber);
        command.Parameters.AddWithValue("status", status.ToString());
        command.Parameters.AddWithValue("target_service", instruction.TargetService);
        command.Parameters.AddWithValue("target_idempotency_key", targetIdempotencyKey);
        command.Parameters.Add("external_reference_type", NpgsqlDbType.Text).Value = (object?)externalReferenceType ?? DBNull.Value;
        command.Parameters.Add("external_reference_id", NpgsqlDbType.Text).Value = (object?)externalReferenceId ?? DBNull.Value;
        command.Parameters.Add("target_response_hash", NpgsqlDbType.Text).Value = (object?)targetResponseHash ?? DBNull.Value;
        command.Parameters.Add("error_classification", NpgsqlDbType.Text).Value = (object?)errorClassification ?? DBNull.Value;
        command.Parameters.Add("error_message", NpgsqlDbType.Text).Value = (object?)errorMessage ?? DBNull.Value;
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Financial instruction execution attempt did not read back.");
        }

        return MapExecutionAttempt(reader);
    }

    private static async Task<int> NextExecutionAttemptNumberAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from settlement_service.financial_instruction_execution_attempts
where instruction_id = @instruction_id;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
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

    private static string HashDefinitionSet(IReadOnlyList<FinancialInstructionDefinition> definitions)
    {
        return FinancialInstructionService.HashCanonical(string.Join("|", definitions
            .OrderBy(definition => definition.InstructionSequence)
            .Select(definition => definition.CanonicalPayloadHash)));
    }

    private static SettlementRecordResponse MapSettlementRecord(NpgsqlDataReader reader)
    {
        var provenance = JsonSerializer.Deserialize<Dictionary<string, object?>>(
            reader.GetString(reader.GetOrdinal("provenance")),
            JsonOptions) ?? new Dictionary<string, object?>();

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

    private static FinancialInstructionDto MapInstruction(NpgsqlDataReader reader)
    {
        var provenance = JsonSerializer.Deserialize<Dictionary<string, object?>>(
            reader.GetString(reader.GetOrdinal("provenance")),
            JsonOptions) ?? new Dictionary<string, object?>();
        var completedOrdinal = reader.GetOrdinal("completed_at");
        var failureOrdinal = reader.GetOrdinal("failure_reason");

        return new FinancialInstructionDto(
            reader.GetGuid(reader.GetOrdinal("instruction_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_id")),
            Enum.Parse<FinancialInstructionType>(reader.GetString(reader.GetOrdinal("instruction_type"))),
            Enum.Parse<FinancialInstructionStatus>(reader.GetString(reader.GetOrdinal("instruction_status"))),
            reader.GetString(reader.GetOrdinal("canonical_payload_hash")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetString(reader.GetOrdinal("target_service")),
            reader.GetInt32(reader.GetOrdinal("instruction_sequence")),
            reader.GetInt32(reader.GetOrdinal("attempt_count")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")),
            reader.IsDBNull(completedOrdinal) ? null : reader.GetFieldValue<DateTimeOffset>(completedOrdinal),
            reader.IsDBNull(failureOrdinal) ? null : reader.GetString(failureOrdinal),
            provenance);
    }

    private static FinancialInstructionExecutionAttemptDto MapExecutionAttempt(NpgsqlDataReader reader)
    {
        var externalReferenceTypeOrdinal = reader.GetOrdinal("external_reference_type");
        var externalReferenceIdOrdinal = reader.GetOrdinal("external_reference_id");
        var targetResponseHashOrdinal = reader.GetOrdinal("target_response_hash");
        var errorClassificationOrdinal = reader.GetOrdinal("error_classification");
        var errorMessageOrdinal = reader.GetOrdinal("error_message");

        return new FinancialInstructionExecutionAttemptDto(
            reader.GetGuid(reader.GetOrdinal("attempt_id")),
            reader.GetGuid(reader.GetOrdinal("instruction_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_id")),
            reader.GetInt32(reader.GetOrdinal("attempt_number")),
            Enum.Parse<FinancialInstructionExecutionAttemptStatus>(reader.GetString(reader.GetOrdinal("status"))),
            reader.GetString(reader.GetOrdinal("target_service")),
            reader.GetString(reader.GetOrdinal("target_idempotency_key")),
            reader.IsDBNull(externalReferenceTypeOrdinal) ? null : reader.GetString(externalReferenceTypeOrdinal),
            reader.IsDBNull(externalReferenceIdOrdinal) ? null : reader.GetString(externalReferenceIdOrdinal),
            reader.IsDBNull(targetResponseHashOrdinal) ? null : reader.GetString(targetResponseHashOrdinal),
            reader.IsDBNull(errorClassificationOrdinal) ? null : reader.GetString(errorClassificationOrdinal),
            reader.IsDBNull(errorMessageOrdinal) ? null : reader.GetString(errorMessageOrdinal),
            reader.GetString(reader.GetOrdinal("evidence_hash")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static RecoveryEventDto MapRecoveryEvent(NpgsqlDataReader reader)
    {
        var settlementOrdinal = reader.GetOrdinal("settlement_id");
        var instructionOrdinal = reader.GetOrdinal("instruction_id");
        var attemptOrdinal = reader.GetOrdinal("execution_attempt_id");
        var reasonOrdinal = reader.GetOrdinal("reason");

        return new RecoveryEventDto(
            reader.GetGuid(reader.GetOrdinal("event_id")),
            reader.IsDBNull(settlementOrdinal) ? null : reader.GetGuid(settlementOrdinal),
            reader.IsDBNull(instructionOrdinal) ? null : reader.GetGuid(instructionOrdinal),
            reader.IsDBNull(attemptOrdinal) ? null : reader.GetGuid(attemptOrdinal),
            Enum.Parse<SettlementRecoveryState>(reader.GetString(reader.GetOrdinal("recovery_state"))),
            reader.GetString(reader.GetOrdinal("decision")),
            reader.GetString(reader.GetOrdinal("verification_result")),
            reader.IsDBNull(reasonOrdinal) ? null : reader.GetString(reasonOrdinal),
            reader.GetString(reader.GetOrdinal("evidence_hash")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static ReconciliationEventDto MapReconciliationEvent(NpgsqlDataReader reader)
    {
        var attemptOrdinal = reader.GetOrdinal("execution_attempt_id");
        var externalReferenceTypeOrdinal = reader.GetOrdinal("external_reference_type");
        var externalReferenceIdOrdinal = reader.GetOrdinal("external_reference_id");
        var targetResponseHashOrdinal = reader.GetOrdinal("target_response_hash");

        return new ReconciliationEventDto(
            reader.GetGuid(reader.GetOrdinal("event_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_id")),
            reader.GetGuid(reader.GetOrdinal("instruction_id")),
            reader.IsDBNull(attemptOrdinal) ? null : reader.GetGuid(attemptOrdinal),
            Enum.Parse<InstructionReconciliationStatus>(reader.GetString(reader.GetOrdinal("reconciliation_status"))),
            reader.GetString(reader.GetOrdinal("local_payload_hash")),
            reader.GetString(reader.GetOrdinal("target_idempotency_key")),
            reader.IsDBNull(externalReferenceTypeOrdinal) ? null : reader.GetString(externalReferenceTypeOrdinal),
            reader.IsDBNull(externalReferenceIdOrdinal) ? null : reader.GetString(externalReferenceIdOrdinal),
            reader.IsDBNull(targetResponseHashOrdinal) ? null : reader.GetString(targetResponseHashOrdinal),
            reader.GetString(reader.GetOrdinal("evidence_hash")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static string FormatGuid(Guid? value)
    {
        return value.HasValue ? value.Value.ToString("N") : string.Empty;
    }
}
