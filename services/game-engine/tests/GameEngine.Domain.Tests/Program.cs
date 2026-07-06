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

Console.WriteLine("GameEngine.Domain.Tests PASS");
