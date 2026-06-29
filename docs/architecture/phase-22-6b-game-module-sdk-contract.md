# Phase 22.6B - Game Module SDK Contract

## Scope

Phase 22.6B defines the Game Module SDK contract, contract tests, deterministic fixtures, packaging rules, and lifecycle gate logic for the .NET Game Engine.

This phase does not implement production RNG, production Hot Spot logic, production RabbitMQ messaging, Settlement integration, or financial behavior.

## SDK Contract

Every Game Module must expose:

- Manifest and module metadata
- Module version metadata
- Supported game types
- Supported wager types
- Supported draw authority types
- Configuration validation
- Ticket validation
- Draw generation capability declaration
- Draw generation implementation where supported
- Ticket evaluation
- Batch evaluation
- Health check
- Deterministic fixtures

SDK interfaces:

- `IGameModule`
- `IGameModuleManifestProvider`
- `IGameTicketValidator`
- `IGameDrawGenerator`
- `IGameEvaluator`
- `IGameConfigurationValidator`
- `IGameModuleHealthCheck`
- `IGameModuleFixtureProvider`

## Manifest

`GameModuleManifest` includes:

- `moduleId`
- `moduleName`
- `moduleVersion`
- `gameTypes`
- `supportedWagerTypes`
- `supportedDrawAuthorityTypes`
- `supportsInternalDrawGeneration`
- `supportsExternalResultEvaluation`
- `supportsManualResultEvaluation`
- `configurationSchemaVersion`
- `evaluatorVersion`
- `drawGeneratorVersion`
- `minimumGameEngineVersion`
- `lifecycleStatus`
- `checksum`
- `createdAt`
- `buildMetadata`

## Validation Model

The SDK uses structured validation objects:

- `ValidationResult`
- `ValidationError`
- `ValidationWarning`
- `ValidationSeverity`
- `ValidationCode`

Validation covers ticket input, module configuration, draw result input, and evaluation input. Modules must not return unstructured string-only errors.

## Evaluation Model

The SDK defines Settlement-ready evaluation outputs without integrating Settlement yet:

- `GameEvaluationInput`
- `GameEvaluationOutput`
- `GameEvaluationOutcome`
- `GameEvaluationReason`
- `GameEvaluationAmount`
- `GameEvaluationMetadata`

Evaluation output includes outcome, reason, amount facts, version metadata, validation result, and future settlement facts.

## Deterministic Fixtures

Each module must provide deterministic fixtures through `IGameModuleFixtureProvider`.

Fixtures include:

- Input ticket
- Draw result
- Expected outcome
- Expected payout
- Expected validation result
- Expected reason code

`TestModule` includes a deterministic winning fixture. `HotSpot` includes a non-production placeholder fixture and does not claim production support.

## Contract Tests

`GameModuleContractTestBase` verifies:

- Manifest is present
- Module version is present
- Supported game types are declared
- Supported wager types are declared
- Configuration validation is implemented
- Ticket validation is implemented
- Health check is implemented
- Deterministic fixtures are discoverable
- Fixture evaluations match expected outputs
- Invalid tickets return structured validation errors
- Unsupported draw generation is safely rejected
- Lifecycle status is exposed
- Version metadata is exposed

Both `TestModule` and `HotSpot` pass the contract test suite.

## Lifecycle Gate

`GameModuleLifecycleGate` evaluates whether a module may be considered production-ready.

A module is production-ready only when:

- Lifecycle status is `Approved` or `ProductionActive`
- Manifest is valid
- Required interfaces are implemented
- Contract behavior passes
- Deterministic fixtures pass
- Health check passes
- Version metadata is present

Phase 22.6B defines the gate only. It does not implement an admin approval workflow.

## Packaging Rules

A Game Module package must include:

- Manifest
- Implementation
- Contract test fixtures
- Configuration schema
- Version metadata
- Release notes placeholder
- Approval evidence placeholder

No external package publishing is required in this phase.

## API Update

`GET /api/game-engine/modules` returns structured module status data:

- Manifest
- Health status
- Production readiness
- Lifecycle gate blockers
- Lifecycle gate warnings
- Checked timestamp

## Non-Goals

- Production RNG
- Production Hot Spot logic
- Production RabbitMQ messaging
- Settlement integration
- Financial behavior changes
- Authority routing changes

## Phase 22.6C Recommendation

Phase 22.6C should define the Game Module registry and module loading model, including module discovery, configured game definition binding, module version selection, and non-production administrative diagnostics.
