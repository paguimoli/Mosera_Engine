using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CreditWalletService.Configuration;
using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

namespace CreditWalletService.Application;

public sealed class CreditWalletAuthorityService(
    ServiceConfiguration configuration,
    CanonicalWalletOperationRepository canonicalRepository,
    CreditWalletRecoveryRepository recoveryRepository,
    CreditWalletAuthorityRepository authorityRepository,
    InternalServiceAuthorizer internalServiceAuthorizer)
{
    private const string BuildVersion = "credit-wallet-authority-guardrails-v1";
    private const string QaMarker = "credit-wallet-p1-009.5";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<CreditWalletAuthorityReadinessReport> BuildReadinessReportAsync(
        CreditWalletAuthorityMode? requestedMode,
        CancellationToken cancellationToken)
    {
        var configuredMode = ResolveConfiguredMode();
        var mode = requestedMode ?? configuredMode;
        var durableReady = await authorityRepository.CheckReadinessAsync(cancellationToken);
        var canonicalReady = await canonicalRepository.CheckReadinessAsync(cancellationToken);
        var recoveryReady = await recoveryRepository.CheckReadinessAsync(cancellationToken);
        var migrationVersion = durableReady
            ? await authorityRepository.GetMigrationVersionAsync(cancellationToken)
            : "UNAVAILABLE";
        var snapshot = durableReady
            ? await authorityRepository.GetOperationalSnapshotAsync(cancellationToken)
            : EmptySnapshot();
        var latestPromotion = durableReady
            ? await authorityRepository.GetLatestEvidenceReferenceAsync("PROMOTION_REHEARSAL", cancellationToken)
            : null;
        var latestRollback = durableReady
            ? await authorityRepository.GetLatestEvidenceReferenceAsync("ROLLBACK_REHEARSAL", cancellationToken)
            : null;
        var passingPromotion = latestPromotion?.Result == "PASS";
        var passingRollback = latestRollback?.Result == "PASS";
        var rehearsalEnvironment = ClassifyRehearsalEnvironment();

        var findings = new List<CreditWalletAuthorityFinding>();
        AddGate(findings, "DURABLE_PERSISTENCE", durableReady,
            "Durable Credit Wallet authority evidence is reachable.",
            "Durable Credit Wallet persistence or authority evidence is unavailable.",
            "Restore DATABASE_URL connectivity and apply the current migrations.", migrationVersion);
        AddGate(findings, "CANONICAL_OPERATIONS", canonicalReady,
            "Canonical wallet request, attempt, and terminal evidence is ready.",
            "Canonical wallet operation persistence is unavailable.",
            "Restore the canonical operation repository.", "credit_wallet_service.wallet_operation_requests");
        AddGate(findings, "WALLET_INSTRUMENTS", canonicalReady,
            "Immutable wallet instrument definitions are ready.",
            "Wallet instrument definitions are unavailable.",
            "Restore immutable wallet instrument definitions.", "credit_wallet_service.wallet_instrument_definitions");
        AddGate(findings, "SCOPE_VALIDATION", canonicalReady,
            "Tenant, brand, player, wallet, instrument, and currency scope validation is ready.",
            "Wallet scope validation is unavailable.",
            "Restore wallet scope invariants.", "credit_wallet_service.wallet_scopes");
        AddGate(findings, "IDEMPOTENCY", canonicalReady,
            "Conflict-safe canonical idempotency is ready.",
            "Conflict-safe idempotency is unavailable.",
            "Restore the unique idempotency and canonical hash invariants.", "wallet_operation_requests.idempotency_key");
        AddGate(findings, "RESERVATION_LIFECYCLE", canonicalReady,
            "Reserve, release, cancel, capture, reversal, and correction invariants are ready.",
            "Reservation lifecycle invariants are unavailable.",
            "Restore reservation lifecycle constraints and canonical functions.", "public.credit_reservations");
        AddGate(findings, "SETTLEMENT_AUTHENTICATION", canonicalReady && internalServiceAuthorizer.ProductionReady,
            "Settlement provenance and authenticated caller validation are ready.",
            "Authenticated Settlement provenance is not production-ready.",
            "Configure internal service authentication and retain Settlement provenance.", "settlement_instruction_authentication_evidence");
        AddGate(findings, "LEDGER_COORDINATION", canonicalReady && snapshot.InvalidLedgerReferenceCount == 0,
            "Required Ledger references are complete.",
            "One or more wallet settlement effects lack required Ledger references.",
            "Resolve the originating Ledger instruction through Ledger Authority.", "public.credit_settlement_applications");
        AddGate(findings, "RECOVERY", recoveryReady,
            "Recovery classification and governed retry are ready.",
            "Recovery classification is unavailable.",
            "Restore the recovery repository and startup scan.", "credit_wallet_service.wallet_recovery_evidence");
        AddGate(findings, "REPLAY", recoveryReady,
            "Deterministic replay verification is ready.",
            "Replay verification is unavailable.",
            "Restore append-only replay verification.", "credit_wallet_service.wallet_replay_evidence");
        AddGate(findings, "RECONCILIATION", recoveryReady
                && snapshot.ProjectionDriftCount == 0
                && snapshot.LedgerMismatchCount == 0
                && snapshot.SettlementMismatchCount == 0,
            "Projection, Ledger, and Settlement verification have no unresolved drift.",
            "Reconciliation contains unresolved drift or mismatch evidence.",
            "Resolve discrepancies in the owning authority; Credit Wallet must not compensate or repair automatically.",
            "wallet_projection_verifications|wallet_reconciliation_evidence");
        AddGate(findings, "IMMUTABLE_EVIDENCE", durableReady && recoveryReady && canonicalReady,
            "Operational, recovery, replay, and authority evidence is append-only.",
            "Append-only evidence invariants are unavailable.",
            "Restore mutation-blocking database triggers.", "credit_wallet_service.prevent_evidence_mutation");
        AddGate(findings, "INTERNAL_AUTHENTICATION", internalServiceAuthorizer.ProductionReady,
            "Internal caller identity validation is configured.",
            "Internal service authentication credentials are not production-ready.",
            "Configure the existing internal service authentication boundary.", "CREDIT_WALLET_INTERNAL_AUTH_REQUIRED");
        if (internalServiceAuthorizer.ProductionCredentialReady)
        {
            findings.Add(new("PRODUCTION_CREDENTIAL", CreditWalletAuthorityFindingClassification.READY,
                "Internal authentication uses a non-placeholder production credential.", "CREDIT_WALLET",
                "No action required.", "CREDIT_WALLET_INTERNAL_API_KEY"));
        }
        else
        {
            findings.Add(new("PRODUCTION_CREDENTIAL",
                mode == CreditWalletAuthorityMode.SERVICE
                    ? CreditWalletAuthorityFindingClassification.BLOCKED
                    : CreditWalletAuthorityFindingClassification.WARNING,
                "The configured internal credential is local, missing, short, or placeholder-like.",
                "CREDIT_WALLET",
                "Inject a rotated production credential through the approved secret-management path before promotion.",
                "CREDIT_WALLET_INTERNAL_API_KEY"));
        }
        AddGate(findings, "DATABASE_INVARIANTS", durableReady && canonicalReady && recoveryReady,
            "Database invariants and deterministic lookup structures are ready.",
            "Database invariants are incomplete or unreachable.",
            "Apply and validate the current Credit Wallet migrations.", migrationVersion);

        if (snapshot.IncompleteOperationCount > 0)
        {
            findings.Add(Blocked("INCOMPLETE_OPERATIONS",
                $"{snapshot.IncompleteOperationCount} canonical operation(s) remain incomplete.",
                "Allow the existing recovery classifier to classify the unresolved operation; stop on BLOCKED or CONFLICT.",
                "wallet_operation_terminal_results"));
        }
        if (snapshot.ConflictOperationCount > 0)
        {
            findings.Add(Blocked("CONFLICT_OPERATIONS",
                $"{snapshot.ConflictOperationCount} conflict evidence item(s) remain unresolved.",
                "Resolve the originating instruction conflict in its owning authority.",
                "wallet_recovery_evidence:CONFLICT"));
        }

        findings.Add(new(
            "PROJECTION_REPAIR_POLICY",
            CreditWalletAuthorityFindingClassification.INFORMATION,
            "Projection reconstruction is verification-only and never repairs wallet state.",
            "CREDIT_WALLET",
            "No Credit Wallet action; projection repair remains intentionally manual and outside this authority.",
            "POLICY:INTENTIONALLY_MANUAL"));
        findings.Add(new(
            "NO_AUTOMATIC_COMPENSATION",
            CreditWalletAuthorityFindingClassification.INFORMATION,
            "Credit Wallet classifies unresolved work, preserves evidence, and stops.",
            "CREDIT_WALLET",
            "Any corrective instruction must originate from the appropriate business authority.",
            "POLICY:NO_AUTOMATIC_COMPENSATION"));

        if (mode == CreditWalletAuthorityMode.SERVICE)
        {
            if (!passingPromotion)
            {
                findings.Add(Blocked("PROMOTION_REHEARSAL_REQUIRED",
                    "No passing immutable promotion rehearsal evidence exists.",
                    "Complete a SERVICE_SHADOW or SERVICE_DRY_RUN rehearsal without switching authority.",
                    "wallet_authority_evidence:PROMOTION_REHEARSAL"));
            }
            if (!passingRollback)
            {
                findings.Add(Blocked("ROLLBACK_REHEARSAL_REQUIRED",
                    "No passing immutable rollback rehearsal evidence exists.",
                    "Complete a simulated SERVICE to MONOLITH rollback rehearsal.",
                    "wallet_authority_evidence:ROLLBACK_REHEARSAL"));
            }
            findings.Add(Blocked("PRODUCTION_AUTHORITY_DISABLED",
                "Production Credit Wallet SERVICE authority activation is intentionally disabled in this phase.",
                "Complete P1-009.6 final verification before any separately approved promotion.",
                "CREDIT_AUTHORITY=MONOLITH"));
        }

        var blocking = findings.Any(item => item.Classification == CreditWalletAuthorityFindingClassification.BLOCKED);
        var promotionAllowed = !blocking && mode is CreditWalletAuthorityMode.SERVICE_SHADOW or CreditWalletAuthorityMode.SERVICE_DRY_RUN;
        var markers = BuildMarkers(durableReady, canonicalReady, recoveryReady, internalServiceAuthorizer.ProductionReady);
        var fingerprint = Hash(JsonSerializer.Serialize(new
        {
            buildVersion = BuildVersion,
            qaMarker = QaMarker,
            configuredMode,
            evaluatedMode = mode,
            migrationVersion,
            durableReady,
            canonicalReady,
            recoveryReady,
            internalAuthenticationReady = internalServiceAuthorizer.ProductionReady,
            productionCredentialReady = internalServiceAuthorizer.ProductionCredentialReady,
            noSilentFallback = true,
            projectionRepairPolicy = "INTENTIONALLY_MANUAL",
            rehearsalEnvironment,
            latestPromotion,
            latestRollback,
            markers,
            gateStates = findings
                .Where(item => item.Code is not "PROJECTION_REPAIR_POLICY" and not "NO_AUTOMATIC_COMPENSATION")
                .Select(item => new { item.Code, item.Classification })
                .OrderBy(item => item.Code)
        }, JsonOptions));

        return new(
            configuredMode, mode, true, durableReady, canonicalReady, canonicalReady, canonicalReady,
            canonicalReady, canonicalReady, canonicalReady && internalServiceAuthorizer.ProductionReady,
            canonicalReady && snapshot.InvalidLedgerReferenceCount == 0, recoveryReady, recoveryReady,
            recoveryReady && snapshot.ProjectionDriftCount == 0 && snapshot.LedgerMismatchCount == 0
                && snapshot.SettlementMismatchCount == 0,
            durableReady && recoveryReady && canonicalReady, internalServiceAuthorizer.ProductionReady,
            internalServiceAuthorizer.ProductionCredentialReady,
            durableReady && canonicalReady && recoveryReady, passingPromotion, passingRollback,
            true, promotionAllowed, false, false, "INTENTIONALLY_MANUAL", markers,
            findings.OrderBy(item => item.Classification).ThenBy(item => item.Code, StringComparer.Ordinal).ToArray(),
            snapshot, migrationVersion, rehearsalEnvironment, latestPromotion, latestRollback,
            fingerprint, DateTimeOffset.UtcNow);
    }

    public async Task<CreditWalletPromotionRehearsalResult> RunPromotionRehearsalAsync(
        CreditWalletPromotionRehearsalRequest request,
        CancellationToken cancellationToken)
    {
        if (request.AuthorityMode is not (CreditWalletAuthorityMode.SERVICE_SHADOW or CreditWalletAuthorityMode.SERVICE_DRY_RUN))
        {
            throw new CreditWalletAuthorityValidationException(
                "Promotion rehearsal requires SERVICE_SHADOW or SERVICE_DRY_RUN; authority is not switched.");
        }
        ValidateOperator(request.OperatorReference);
        var readiness = await BuildReadinessReportAsync(request.AuthorityMode, cancellationToken);
        var findings = readiness.Findings.ToList();
        AddRepresentativeEvidenceGate(findings, "RESERVE_REHEARSAL", readiness.Snapshot.ReserveCount, "reserve");
        AddRepresentativeEvidenceGate(findings, "RELEASE_REHEARSAL", readiness.Snapshot.ReleaseCount, "release");
        AddRepresentativeEvidenceGate(findings, "CANCEL_REHEARSAL", readiness.Snapshot.CancelCount, "cancel");
        AddRepresentativeEvidenceGate(findings, "CAPTURE_REHEARSAL", readiness.Snapshot.CaptureCount, "capture/settlement");
        AddRepresentativeEvidenceGate(findings, "REVERSAL_REHEARSAL", readiness.Snapshot.ReversalCount, "reversal");
        AddRepresentativeEvidenceGate(findings, "CORRECTION_REHEARSAL", readiness.Snapshot.CorrectionCount, "correction");
        AddRepresentativeEvidenceGate(findings, "RECOVERY_REHEARSAL", readiness.Snapshot.RecoveryEvidenceCount, "recovery");
        AddRepresentativeEvidenceGate(findings, "REPLAY_REHEARSAL", readiness.Snapshot.ReplayMatchCount, "replay");
        var result = findings.Any(item => item.Classification == CreditWalletAuthorityFindingClassification.BLOCKED)
            ? "BLOCKED" : "PASS";
        var payload = EvidencePayload(new
        {
            request.AuthorityMode,
            operatorReference = request.OperatorReference.Trim(),
            readinessGateFingerprint = BuildRehearsalGateFingerprint(readiness),
            rehearsalEnvironment = readiness.RehearsalEnvironmentClassification,
            readiness.Snapshot,
            result,
            findings = findings.OrderBy(item => item.Code),
            rollbackAuthority = CreditWalletAuthorityMode.MONOLITH,
            authoritySwitched = false
        });
        var evidence = await PersistAsync("PROMOTION_REHEARSAL", request.AuthorityMode, result,
            readiness, payload, request.OperatorReference, cancellationToken);
        return new(readiness, evidence, findings.OrderBy(item => item.Code).ToArray(),
            CreditWalletAuthorityMode.MONOLITH, false);
    }

    public async Task<CreditWalletRollbackRehearsalResult> RunRollbackRehearsalAsync(
        CreditWalletRollbackRehearsalRequest request,
        CancellationToken cancellationToken)
    {
        if (request.SourceAuthority != CreditWalletAuthorityMode.SERVICE
            || request.TargetAuthority != CreditWalletAuthorityMode.MONOLITH)
        {
            throw new CreditWalletAuthorityValidationException(
                "Rollback rehearsal must simulate SERVICE to MONOLITH.");
        }
        ValidateOperator(request.OperatorReference);
        var readiness = await BuildReadinessReportAsync(CreditWalletAuthorityMode.SERVICE_DRY_RUN, cancellationToken);
        var snapshot = readiness.Snapshot;
        var duplicate = snapshot.ConflictOperationCount > 0;
        var lost = snapshot.IncompleteOperationCount > 0;
        var balanceDrift = snapshot.ProjectionDriftCount > 0;
        var reservationDrift = snapshot.ProjectionDriftCount > 0;
        var reconciliationDrift = snapshot.LedgerMismatchCount > 0 || snapshot.SettlementMismatchCount > 0;
        var result = duplicate || lost || balanceDrift || reservationDrift || reconciliationDrift ? "BLOCKED" : "PASS";
        var payload = EvidencePayload(new
        {
            request.SourceAuthority,
            request.TargetAuthority,
            operatorReference = request.OperatorReference.Trim(),
            duplicate,
            lost,
            balanceDrift,
            reservationDrift,
            reconciliationDrift,
            automaticFallbackEnabled = false,
            result,
            readinessGateFingerprint = BuildRehearsalGateFingerprint(readiness),
            rehearsalEnvironment = readiness.RehearsalEnvironmentClassification,
            authoritySwitched = false
        });
        var evidence = await PersistAsync("ROLLBACK_REHEARSAL", CreditWalletAuthorityMode.SERVICE_DRY_RUN,
            result, readiness, payload, request.OperatorReference, cancellationToken);
        return new(request.SourceAuthority, request.TargetAuthority, duplicate, lost, balanceDrift,
            reservationDrift, reconciliationDrift, false, result, evidence, false);
    }

    public async Task<CreditWalletAuthorityVerificationResult> VerifyAsync(
        CreditWalletAuthorityMode? mode,
        string operatorReference,
        CancellationToken cancellationToken)
    {
        ValidateOperator(operatorReference);
        var readiness = await BuildReadinessReportAsync(mode, cancellationToken);
        var result = readiness.Findings.Any(item => item.Classification == CreditWalletAuthorityFindingClassification.BLOCKED)
            ? "BLOCKED" : "PASS";
        var readinessPayload = EvidencePayload(new
        {
            readiness.EvaluatedAuthorityMode,
            readiness.ReadinessFingerprint,
            readiness.CapabilityMarkers,
            readiness.MigrationVersion,
            readiness.RehearsalEnvironmentClassification,
            readiness.LatestPromotionRehearsal,
            readiness.LatestRollbackRehearsal,
            result
        });
        var guardrailPayload = EvidencePayload(new
        {
            readiness.EvaluatedAuthorityMode,
            readiness.PromotionAllowed,
            readiness.NoSilentFallback,
            readiness.ServiceAuthorityEnabled,
            readiness.ProductionAuthorityActivationEnabled,
            result
        });
        var blockerPayload = EvidencePayload(new
        {
            readiness.EvaluatedAuthorityMode,
            findings = readiness.Findings.OrderBy(item => item.Code),
            result
        });
        var readinessEvidence = await PersistAsync("READINESS_VERIFICATION", readiness.EvaluatedAuthorityMode,
            result, readiness, readinessPayload, operatorReference, cancellationToken);
        var guardrailEvidence = await PersistAsync("GUARDRAIL_EVALUATION", readiness.EvaluatedAuthorityMode,
            result, readiness, guardrailPayload, operatorReference, cancellationToken);
        var blockerEvidence = await PersistAsync("BLOCKER_EVALUATION", readiness.EvaluatedAuthorityMode,
            result, readiness, blockerPayload, operatorReference, cancellationToken);
        return new(readiness, readinessEvidence, guardrailEvidence, blockerEvidence, false);
    }

    private async Task<CreditWalletAuthorityEvidenceDto> PersistAsync(
        string evidenceType,
        CreditWalletAuthorityMode mode,
        string result,
        CreditWalletAuthorityReadinessReport readiness,
        IReadOnlyDictionary<string, object?> payload,
        string operatorReference,
        CancellationToken cancellationToken)
    {
        var configurationHash = Hash(JsonSerializer.Serialize(new
        {
            buildVersion = BuildVersion,
            configuredMode = readiness.ConfiguredAuthorityMode,
            requestedMode = mode,
            internalAuthRequired = configuration.InternalAuthorization.Required,
            databaseConfigured = authorityRepository.Configured,
            automaticFallbackEnabled = false
        }, JsonOptions));
        var payloadHash = Hash(JsonSerializer.Serialize(payload, JsonOptions));
        return await authorityRepository.PersistEvidenceAsync(
            DeterministicGuid(payloadHash), evidenceType, mode, result, configurationHash,
            readiness.ReadinessFingerprint, payloadHash, payload, operatorReference.Trim(), cancellationToken);
    }

    private static IReadOnlyDictionary<string, object?> EvidencePayload<T>(T value) =>
        JsonSerializer.Deserialize<Dictionary<string, object?>>(
            JsonSerializer.Serialize(value, JsonOptions), JsonOptions)!;

    private static string BuildRehearsalGateFingerprint(CreditWalletAuthorityReadinessReport readiness)
    {
        return Hash(JsonSerializer.Serialize(new
        {
            readiness.ConfiguredAuthorityMode,
            readiness.EvaluatedAuthorityMode,
            readiness.DurablePersistenceReady,
            readiness.CanonicalOperationsReady,
            readiness.RecoveryReady,
            readiness.ReplayReady,
            readiness.ReconciliationReady,
            readiness.InternalAuthenticationReady,
            readiness.ProductionCredentialReady,
            readiness.CapabilityMarkers,
            readiness.Snapshot,
            readiness.MigrationVersion,
            readiness.RehearsalEnvironmentClassification,
            blockers = readiness.Findings
                .Where(item => item.Classification == CreditWalletAuthorityFindingClassification.BLOCKED)
                .Select(item => item.Code)
                .OrderBy(item => item, StringComparer.Ordinal)
        }, JsonOptions));
    }

    private string ClassifyRehearsalEnvironment()
    {
        if (!authorityRepository.Configured) return "NON_DURABLE";
        var builder = new Npgsql.NpgsqlConnectionStringBuilder(
            PostgresConnectionString.Normalize(configuration.Database.Url));
        var localHost = builder.Host is "localhost" or "127.0.0.1" or "::1" or "local-postgres";
        var database = builder.Database ?? string.Empty;
        if (localHost || database.Contains("local", StringComparison.OrdinalIgnoreCase)
            || database.Contains("disposable", StringComparison.OrdinalIgnoreCase))
        {
            return "LOCAL_DISPOSABLE";
        }
        return string.Equals(configuration.Environment, "Production", StringComparison.OrdinalIgnoreCase)
            ? "PRODUCTION_MANAGED"
            : "NON_PRODUCTION_MANAGED";
    }

    private static void AddRepresentativeEvidenceGate(
        ICollection<CreditWalletAuthorityFinding> findings,
        string code,
        int artifactCount,
        string operation)
    {
        if (artifactCount > 0)
        {
            findings.Add(new(code, CreditWalletAuthorityFindingClassification.READY,
                $"Representative immutable {operation} evidence exists ({artifactCount}).", "CREDIT_WALLET",
                "No action required.", $"wallet_operation_requests:{operation}"));
            return;
        }
        findings.Add(Blocked(code,
            $"Representative immutable {operation} evidence is absent.",
            $"Exercise the existing canonical {operation} path in a non-authoritative rehearsal.",
            $"wallet_operation_requests:{operation}"));
    }

    private static void AddGate(
        ICollection<CreditWalletAuthorityFinding> findings,
        string code,
        bool ready,
        string readyReason,
        string blockedReason,
        string requiredAction,
        string evidenceReference) =>
        findings.Add(ready
            ? new(code, CreditWalletAuthorityFindingClassification.READY, readyReason, "CREDIT_WALLET",
                "No action required.", evidenceReference)
            : Blocked(code, blockedReason, requiredAction, evidenceReference));

    private static CreditWalletAuthorityFinding Blocked(
        string code, string reason, string requiredAction, string evidenceReference) =>
        new(code, CreditWalletAuthorityFindingClassification.BLOCKED, reason, "CREDIT_WALLET",
            requiredAction, evidenceReference);

    private static IReadOnlyList<string> BuildMarkers(
        bool durableReady, bool canonicalReady, bool recoveryReady, bool securityReady)
    {
        var markers = new SortedSet<string>(StringComparer.Ordinal)
        {
            "authority-mode-validation",
            "no-silent-fallback",
            "production-authority-disabled",
            "projection-repair-intentionally-manual",
            "no-automatic-compensation",
            QaMarker
        };
        if (durableReady) markers.Add("durable-authority-evidence");
        if (canonicalReady)
        {
            markers.Add("canonical-wallet-operations");
            markers.Add("wallet-instrument-governance");
            markers.Add("conflict-safe-idempotency");
            markers.Add("reservation-lifecycle");
        }
        if (recoveryReady)
        {
            markers.Add("recovery-classification");
            markers.Add("replay-verification");
            markers.Add("cross-authority-reconciliation");
        }
        if (securityReady) markers.Add("internal-service-authentication");
        return markers.ToArray();
    }

    private static CreditWalletAuthorityOperationalSnapshot EmptySnapshot() =>
        new(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    private static void ValidateOperator(string operatorReference)
    {
        if (string.IsNullOrWhiteSpace(operatorReference) || operatorReference.Length > 200)
        {
            throw new CreditWalletAuthorityValidationException("A valid operatorReference is required for evidence attribution.");
        }
    }

    private static CreditWalletAuthorityMode ResolveConfiguredMode()
    {
        var value = Environment.GetEnvironmentVariable("CREDIT_AUTHORITY");
        if (string.IsNullOrWhiteSpace(value)) return CreditWalletAuthorityMode.MONOLITH;
        return Enum.TryParse<CreditWalletAuthorityMode>(value.Trim(), true, out var mode)
            ? mode
            : throw new CreditWalletAuthorityValidationException($"Unsupported CREDIT_AUTHORITY mode '{value}'.");
    }

    private static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";

    private static Guid DeterministicGuid(string value) =>
        new(SHA256.HashData(Encoding.UTF8.GetBytes(value))[..16]);
}
