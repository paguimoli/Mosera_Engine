using System.Text.Json;
using CreditWalletService.Application;
using CreditWalletService.Configuration;
using CreditWalletService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace CreditWalletService.Infrastructure;

public sealed class CanonicalWalletOperationRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<CanonicalWalletOperationResponse> ExecuteAsync(
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string canonicalRequestHash,
        Guid operationId,
        string correlationId,
        CancellationToken cancellationToken)
        => await ExecuteCoreAsync(request, idempotencyKey, canonicalRequestHash, operationId,
            correlationId, allowIncompleteRecovery: false, cancellationToken);

    public async Task<CanonicalWalletOperationResponse> RecoverExistingAsync(
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string canonicalRequestHash,
        Guid operationId,
        string correlationId,
        CancellationToken cancellationToken)
        => await ExecuteCoreAsync(request, idempotencyKey, canonicalRequestHash, operationId,
            correlationId, allowIncompleteRecovery: true, cancellationToken);

    public async Task<CanonicalWalletOperationResponse> CompleteRecoveredEffectAsync(
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string canonicalRequestHash,
        Guid operationId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var startedAt = DateTimeOffset.UtcNow;
        await AcquireIdempotencyLockAsync(connection, transaction, idempotencyKey, cancellationToken);
        var existing = await FindRequestAsync(connection, transaction, idempotencyKey, cancellationToken)
            ?? throw new CanonicalWalletOperationConflictException("Canonical wallet request is missing.");
        if (existing.CanonicalRequestHash != canonicalRequestHash || existing.OperationId != operationId)
            throw new CanonicalWalletOperationConflictException("Canonical wallet recovery identity does not match.");
        var terminal = await FindTerminalResultAsync(connection, transaction, operationId, cancellationToken);
        if (terminal is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return MapResponse(existing, terminal, true, correlationId);
        }

        await using var effectCommand = connection.CreateCommand();
        effectCommand.Transaction = transaction;
        effectCommand.CommandText = request.Operation switch
        {
            WalletOperationType.RESERVE => """
select to_jsonb(cr)::text from public.credit_reservations cr
where cr.idempotency_key = 'canonical-wallet:' || replace(@operation_id::text, '-', '') || ':RESERVE';
""",
            WalletOperationType.RELEASE => """
select to_jsonb(cr)::text from public.credit_reservation_releases rel
join public.credit_reservations cr on cr.id = rel.reservation_id
where rel.operation_id = @operation_id;
""",
            WalletOperationType.CANCEL => """
select to_jsonb(cr)::text from credit_wallet_service.wallet_reservation_cancellations c
join public.credit_reservations cr on cr.id = c.reservation_id
where c.operation_id = @operation_id;
""",
            WalletOperationType.SETTLE or WalletOperationType.REVERSE => """
select to_jsonb(a)::text from public.credit_settlement_applications a
where a.operation_id = @operation_id;
""",
            _ => throw new CanonicalWalletOperationDisabledException(
                $"{request.Operation} cannot be recovered from durable effect evidence.")
        };
        effectCommand.Parameters.AddWithValue("operation_id", operationId);
        var json = (string?)await effectCommand.ExecuteScalarAsync(cancellationToken)
            ?? throw new CanonicalWalletOperationConflictException("Exactly one durable wallet effect is required for terminal reconstruction.");
        var payload = JsonSerializer.Deserialize<Dictionary<string, object?>>(json, JsonOptions)
            ?? new Dictionary<string, object?>();
        var referenceType = request.Operation is WalletOperationType.SETTLE or WalletOperationType.REVERSE
            ? "credit_settlement_application" : request.Operation == WalletOperationType.CANCEL
                ? "credit_reservation_cancellation" : "credit_reservation";
        var referenceId = FindJsonString(payload, "id") ?? operationId.ToString("D");
        terminal = await AppendTerminalResultAsync(connection, transaction, operationId, "COMMITTED",
            referenceType, referenceId, payload, null, null, cancellationToken);
        await AppendAttemptAsync(connection, transaction, operationId, "SUCCEEDED", startedAt,
            null, null, terminal.ResultHash,
            new Dictionary<string, object?> { ["recovery"] = "terminal-reconstruction" }, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return MapResponse(existing, terminal, false, correlationId);
    }

    private async Task<CanonicalWalletOperationResponse> ExecuteCoreAsync(
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string canonicalRequestHash,
        Guid operationId,
        string correlationId,
        bool allowIncompleteRecovery,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var startedAt = DateTimeOffset.UtcNow;

        await AcquireIdempotencyLockAsync(connection, transaction, idempotencyKey, cancellationToken);
        var existing = await FindRequestAsync(connection, transaction, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalRequestHash, canonicalRequestHash, StringComparison.Ordinal))
            {
                await AppendAttemptAsync(
                    connection, transaction, existing.OperationId, "CONFLICT", startedAt,
                    "IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different canonical request.",
                    canonicalRequestHash, request.AuditMetadata, cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                throw new CanonicalWalletOperationConflictException(
                    "Idempotency key is already bound to a different canonical wallet request.");
            }

            var terminal = await FindTerminalResultAsync(connection, transaction, existing.OperationId, cancellationToken);
            if (terminal is null && !allowIncompleteRecovery)
            {
                throw new CanonicalWalletOperationConflictException(
                    "Canonical wallet operation is already claimed without a terminal result.");
            }
            if (terminal is not null)
            {
                await AppendAttemptAsync(
                    connection, transaction, existing.OperationId, "REUSED", startedAt,
                    null, null, terminal.ResultHash, request.AuditMetadata, cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return MapResponse(existing, terminal, true, correlationId);
            }
        }

        if (existing is null) try
        {
            await InsertRequestAsync(
                connection, transaction, request, idempotencyKey, canonicalRequestHash,
                operationId, correlationId, cancellationToken);
        }
        catch (PostgresException error)
        {
            await transaction.RollbackAsync(cancellationToken);
            throw new CanonicalWalletOperationValidationException(error.MessageText);
        }

        if (request.Operation is WalletOperationType.ISSUE or WalletOperationType.EXPIRE)
        {
            const string code = "OPERATION_EXECUTION_DISABLED";
            var reason = $"{request.Operation} is modeled but execution is disabled.";
            var terminal = await AppendTerminalResultAsync(
                connection, transaction, operationId, "FAILED", null, null,
                new Dictionary<string, object?> { ["code"] = code, ["message"] = reason },
                code, reason, cancellationToken);
            await AppendAttemptAsync(
                connection, transaction, operationId, "FAILED", startedAt,
                code, reason, terminal.ResultHash, request.AuditMetadata, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            throw new CanonicalWalletOperationDisabledException(reason);
        }

        await transaction.SaveAsync("before_wallet_effect", cancellationToken);
        try
        {
            await ValidateCommittedInstructionMatchAsync(
                connection, transaction, request, cancellationToken);
            var effect = await ExecuteEffectAsync(
                connection, transaction, request, operationId, correlationId, cancellationToken);
            var terminal = await AppendTerminalResultAsync(
                connection, transaction, operationId, "COMMITTED", effect.ReferenceType,
                effect.ReferenceId, effect.Payload, null, null, cancellationToken);
            await AppendAttemptAsync(
                connection, transaction, operationId, "SUCCEEDED", startedAt,
                null, null, terminal.ResultHash, request.AuditMetadata, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return MapResponse(
                new OperationRequestRecord(
                    operationId, request.RequestId, idempotencyKey, canonicalRequestHash,
                    request.Operation, request.Instrument),
                terminal,
                false,
                correlationId);
        }
        catch (PostgresException error)
        {
            await transaction.RollbackAsync("before_wallet_effect", cancellationToken);
            var terminal = await AppendTerminalResultAsync(
                connection, transaction, operationId, "FAILED", null, null,
                new Dictionary<string, object?>
                {
                    ["code"] = "WALLET_OPERATION_REJECTED",
                    ["message"] = error.MessageText
                },
                "WALLET_OPERATION_REJECTED", error.MessageText, cancellationToken);
            await AppendAttemptAsync(
                connection, transaction, operationId, "FAILED", startedAt,
                "WALLET_OPERATION_REJECTED", error.MessageText, terminal.ResultHash,
                request.AuditMetadata, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            throw new CanonicalWalletOperationValidationException(error.MessageText);
        }
        catch (CanonicalWalletOperationConflictException error)
        {
            await transaction.RollbackAsync("before_wallet_effect", cancellationToken);
            var terminal = await AppendTerminalResultAsync(
                connection, transaction, operationId, "FAILED", null, null,
                new Dictionary<string, object?>
                {
                    ["code"] = "SETTLEMENT_INSTRUCTION_CONFLICT",
                    ["message"] = error.Message
                },
                "SETTLEMENT_INSTRUCTION_CONFLICT", error.Message, cancellationToken);
            await AppendAttemptAsync(
                connection, transaction, operationId, "CONFLICT", startedAt,
                "SETTLEMENT_INSTRUCTION_CONFLICT", error.Message, terminal.ResultHash,
                request.AuditMetadata, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            throw;
        }
    }

    public async Task<IReadOnlyList<WalletInstrumentDefinitionDto>> ListInstrumentsAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select instrument_code, instrument_version, reservable, withdrawable, expires,
       allows_negative, settlement_supported, content_hash
from credit_wallet_service.wallet_instrument_definitions
where lifecycle_state = 'ACTIVE'
order by instrument_code;
""";
        var definitions = new List<WalletInstrumentDefinitionDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            definitions.Add(new WalletInstrumentDefinitionDto(
                Enum.Parse<WalletInstrumentType>(reader.GetString(0)), reader.GetString(1),
                reader.GetBoolean(2), reader.GetBoolean(3), reader.GetBoolean(4),
                reader.GetBoolean(5), reader.GetBoolean(6), reader.GetString(7)));
        }

        return definitions;
    }

    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!Configured) return false;
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select count(*) = 3
  and to_regclass('credit_wallet_service.wallet_scopes') is not null
  and to_regclass('credit_wallet_service.wallet_operation_requests') is not null
  and to_regclass('credit_wallet_service.wallet_operation_attempts') is not null
  and to_regclass('credit_wallet_service.wallet_operation_terminal_results') is not null
  and to_regclass('credit_wallet_service.wallet_reservation_cancellations') is not null
  and to_regprocedure('credit_wallet_service.reserve_wallet(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb)') is not null
  and to_regprocedure('credit_wallet_service.release_wallet_reservation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,text,jsonb)') is not null
  and to_regprocedure('credit_wallet_service.cancel_wallet_reservation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,text,jsonb)') is not null
  and to_regclass('credit_wallet_service.settlement_instruction_authentication_evidence') is not null
  and to_regprocedure('credit_wallet_service.apply_authoritative_wallet_settlement(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,text,text,text,text,uuid,boolean,bigint,bigint,text,text,text,uuid,text,text,jsonb)') is not null
  and to_regprocedure('credit_wallet_service.reverse_authoritative_wallet_settlement(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,text,text,text,text,uuid,boolean,bigint,bigint,text,text,text,text,text,text,jsonb)') is not null
from credit_wallet_service.wallet_instrument_definitions
where lifecycle_state = 'ACTIVE';
""";
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    public async Task<PlayerWalletExposureDto?> GetPlayerExposureAsync(
        Guid playerId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select ws.wallet_id, ws.instrument_code, ws.currency, fw.status,
       coalesce(fw.balance, 0)::bigint as balance,
       (case when ws.instrument_code = 'CREDIT'
          then coalesce(fw.credit_limit, 0) + coalesce(fw.balance, 0)
          else coalesce(fw.balance, 0) end
        - coalesce(sum(cr.remaining_exposure), 0))::bigint as available_balance,
       coalesce(sum(cr.reserved_amount), 0)::bigint as reserved_amount,
       coalesce(sum(cr.released_amount), 0)::bigint as released_amount,
       coalesce(sum(cr.captured_amount), 0)::bigint as captured_amount,
       coalesce(sum(cr.remaining_exposure), 0)::bigint as remaining_exposure,
       count(cr.id) filter (where cr.status in ('RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED'))::integer
         as active_reservation_count
from credit_wallet_service.wallet_scopes ws
join public.financial_wallets fw on fw.id = ws.wallet_id
left join public.credit_reservations cr
  on cr.wallet_id = ws.wallet_id and cr.scope_model = 'CANONICAL'
where ws.player_id = @player_id
group by ws.wallet_id, ws.instrument_code, ws.currency, fw.status, fw.balance, fw.credit_limit
order by ws.instrument_code, ws.wallet_id;
""";
        command.Parameters.AddWithValue("player_id", playerId);
        var wallets = new List<WalletExposureLineDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            wallets.Add(new WalletExposureLineDto(
                reader.GetGuid(0),
                Enum.Parse<WalletInstrumentType>(reader.GetString(1)),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetInt64(4),
                reader.GetInt64(5),
                reader.GetInt64(6),
                reader.GetInt64(7),
                reader.GetInt64(8),
                reader.GetInt64(9),
                reader.GetInt32(10)));
        }
        if (wallets.Count == 0) return null;

        var instruments = wallets
            .GroupBy(item => new { item.Instrument, item.Currency })
            .Select(group => new WalletExposureLineDto(
                Guid.Empty,
                group.Key.Instrument,
                group.Key.Currency,
                group.All(item => item.WalletStatus == "ACTIVE") ? "ACTIVE" : "RESTRICTED",
                group.Sum(item => item.Balance),
                group.Sum(item => item.AvailableBalance),
                group.Sum(item => item.ReservedAmount),
                group.Sum(item => item.ReleasedAmount),
                group.Sum(item => item.CapturedAmount),
                group.Sum(item => item.RemainingExposure),
                group.Sum(item => item.ActiveReservationCount)))
            .OrderBy(item => item.Instrument)
            .ToArray();
        return new PlayerWalletExposureDto(playerId, wallets, instruments, DateTimeOffset.UtcNow, correlationId);
    }

    public async Task<ReservationSettlementContextDto?> GetReservationSettlementContextAsync(
        Guid reservationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select id, tenant_id, brand_id, player_id, wallet_id, instrument_code,
       currency, ticket_id, status, remaining_exposure, captured_amount
from public.credit_reservations
where id = @reservation_id and scope_model = 'CANONICAL';
""";
        command.Parameters.AddWithValue("reservation_id", reservationId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new ReservationSettlementContextDto(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2), reader.GetGuid(3),
            reader.GetGuid(4), Enum.Parse<WalletInstrumentType>(reader.GetString(5)),
            reader.GetString(6), Guid.Parse(reader.GetString(7)), reader.GetString(8),
            reader.GetInt64(9), reader.GetInt64(10));
    }

    public async Task<WalletSettlementOperationTraceDto?> GetSettlementOperationTraceAsync(
        Guid settlementId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select original.settlement_id::uuid, original.operation_id, original.id,
       reversal.operation_id, reversal.id
from public.credit_settlement_applications original
left join public.credit_settlement_applications reversal
  on reversal.original_application_id = original.id
 and reversal.operation_type = 'REVERSAL'
where original.settlement_id = @settlement_id
  and original.operation_type in ('PARTIAL_CAPTURE', 'FULL_CAPTURE',
    'PARTIAL_CORRECTION', 'FULL_CORRECTION')
order by original.created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("settlement_id", settlementId.ToString());
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new WalletSettlementOperationTraceDto(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2),
            reader.IsDBNull(3) ? null : reader.GetGuid(3),
            reader.IsDBNull(4) ? null : reader.GetGuid(4));
    }

    private static async Task AcquireIdempotencyLockAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select pg_advisory_xact_lock(hashtextextended(@key, 0));";
        command.Parameters.AddWithValue("key", idempotencyKey);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task ValidateCommittedInstructionMatchAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CanonicalWalletOperationRequest request,
        CancellationToken cancellationToken)
    {
        if (request.Operation is not (WalletOperationType.SETTLE or WalletOperationType.REVERSE)) return;

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select wallet_id, instrument_code, ticket_id, release_amount, balance_impact,
       settlement_instruction_hash, settlement_hash
from public.credit_settlement_applications
where source_authority = @authority
  and settlement_id = @settlement_id
  and settlement_instruction_id = @instruction_id
  and settlement_instruction_sequence = @instruction_sequence
  and reservation_id = @reservation_id
limit 1;
""";
        command.Parameters.AddWithValue("authority", request.Authority);
        command.Parameters.AddWithValue("settlement_id", request.SettlementId!.Value.ToString());
        command.Parameters.AddWithValue("instruction_id", request.SettlementInstructionId!.Value.ToString());
        command.Parameters.AddWithValue("instruction_sequence", request.SettlementInstructionSequence!.Value);
        command.Parameters.AddWithValue("reservation_id", request.ReservationId!.Value);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return;

        var matches = reader.GetGuid(0) == request.WalletId
            && string.Equals(reader.GetString(1), request.Instrument.ToString(), StringComparison.Ordinal)
            && string.Equals(reader.GetString(2), request.TicketId!.Value.ToString(), StringComparison.Ordinal)
            && reader.GetInt64(3) == request.Money.Amount
            && reader.GetInt64(4) == request.BalanceImpact!.Amount
            && string.Equals(reader.GetString(5), request.SettlementInstructionHash, StringComparison.Ordinal)
            && string.Equals(reader.GetString(6), request.SettlementHash, StringComparison.Ordinal);
        if (!matches)
        {
            throw new CanonicalWalletOperationConflictException(
                "Settlement instruction is already bound to a different committed wallet application envelope.");
        }
    }

    private static async Task InsertRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CanonicalWalletOperationRequest request,
        string idempotencyKey,
        string canonicalRequestHash,
        Guid operationId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into credit_wallet_service.wallet_operation_requests (
  operation_id, request_id, idempotency_key, canonical_request_hash,
  operation_type, authority, tenant_id, brand_id, player_id, wallet_id,
  instrument_code, currency, amount_minor, balance_impact_minor, ticket_id, reservation_id,
  settlement_id, settlement_batch_id, settlement_instruction_id, settlement_instruction_sequence,
  settlement_instruction_hash, settlement_version, settlement_hash, settlement_outcome,
  ledger_instruction_id, ledger_posting_required, original_operation_id, corrects_operation_id,
  reason_code, source_service, effective_at, correlation_id, audit_metadata
)
values (
  @operation_id, @request_id, @idempotency_key, @canonical_request_hash,
  @operation_type, @authority, @tenant_id, @brand_id, @player_id, @wallet_id,
  @instrument_code, @currency, @amount_minor, @balance_impact_minor, @ticket_id, @reservation_id,
  @settlement_id, @settlement_batch_id, @settlement_instruction_id, @settlement_instruction_sequence,
  @settlement_instruction_hash, @settlement_version, @settlement_hash, @settlement_outcome,
  @ledger_instruction_id, @ledger_posting_required, @original_operation_id, @corrects_operation_id,
  @reason_code, @source_service, @effective_at, @correlation_id, cast(@audit_metadata as jsonb)
);
""";
        command.Parameters.AddWithValue("operation_id", operationId);
        command.Parameters.AddWithValue("request_id", request.RequestId);
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue("canonical_request_hash", canonicalRequestHash);
        command.Parameters.AddWithValue("operation_type", request.Operation.ToString());
        command.Parameters.AddWithValue("authority", request.Authority.Trim());
        command.Parameters.AddWithValue("tenant_id", request.TenantId);
        command.Parameters.AddWithValue("brand_id", request.BrandId);
        command.Parameters.AddWithValue("player_id", request.PlayerId);
        command.Parameters.AddWithValue("wallet_id", request.WalletId);
        command.Parameters.AddWithValue("instrument_code", request.Instrument.ToString());
        command.Parameters.AddWithValue("currency", request.Money.Currency.Trim());
        command.Parameters.AddWithValue("amount_minor", request.Money.Amount);
        command.Parameters.Add("balance_impact_minor", NpgsqlDbType.Bigint).Value =
            (object?)request.BalanceImpact?.Amount ?? DBNull.Value;
        AddNullableGuid(command, "ticket_id", request.TicketId);
        AddNullableGuid(command, "reservation_id", request.ReservationId);
        AddNullableGuid(command, "settlement_id", request.SettlementId);
        AddNullableGuid(command, "settlement_batch_id", request.SettlementBatchId);
        AddNullableGuid(command, "settlement_instruction_id", request.SettlementInstructionId);
        command.Parameters.Add("settlement_instruction_sequence", NpgsqlDbType.Bigint).Value =
            (object?)request.SettlementInstructionSequence ?? DBNull.Value;
        AddNullableText(command, "settlement_instruction_hash", request.SettlementInstructionHash);
        AddNullableText(command, "settlement_version", request.SettlementVersion);
        AddNullableText(command, "settlement_hash", request.SettlementHash);
        AddNullableText(command, "settlement_outcome", request.SettlementOutcome?.ToString());
        AddNullableGuid(command, "ledger_instruction_id", request.LedgerInstructionId);
        command.Parameters.Add("ledger_posting_required", NpgsqlDbType.Boolean).Value =
            (object?)request.LedgerPostingRequired ?? DBNull.Value;
        AddNullableGuid(command, "original_operation_id", request.OriginalOperationId);
        AddNullableGuid(command, "corrects_operation_id", request.CorrectsOperationId);
        AddNullableText(command, "reason_code", request.ReasonCode);
        AddNullableText(command, "source_service", request.SourceService);
        command.Parameters.AddWithValue("effective_at", request.EffectiveAt);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.AddWithValue(
            "audit_metadata", NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(request.AuditMetadata ?? new Dictionary<string, object?>(), JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<WalletEffect> ExecuteEffectAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CanonicalWalletOperationRequest request,
        Guid operationId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var targetIdempotencyKey = $"canonical-wallet:{operationId:N}:{request.Operation}";
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = request.Operation switch
        {
            WalletOperationType.RESERVE => """
select credit_wallet_service.reserve_wallet(
  @operation_id, @wallet_id, @tenant_id, @brand_id, @player_id, @instrument,
  @ticket_id, @amount, @currency, @target_key, @correlation_id, cast(@metadata as jsonb)
)::text;
""",
            WalletOperationType.RELEASE => """
select credit_wallet_service.release_wallet_reservation(
  @operation_id, @reservation_id, @wallet_id, @tenant_id, @brand_id, @player_id,
  @instrument, @ticket_id, @amount, @currency, @target_key, @correlation_id,
  @reason, cast(@metadata as jsonb)
)::text;
""",
            WalletOperationType.CANCEL => """
select credit_wallet_service.cancel_wallet_reservation(
  @operation_id, @reservation_id, @wallet_id, @tenant_id, @brand_id, @player_id,
  @instrument, @ticket_id, @amount, @currency, @target_key, @correlation_id,
  @reason, cast(@metadata as jsonb)
)::text;
""",
            WalletOperationType.SETTLE => """
select credit_wallet_service.apply_authoritative_wallet_settlement(
  @operation_id, @reservation_id, @wallet_id, @tenant_id, @brand_id, @player_id,
  @instrument, @ticket_id, @settlement_id, @settlement_instruction_id,
  @settlement_instruction_sequence, @settlement_instruction_hash, @settlement_version,
  @settlement_hash, @settlement_outcome, @ledger_instruction_id, @ledger_posting_required,
  @amount, @balance_impact, @currency, @authority, @source_service,
  @corrects_operation_id, @target_key, @correlation_id, cast(@metadata as jsonb)
)::text;
""",
            WalletOperationType.REVERSE => """
select credit_wallet_service.reverse_authoritative_wallet_settlement(
  @operation_id, @original_operation_id, @reservation_id, @wallet_id, @tenant_id,
  @brand_id, @player_id, @instrument, @ticket_id, @settlement_id,
  @settlement_instruction_id, @settlement_instruction_sequence,
  @settlement_instruction_hash, @settlement_version, @settlement_hash,
  @settlement_outcome, @ledger_instruction_id, @ledger_posting_required,
  @amount, @balance_impact, @currency, @authority, @source_service,
  @reason, @target_key, @correlation_id, cast(@metadata as jsonb)
)::text;
""",
            _ => throw new CanonicalWalletOperationDisabledException(
                $"{request.Operation} execution is disabled in P1-009.2.")
        };
        command.Parameters.AddWithValue("operation_id", operationId);
        command.Parameters.AddWithValue("wallet_id", request.WalletId);
        command.Parameters.AddWithValue("tenant_id", request.TenantId);
        command.Parameters.AddWithValue("brand_id", request.BrandId);
        command.Parameters.AddWithValue("player_id", request.PlayerId);
        command.Parameters.AddWithValue("instrument", request.Instrument.ToString());
        command.Parameters.AddWithValue("ticket_id", request.TicketId!.Value.ToString());
        command.Parameters.AddWithValue("amount", request.Money.Amount);
        command.Parameters.AddWithValue("currency", request.Money.Currency.Trim());
        command.Parameters.AddWithValue("target_key", targetIdempotencyKey);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.AddWithValue(
            "metadata", NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(request.AuditMetadata ?? new Dictionary<string, object?>(), JsonOptions));
        if (request.Operation is WalletOperationType.RELEASE or WalletOperationType.CANCEL or WalletOperationType.SETTLE or WalletOperationType.REVERSE)
        {
            command.Parameters.AddWithValue("reservation_id", request.ReservationId!.Value);
        }
        if (request.Operation is WalletOperationType.RELEASE or WalletOperationType.CANCEL or WalletOperationType.REVERSE)
        {
            AddNullableText(command, "reason", request.ReasonCode);
        }
        if (request.Operation is WalletOperationType.SETTLE or WalletOperationType.REVERSE)
        {
            command.Parameters.AddWithValue("settlement_id", request.SettlementId!.Value.ToString());
            command.Parameters.AddWithValue("settlement_instruction_id", request.SettlementInstructionId!.Value.ToString());
            command.Parameters.AddWithValue("settlement_instruction_sequence", request.SettlementInstructionSequence!.Value);
            command.Parameters.AddWithValue("settlement_instruction_hash", request.SettlementInstructionHash!.Trim());
            command.Parameters.AddWithValue("settlement_version", request.SettlementVersion!.Trim());
            command.Parameters.AddWithValue("settlement_hash", request.SettlementHash!.Trim());
            command.Parameters.AddWithValue("settlement_outcome", request.SettlementOutcome!.Value.ToString());
            command.Parameters.Add("ledger_instruction_id", NpgsqlDbType.Uuid).Value =
                (object?)request.LedgerInstructionId ?? DBNull.Value;
            command.Parameters.AddWithValue("ledger_posting_required", request.LedgerPostingRequired!.Value);
            command.Parameters.AddWithValue("balance_impact", request.BalanceImpact!.Amount);
            command.Parameters.AddWithValue("authority", request.Authority.Trim());
            command.Parameters.AddWithValue("source_service", request.SourceService!.Trim());
            AddNullableGuid(command, "corrects_operation_id", request.CorrectsOperationId);
            AddNullableGuid(command, "original_operation_id", request.OriginalOperationId);
        }

        var json = (string?)await command.ExecuteScalarAsync(cancellationToken)
            ?? throw new CanonicalWalletOperationValidationException("Wallet operation returned no effect.");
        var payload = JsonSerializer.Deserialize<Dictionary<string, object?>>(json, JsonOptions)
            ?? new Dictionary<string, object?>();
        var referenceId = FindJsonString(payload, "id") ?? operationId.ToString("D");
        var referenceType = request.Operation is WalletOperationType.SETTLE or WalletOperationType.REVERSE
            ? "credit_settlement_application"
            : request.Operation == WalletOperationType.CANCEL
                ? "credit_reservation_cancellation"
                : "credit_reservation";
        return new WalletEffect(referenceType, referenceId, payload);
    }

    private static async Task<OperationRequestRecord?> FindRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select operation_id, request_id, idempotency_key, canonical_request_hash, operation_type, instrument_code
from credit_wallet_service.wallet_operation_requests
where idempotency_key = @idempotency_key;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new OperationRequestRecord(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
                Enum.Parse<WalletOperationType>(reader.GetString(4)),
                Enum.Parse<WalletInstrumentType>(reader.GetString(5)))
            : null;
    }

    private static async Task<OperationTerminalRecord?> FindTerminalResultAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid operationId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select terminal_status, effect_reference_type, effect_reference_id, result_payload::text,
       result_hash, completed_at
from credit_wallet_service.wallet_operation_terminal_results
where operation_id = @operation_id;
""";
        command.Parameters.AddWithValue("operation_id", operationId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new OperationTerminalRecord(
            Enum.Parse<WalletOperationTerminalStatus>(reader.GetString(0)),
            reader.IsDBNull(1) ? null : reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetString(2),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(3), JsonOptions)
                ?? new Dictionary<string, object?>(),
            reader.GetString(4), reader.GetFieldValue<DateTimeOffset>(5));
    }

    private static async Task<OperationTerminalRecord> AppendTerminalResultAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid operationId,
        string status,
        string? referenceType,
        string? referenceId,
        IReadOnlyDictionary<string, object?> payload,
        string? failureCode,
        string? failureReason,
        CancellationToken cancellationToken)
    {
        var completedAt = DateTimeOffset.UtcNow;
        var resultHash = CanonicalWalletRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["effectReferenceId"] = referenceId,
                ["effectReferenceType"] = referenceType,
                ["failureCode"] = failureCode,
                ["failureReason"] = failureReason,
                ["operationId"] = operationId.ToString("D"),
                ["resultPayload"] = payload,
                ["terminalStatus"] = status
            });
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into credit_wallet_service.wallet_operation_terminal_results (
  terminal_result_id, operation_id, terminal_status, effect_reference_type,
  effect_reference_id, result_payload, result_hash, failure_code, failure_reason, completed_at
)
values (
  @id, @operation_id, @status, @reference_type, @reference_id,
  cast(@payload as jsonb), @result_hash, @failure_code, @failure_reason, @completed_at
);
""";
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("operation_id", operationId);
        command.Parameters.AddWithValue("status", status);
        AddNullableText(command, "reference_type", referenceType);
        AddNullableText(command, "reference_id", referenceId);
        command.Parameters.AddWithValue("payload", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(payload, JsonOptions));
        command.Parameters.AddWithValue("result_hash", resultHash);
        AddNullableText(command, "failure_code", failureCode);
        AddNullableText(command, "failure_reason", failureReason);
        command.Parameters.AddWithValue("completed_at", completedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return new OperationTerminalRecord(
            Enum.Parse<WalletOperationTerminalStatus>(status), referenceType, referenceId,
            payload, resultHash, completedAt);
    }

    private static async Task AppendAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid operationId,
        string result,
        DateTimeOffset startedAt,
        string? failureCode,
        string? failureReason,
        string resultHash,
        IReadOnlyDictionary<string, object?>? metadata,
        CancellationToken cancellationToken)
    {
        var completedAt = DateTimeOffset.UtcNow;
        await using var number = connection.CreateCommand();
        number.Transaction = transaction;
        number.CommandText = "select coalesce(max(attempt_number), 0) + 1 from credit_wallet_service.wallet_operation_attempts where operation_id = @id;";
        number.Parameters.AddWithValue("id", operationId);
        var attemptNumber = Convert.ToInt32(await number.ExecuteScalarAsync(cancellationToken));
        var evidenceHash = CanonicalWalletRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["attemptNumber"] = attemptNumber,
                ["failureCode"] = failureCode,
                ["failureReason"] = failureReason,
                ["operationId"] = operationId.ToString("D"),
                ["result"] = result,
                ["resultHash"] = resultHash
            });
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into credit_wallet_service.wallet_operation_attempts (
  attempt_id, operation_id, attempt_number, result, started_at, completed_at,
  failure_code, failure_reason, canonical_evidence_hash, audit_metadata
)
values (
  @id, @operation_id, @attempt_number, @result, @started_at, @completed_at,
  @failure_code, @failure_reason, @evidence_hash, cast(@metadata as jsonb)
);
""";
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("operation_id", operationId);
        command.Parameters.AddWithValue("attempt_number", attemptNumber);
        command.Parameters.AddWithValue("result", result);
        command.Parameters.AddWithValue("started_at", startedAt);
        command.Parameters.AddWithValue("completed_at", completedAt);
        AddNullableText(command, "failure_code", failureCode);
        AddNullableText(command, "failure_reason", failureReason);
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        command.Parameters.AddWithValue(
            "metadata", NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(metadata ?? new Dictionary<string, object?>(), JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!Configured) throw new DurableCreditWalletRepositoryException("DATABASE_URL is not configured.");
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static CanonicalWalletOperationResponse MapResponse(
        OperationRequestRecord request,
        OperationTerminalRecord terminal,
        bool reused,
        string correlationId) => new(
            request.OperationId, request.RequestId, request.IdempotencyKey,
            request.CanonicalRequestHash, request.Operation, request.Instrument,
            terminal.Status, reused, terminal.ReferenceType, terminal.ReferenceId,
            terminal.ResultHash, terminal.Payload, correlationId, terminal.CompletedAt);

    private static string? FindJsonString(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return null;
        return value is JsonElement element ? element.ToString() : value.ToString();
    }

    private static void AddNullableText(NpgsqlCommand command, string name, string? value) =>
        command.Parameters.Add(name, NpgsqlDbType.Text).Value =
            string.IsNullOrWhiteSpace(value) ? DBNull.Value : value.Trim();

    private static void AddNullableGuid(NpgsqlCommand command, string name, Guid? value) =>
        command.Parameters.Add(name, NpgsqlDbType.Uuid).Value = (object?)value ?? DBNull.Value;

    private sealed record OperationRequestRecord(
        Guid OperationId,
        Guid RequestId,
        string IdempotencyKey,
        string CanonicalRequestHash,
        WalletOperationType Operation,
        WalletInstrumentType Instrument);

    private sealed record OperationTerminalRecord(
        WalletOperationTerminalStatus Status,
        string? ReferenceType,
        string? ReferenceId,
        IReadOnlyDictionary<string, object?> Payload,
        string ResultHash,
        DateTimeOffset CompletedAt);

    private sealed record WalletEffect(
        string ReferenceType,
        string ReferenceId,
        IReadOnlyDictionary<string, object?> Payload);
}
