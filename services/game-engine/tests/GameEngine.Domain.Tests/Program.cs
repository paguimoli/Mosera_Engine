using GameEngine.Domain.Model;

var metadata = new DrawGenerationMetadata(
    "module-version",
    "draw-generator-version",
    "prng-provider-version",
    "draw-authority-version",
    "algorithm-version",
    "payload-hash");

var result = new OfficialCertifiedDrawResult(
    Guid.NewGuid(),
    Guid.NewGuid(),
    Guid.NewGuid(),
    "qa-operator",
    DateTimeOffset.UtcNow,
    metadata);

if (result.Metadata.PrngProviderVersion != "prng-provider-version")
{
    throw new InvalidOperationException("Certified result metadata must preserve PRNG provider version.");
}

if (!Enum.IsDefined(GameModuleLifecycleStatus.ProductionActive))
{
    throw new InvalidOperationException("Game module lifecycle must include ProductionActive.");
}

var validation = ValidationResult.Failure(new ValidationError(
    ValidationCode.InvalidTicket,
    "ticket",
    "Ticket is invalid.",
    ValidationSeverity.Error));

if (validation.IsValid || validation.Errors.First().Code != ValidationCode.InvalidTicket)
{
    throw new InvalidOperationException("Validation model must expose structured error codes.");
}

var amount = new GameEvaluationAmount("USD", 10m, 20m, 10m);
if (amount.NetAmount != 10m)
{
    throw new InvalidOperationException("Evaluation amount must preserve settlement-ready monetary facts.");
}

var signature = new SignatureMetadata(
    "signing-key-id",
    "sha256-v1",
    "ed25519-v1",
    "signature",
    DateTimeOffset.UtcNow);

var manifest = new GameManifestV1(
    Guid.NewGuid(),
    Guid.NewGuid(),
    "PICK3",
    "Pick 3",
    "Lottery",
    ["US-NJ"],
    ["straight-v1"],
    ["outcome-strategy:number-sequence:v1"],
    ["math-model:pick3:v1"],
    ["paytable:pick3:v1"],
    ["settlement-policy:standard:v1"],
    new Dictionary<string, object?> { ["salesCloseOffsetMinutes"] = -5 },
    new Dictionary<string, object?> { ["correctionPolicy"] = "supersession-only" },
    new Dictionary<string, object?> { ["replay"] = "approval-required" },
    "cert-pack:pick3:v1",
    "regulator-profile:test",
    OperatorApprovalState.Approved,
    GameManifestLifecycleState.GovernanceApproved,
    DateTimeOffset.UtcNow,
    null,
    "1.0.0",
    "sha256:manifest",
    signature);

if (manifest.OutcomeStrategyReferences.Single() != "outcome-strategy:number-sequence:v1")
{
    throw new InvalidOperationException("Game Manifest must preserve outcome strategy references.");
}

var certificate = new AuthorityCertificate(
    Guid.NewGuid(),
    "outcome-authority",
    AuthorityCertificateType.OutcomeStrategy,
    "outcome-strategy:number-sequence",
    "1.0.0",
    "sha256:payload",
    [new CertificateReference(null, "sha256:previous")],
    "signing-key-id",
    "sha256-v1",
    "ed25519-v1",
    DateTimeOffset.UtcNow,
    "regulator-profile:test",
    AuthorityCertificateApprovalState.Approved,
    null,
    null,
    new Dictionary<string, object?> { ["dryRun"] = false });

if (certificate.CertificateType != AuthorityCertificateType.OutcomeStrategy ||
    certificate.PreviousCertificates.Single().CertificateHash != "sha256:previous")
{
    throw new InvalidOperationException("Authority certificate must preserve type and hash-chain references.");
}

var outcomeStrategy = new OutcomeStrategyDefinitionV1(
    Guid.NewGuid(),
    "outcome-strategy:number-set",
    "1.0.0",
    [
        new OutcomeDslPrimitive(
            "numbers",
            OutcomePrimitiveType.UniqueNumberSet,
            [],
            1,
            80,
            20,
            [1, 2, 3],
            [],
            [],
            new Dictionary<string, object?>()),
        new OutcomeDslPrimitive(
            "bonus",
            OutcomePrimitiveType.WeightedSelection,
            ["numbers"],
            null,
            null,
            null,
            [],
            [],
            [new WeightedOutcomeOption("RED", 1m), new WeightedOutcomeOption("BLUE", 2m)],
            new Dictionary<string, object?>()),
        new OutcomeDslPrimitive(
            "composite",
            OutcomePrimitiveType.CompositeOutcomeGraph,
            ["numbers", "bonus"],
            null,
            null,
            null,
            [],
            [],
            [],
            new Dictionary<string, object?>())
    ],
    new Dictionary<string, object?> { ["drawId"] = "uuid" },
    new Dictionary<string, object?> { ["resultType"] = "number-set" },
    new Dictionary<string, object?> { ["maxAttempts"] = 1 },
    ["regulator-profile:test"],
    OutcomeStrategyLifecycleState.GovernanceApproved,
    "sha256:outcome-strategy",
    "certificate-placeholder",
    signature);

if (!OutcomeDslValidator.Validate(outcomeStrategy).IsValid)
{
    throw new InvalidOperationException("Outcome DSL validator must accept a valid primitive graph.");
}

var invalidDuplicateNumbers = outcomeStrategy with
{
    PrimitiveGraph =
    [
        outcomeStrategy.PrimitiveGraph.First() with
        {
            Numbers = [1, 1, 2]
        }
    ]
};

if (OutcomeDslValidator.Validate(invalidDuplicateNumbers).IsValid)
{
    throw new InvalidOperationException("Outcome DSL validator must reject duplicate numbers for unique number sets.");
}

var invalidWeight = outcomeStrategy with
{
    PrimitiveGraph =
    [
        outcomeStrategy.PrimitiveGraph.ElementAt(1) with
        {
            WeightedOptions = [new WeightedOutcomeOption("RED", 0m)]
        }
    ]
};

if (OutcomeDslValidator.Validate(invalidWeight).IsValid)
{
    throw new InvalidOperationException("Outcome DSL validator must reject non-positive weights.");
}

var cyclicStrategy = outcomeStrategy with
{
    PrimitiveGraph =
    [
        new OutcomeDslPrimitive("a", OutcomePrimitiveType.CompositeOutcomeGraph, ["b"], null, null, null, [], [], [], new Dictionary<string, object?>()),
        new OutcomeDslPrimitive("b", OutcomePrimitiveType.CompositeOutcomeGraph, ["a"], null, null, null, [], [], [], new Dictionary<string, object?>())
    ]
};

if (OutcomeDslValidator.Validate(cyclicStrategy).IsValid)
{
    throw new InvalidOperationException("Outcome DSL validator must reject cyclic composite graphs.");
}

var forbiddenMathStrategy = outcomeStrategy with
{
    Constraints = new Dictionary<string, object?> { ["rtp"] = "forbidden" }
};

if (OutcomeDslValidator.Validate(forbiddenMathStrategy).IsValid)
{
    throw new InvalidOperationException("Outcome DSL validator must reject math/RTP/paytable/payout fields.");
}

var mathModel = new MathModelDefinitionV1(
    Guid.NewGuid(),
    "math-model:pick3",
    "1.0.0",
    ["Lottery"],
    ["straight-v1"],
    0.92m,
    -0.08m,
    "Medium",
    0.18m,
    new Dictionary<string, object?> { ["maxExposureMultiple"] = 100 },
    new Dictionary<string, object?> { ["contributionBasisPoints"] = 50 },
    new Dictionary<string, object?> { ["mode"] = "bankers" },
    new Dictionary<string, object?> { ["currency"] = "USD", ["minorUnit"] = 2 },
    null,
    null,
    MathGovernanceLifecycleState.GovernanceApproved,
    "sha256:math-model",
    MathCertificationBindingState.None,
    signature);

if (!MathGovernanceValidator.Validate(mathModel).IsValid)
{
    throw new InvalidOperationException("Math governance validator must accept a valid math model.");
}

var invalidRtpMathModel = mathModel with { ExpectedRtp = 1.2m };
if (MathGovernanceValidator.Validate(invalidRtpMathModel).IsValid)
{
    throw new InvalidOperationException("Math governance validator must reject invalid RTP values.");
}

var jurisdictionOverlayMathModel = mathModel with
{
    JurisdictionProfileReferences = ["regulator-profile:test"],
    RtpPolicyConstraints = new Dictionary<string, object?> { ["regulator-profile:test"] = new Dictionary<string, object?> { ["minimumRtp"] = 0.8m } },
    CertificationBindingState = MathCertificationBindingState.InternalVerified
};

if (!MathGovernanceValidator.Validate(jurisdictionOverlayMathModel).IsValid)
{
    throw new InvalidOperationException("Math governance validator must accept optional jurisdiction and certification overlays.");
}

var forbiddenEntropyMathModel = mathModel with
{
    PrizeLiabilityProfile = new Dictionary<string, object?> { ["entropy"] = "forbidden" }
};

if (MathGovernanceValidator.Validate(forbiddenEntropyMathModel).IsValid)
{
    throw new InvalidOperationException("Math governance validator must reject entropy/randomness controls.");
}

var paytable = new PaytableDefinitionV1(
    Guid.NewGuid(),
    "paytable:pick3",
    "1.0.0",
    mathModel.MathModelId,
    mathModel.Version,
    [
        new PrizeMatrixRow(
            "straight-win",
            "straight-v1",
            "STRAIGHT_WIN",
            500m,
            0m,
            5000m,
            new Dictionary<string, object?> { ["matchCount"] = 3 })
    ],
    [
        new PrizeMatrixRow(
            "bonus-side-bet",
            "bonus-v1",
            "BONUS",
            0m,
            25m,
            250m,
            new Dictionary<string, object?> { ["bonusCode"] = "B1" })
    ],
    new Dictionary<string, object?> { ["maxPayout"] = 5000m },
    null,
    MathGovernanceLifecycleState.GovernanceApproved,
    "sha256:paytable",
    MathCertificationBindingState.None,
    signature);

if (!MathGovernanceValidator.Validate(paytable).IsValid)
{
    throw new InvalidOperationException("Math governance validator must accept a valid paytable.");
}

var jurisdictionOverlayPaytable = paytable with
{
    JurisdictionProfileReferences = ["regulator-profile:test"],
    CertificationBindingState = MathCertificationBindingState.LabSubmitted
};

if (!MathGovernanceValidator.Validate(jurisdictionOverlayPaytable).IsValid)
{
    throw new InvalidOperationException("Math governance validator must accept optional jurisdiction and certification overlays for paytables.");
}

var invalidPaytable = paytable with
{
    PrizeMatrixRows =
    [
        paytable.PrizeMatrixRows.Single() with
        {
            Multiplier = 0m,
            PayoutValue = 0m
        }
    ]
};

if (MathGovernanceValidator.Validate(invalidPaytable).IsValid)
{
    throw new InvalidOperationException("Math governance validator must reject zero-value prize rows.");
}

var forbiddenOutcomePaytable = paytable with
{
    PrizeMatrixRows =
    [
        paytable.PrizeMatrixRows.Single() with
        {
            Conditions = new Dictionary<string, object?> { ["outcome"] = "forbidden" }
        }
    ]
};

if (MathGovernanceValidator.Validate(forbiddenOutcomePaytable).IsValid)
{
    throw new InvalidOperationException("Math governance validator must reject outcome controls in paytables.");
}

var productionRngProvider = new RngProviderDefinitionV1(
    Guid.NewGuid(),
    "rng-provider:os-csprng",
    "1.0.0",
    RngProviderType.OsCsprng,
    ProductionEligible: true,
    RngProviderCertificationState.InternalVerified,
    ["NIST-SP800-90B-health-tests", "OS-CSPRNG-v1"],
    new Dictionary<string, object?> { ["source"] = "kernel-csprng", ["platform"] = "linux" },
    ["startup-health-test", "continuous-randomness-test"],
    RngProviderFailureMode.FailClosed,
    "sha256:rng-provider",
    signature);

if (!RngProviderGovernanceValidator.Validate(productionRngProvider).IsValid)
{
    throw new InvalidOperationException("RNG provider validator must accept a valid production-eligible provider contract.");
}

var deterministicProductionProvider = productionRngProvider with
{
    ProviderType = RngProviderType.TestDeterministic,
    ProductionEligible = true
};

if (RngProviderGovernanceValidator.Validate(deterministicProductionProvider).IsValid)
{
    throw new InvalidOperationException("RNG provider validator must reject production-eligible deterministic test providers.");
}

var simulationProductionProvider = productionRngProvider with
{
    ProviderType = RngProviderType.Simulation,
    ProductionEligible = true
};

if (RngProviderGovernanceValidator.Validate(simulationProductionProvider).IsValid)
{
    throw new InvalidOperationException("RNG provider validator must reject production-eligible simulation providers.");
}

var missingHealthProvider = productionRngProvider with
{
    HealthTestCapabilities = []
};

if (RngProviderGovernanceValidator.Validate(missingHealthProvider).IsValid)
{
    throw new InvalidOperationException("RNG provider validator must reject production providers without health-test capabilities.");
}

var nonFailClosedProvider = productionRngProvider with
{
    FailureMode = RngProviderFailureMode.Disabled
};

if (RngProviderGovernanceValidator.Validate(nonFailClosedProvider).IsValid)
{
    throw new InvalidOperationException("RNG provider validator must reject production providers that do not fail closed.");
}

var rngEvidence = new RngProviderEvidence(
    Guid.NewGuid(),
    productionRngProvider.ProviderId,
    productionRngProvider.ProviderVersion,
    "entropy-source:kernel-csprng",
    RngHealthTestResult.Passed,
    RngHealthTestResult.NotApplicable,
    RngHealthTestResult.Passed,
    DateTimeOffset.UtcNow,
    "sha256:rng-evidence",
    signature);

if (!RngProviderGovernanceValidator.Validate(rngEvidence).IsValid)
{
    throw new InvalidOperationException("RNG evidence validator must accept passing health evidence.");
}

var missingEvidence = rngEvidence with
{
    HealthTestResult = RngHealthTestResult.Missing
};

if (RngProviderGovernanceValidator.Validate(missingEvidence).IsValid)
{
    throw new InvalidOperationException("RNG evidence validator must reject missing health evidence.");
}

var outcomeProvider = new OutcomeProviderDefinitionV1(
    Guid.NewGuid(),
    "outcome-provider:certified-csprng",
    "1.0.0",
    OutcomeProviderType.CertifiedCsprng,
    OutcomeProviderLifecycleState.Active,
    ProductionEligible: true,
    [OutcomePrimitiveType.UniqueNumberSet, OutcomePrimitiveType.WeightedSelection],
    new Dictionary<string, object?> { ["healthEvidence"] = true },
    ["startup-health", "continuous-health"],
    OutcomeProviderIdempotencyModel.PerDraw,
    [OutcomeProviderCustodyState.Generated, OutcomeProviderCustodyState.Sealed, OutcomeProviderCustodyState.Certified],
    new Dictionary<string, object?> { ["certificateSignatureRequired"] = true },
    ReplayabilitySupport: true,
    OutcomeProviderFailureMode.FailClosed,
    new OutcomeProviderCapabilityMarkers(
        GeneratesOutcomes: true,
        IngestsExternalOutcomes: false,
        SupportsPlayerVerificationReceipt: false,
        SupportsDeterministicReplay: true,
        SupportsProviderHealthEvidence: true,
        SupportsDisputeHandling: true,
        SupportsExternalSourceEvidence: false,
        SupportsPhysicalDrawEvidence: false),
    "sha256:outcome-provider",
    CertificationBinding: null);

if (!OutcomeProviderValidator.Validate(outcomeProvider).IsValid)
{
    throw new InvalidOperationException("Outcome Provider validator must accept a valid Certified CSPRNG provider.");
}

var simulationOutcomeProvider = outcomeProvider with
{
    ProviderType = OutcomeProviderType.SimulationTest,
    ProductionEligible = true
};

if (OutcomeProviderValidator.Validate(simulationOutcomeProvider).IsValid)
{
    throw new InvalidOperationException("Outcome Provider validator must reject production-eligible simulation/test providers.");
}

var invalidOutcomeProviderCapabilities = outcomeProvider with
{
    CapabilityMarkers = outcomeProvider.CapabilityMarkers with
    {
        GeneratesOutcomes = true,
        IngestsExternalOutcomes = true
    }
};

if (OutcomeProviderValidator.Validate(invalidOutcomeProviderCapabilities).IsValid)
{
    throw new InvalidOperationException("Outcome Provider validator must reject generated and ingested outcome capability overlap.");
}

var forbiddenOutcomeProviderFields = outcomeProvider with
{
    EvidenceRequirements = new Dictionary<string, object?> { ["rtpControl"] = "forbidden" }
};

if (OutcomeProviderValidator.Validate(forbiddenOutcomeProviderFields).IsValid)
{
    throw new InvalidOperationException("Outcome Provider validator must reject math or financial fields.");
}

var providerBinding = new OutcomeProviderManifestBinding(
    outcomeProvider.ProviderId,
    outcomeProvider.ProviderVersion,
    [OutcomePrimitiveType.UniqueNumberSet],
    new Dictionary<string, object?> { ["healthEvidence"] = true },
    PlayerVerificationReceiptRequired: false,
    new Dictionary<string, object?> { ["silentFallbackAllowed"] = false },
    CertificationRequired: false);

if (!OutcomeProviderValidator.ValidateManifestBinding(providerBinding, outcomeProvider, productionMode: true).IsValid)
{
    throw new InvalidOperationException("Outcome Provider validator must accept a compatible manifest binding.");
}

var incompatibleBinding = providerBinding with
{
    ProviderCapabilityRequirements = [OutcomePrimitiveType.ShufflePermutation]
};

if (OutcomeProviderValidator.ValidateManifestBinding(incompatibleBinding, outcomeProvider, productionMode: true).IsValid)
{
    throw new InvalidOperationException("Outcome Provider validator must reject unsupported manifest primitive requirements.");
}

var entropyProvider = new EntropyProviderDefinitionV1(
    Guid.NewGuid(),
    "entropy-provider:os-csprng",
    "1.0.0",
    EntropyProviderType.OsCsprng,
    "linux-kernel-getrandom",
    new Dictionary<string, object?> { ["sourceReference"] = "os-csprng", ["rawMaterialPersisted"] = false },
    MinimumEntropyBits: 256,
    ["startup-health-test", "continuous-health-test"],
    ProductionEligible: true,
    CertifiedCsprngFailureMode.FailClosed,
    "sha256:entropy-provider");

if (!CertifiedCsprngProviderValidator.Validate(entropyProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must accept a valid OS entropy provider.");
}

var simulationEntropyProvider = entropyProvider with
{
    ProviderType = EntropyProviderType.TestSimulation,
    ProductionEligible = true
};

if (CertifiedCsprngProviderValidator.Validate(simulationEntropyProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must reject production-eligible simulation entropy providers.");
}

var rawEntropyProvider = entropyProvider with
{
    EntropySourceMetadata = new Dictionary<string, object?> { ["rawEntropy"] = "forbidden" }
};

if (CertifiedCsprngProviderValidator.Validate(rawEntropyProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must reject raw entropy persistence.");
}

var certifiedCsprngProvider = new CertifiedCsprngProviderDefinitionV1(
    Guid.NewGuid(),
    "csprng-provider:hmac-drbg",
    "1.0.0",
    outcomeProvider.ProviderId,
    outcomeProvider.ProviderVersion,
    productionRngProvider.ProviderId,
    productionRngProvider.ProviderVersion,
    EntropyProviderType.OsCsprng,
    CertifiedDrbgType.HmacDrbg,
    CertifiedCsprngHashAlgorithm.Sha256,
    SecurityStrengthBits: 256,
    new Dictionary<string, object?> { ["intervalRequests"] = 1000000 },
    new Dictionary<string, object?> { ["perDrawSession"] = true },
    new Dictionary<string, object?> { ["zeroizeOnCompletion"] = true },
    StartupSelfTestSupported: true,
    KnownAnswerTestSupported: true,
    ContinuousHealthTestSupported: true,
    ProductionEligible: true,
    CertifiedCsprngLifecycleState.Active,
    CertifiedCsprngFailureMode.FailClosed,
    [
        CertifiedSamplingCapability.RejectionSampling,
        CertifiedSamplingCapability.FisherYatesShuffle,
        CertifiedSamplingCapability.UniqueNumberSelection,
        CertifiedSamplingCapability.IntegerRationalWeightedSelection
    ],
    "sha256:csprng-provider",
    CertificationBinding: null);

if (!CertifiedCsprngProviderValidator.Validate(certifiedCsprngProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must accept a complete production-eligible HMAC-DRBG contract.");
}

var missingKatProvider = certifiedCsprngProvider with
{
    KnownAnswerTestSupported = false
};

if (CertifiedCsprngProviderValidator.Validate(missingKatProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must reject missing KAT support.");
}

var unsupportedSamplingProvider = certifiedCsprngProvider with
{
    SamplingCapabilities = [CertifiedSamplingCapability.FisherYatesShuffle]
};

if (CertifiedCsprngProviderValidator.Validate(unsupportedSamplingProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must reject missing unbiased sampling capabilities.");
}

var rawSeedPolicyProvider = certifiedCsprngProvider with
{
    ReseedPolicy = new Dictionary<string, object?> { ["seedMaterial"] = "forbidden" }
};

if (CertifiedCsprngProviderValidator.Validate(rawSeedPolicyProvider).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must reject persisted raw seed material.");
}

var drbgEvidence = new DrbgSessionEvidence(
    Guid.NewGuid(),
    "draw:qa",
    certifiedCsprngProvider.ProviderId,
    certifiedCsprngProvider.ProviderVersion,
    entropyProvider.ProviderId,
    entropyProvider.ProviderVersion,
    ReseedCounter: 1,
    "sha256:personalization",
    "sha256:nonce",
    "sha256:seed-commitment",
    DrbgEvidenceTestResult.Passed,
    DrbgEvidenceTestResult.Passed,
    DrbgEvidenceTestResult.Passed,
    DateTimeOffset.UtcNow,
    DateTimeOffset.UtcNow.AddSeconds(1),
    "sha256:drbg-evidence",
    signature);

if (!CertifiedCsprngProviderValidator.Validate(drbgEvidence).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must accept DRBG session evidence with hashes and health results.");
}

var failedDrbgEvidence = drbgEvidence with
{
    ContinuousTestResult = DrbgEvidenceTestResult.Failed
};

if (CertifiedCsprngProviderValidator.Validate(failedDrbgEvidence).IsValid)
{
    throw new InvalidOperationException("Certified CSPRNG validator must reject failed DRBG health evidence.");
}

var clientSeedPolicy = new ProvablyFairClientSeedPolicy(
    Required: true,
    MaximumLength: 128,
    ProvablyFairEncoding.Utf8,
    ["non-empty", "max-length"],
    ["trim", "unicode-nfc"]);

var provablyFairProvider = new ProvablyFairProviderDefinitionV1(
    Guid.NewGuid(),
    "provably-fair-provider:hmac",
    "1.0.0",
    outcomeProvider.ProviderId,
    outcomeProvider.ProviderVersion,
    ProvablyFairCommitAlgorithm.HashCommitment,
    ProvablyFairVerificationAlgorithm.HmacSha256,
    ProvablyFairHashAlgorithm.Sha256,
    new Dictionary<string, object?> { ["generation"] = "external-governed", ["plaintextPersisted"] = false },
    clientSeedPolicy,
    new Dictionary<string, object?> { ["scopeType"] = "Wager", ["monotonicRequired"] = true },
    new Dictionary<string, object?> { ["revealDelaySeconds"] = 60, ["revealWindowSeconds"] = 86400 },
    TimeSpan.FromDays(1),
    ReceiptSupport: true,
    ProductionEligible: true,
    ProvablyFairLifecycleState.Active,
    "sha256:provably-fair-provider",
    CertificationBinding: null);

if (!ProvablyFairProviderValidator.Validate(provablyFairProvider).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must accept a valid provider contract.");
}

var receiptDisabledProvider = provablyFairProvider with
{
    ReceiptSupport = false
};

if (ProvablyFairProviderValidator.Validate(receiptDisabledProvider).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must reject providers without receipt support.");
}

var negativeRevealProvider = provablyFairProvider with
{
    RevealPolicy = new Dictionary<string, object?> { ["revealDelaySeconds"] = 0, ["revealWindowSeconds"] = -1 }
};

if (ProvablyFairProviderValidator.Validate(negativeRevealProvider).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must reject negative reveal windows.");
}

var rawSeedProvider = provablyFairProvider with
{
    ServerSeedPolicy = new Dictionary<string, object?> { ["plaintextSeed"] = "forbidden" }
};

if (ProvablyFairProviderValidator.Validate(rawSeedProvider).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must reject plaintext seed governance.");
}

var seedCommitment = new ProvablyFairServerSeedCommitment(
    Guid.NewGuid(),
    provablyFairProvider.ProviderId,
    provablyFairProvider.ProviderVersion,
    DateTimeOffset.UtcNow,
    "sha256:server-commitment",
    ProvablyFairSeedLifecycleState.Committed,
    new Dictionary<string, object?> { ["rotateAfterWagers"] = 10000 },
    DateTimeOffset.UtcNow.AddMinutes(1),
    null,
    "sha256:seed-commitment-record");

if (!ProvablyFairProviderValidator.Validate(seedCommitment).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must accept hash-only seed commitments.");
}

var nonceSequence = new ProvablyFairNonceSequence(
    Guid.NewGuid(),
    provablyFairProvider.ProviderId,
    provablyFairProvider.ProviderVersion,
    "wager:qa",
    ProvablyFairNonceScopeType.Wager,
    Nonce: 1,
    new Dictionary<string, object?> { ["monotonicRequired"] = true },
    MonotonicRequired: true,
    "provider-wager",
    "sha256:nonce-sequence");

if (!ProvablyFairProviderValidator.Validate(nonceSequence).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must accept valid nonce governance.");
}

var invalidNonceSequence = nonceSequence with { Nonce = -1 };
if (ProvablyFairProviderValidator.Validate(invalidNonceSequence).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must reject negative nonces.");
}

var receipt = new ProvablyFairVerificationReceipt(
    Guid.NewGuid(),
    "wager:qa",
    Guid.NewGuid(),
    "sha256:outcome-certificate",
    provablyFairProvider.ProviderId,
    provablyFairProvider.ProviderVersion,
    "sha256:server-commitment",
    "client-seed",
    Nonce: 1,
    RevealedServerSeedPlaceholder: null,
    ProvablyFairVerificationAlgorithm.HmacSha256,
    new Dictionary<string, object?> { ["commitment"] = "hash-only" },
    ProvablyFairVerificationStatus.PendingReveal,
    "sha256:receipt",
    signature,
    new Dictionary<string, object?> { ["exportVersion"] = "v1" });

if (!ProvablyFairProviderValidator.Validate(receipt).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must accept immutable verification receipt contracts.");
}

var seedLeakReceipt = receipt with
{
    RevealedServerSeedPlaceholder = "plaintext-serverSeed-forbidden"
};

if (ProvablyFairProviderValidator.Validate(seedLeakReceipt).IsValid)
{
    throw new InvalidOperationException("Provably Fair validator must reject receipt seed leakage.");
}

Console.WriteLine("GameEngine.Domain.Tests PASS");
