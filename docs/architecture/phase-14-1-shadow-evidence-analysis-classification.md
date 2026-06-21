# Phase 14.1 - Shadow Evidence Analysis & Classification

## Purpose

Phase 14.1 adds a read-only evidence analysis layer for Settlement, Ledger, and Credit shadow mode. It explains whether current readiness blockers come from intentional QA injections, expected test variation, unexplained failures, data quality issues, or likely parity defects.

This phase does not transfer authority, change routing, change thresholds, or modify financial calculations.

## Evidence Classes

- `QA_INTENTIONAL_MISMATCH`: Evidence produced by QA harnesses to prove mismatch persistence and reporting.
- `QA_INTENTIONAL_FAILURE`: Evidence produced by QA harnesses to prove failure persistence and reporting.
- `EXPECTED_TEST_VARIATION`: Reserved for known non-production variations that are not failures.
- `UNEXPLAINED_MISMATCH`: A mismatch without a current classification.
- `UNEXPLAINED_FAILURE`: A failure without a current classification.
- `PARITY_DEFECT`: A non-QA critical mismatch that may indicate service or monolith parity drift.
- `DATA_QUALITY_ISSUE`: Evidence with missing, invalid, null, or not-found context.
- `INSUFFICIENT_CONTEXT`: Evidence missing the joined shadow run or required classification context.

## Classification Signals

The classifier treats evidence as intentional QA when it contains markers such as:

- Correlation IDs beginning with `qa-`
- Metadata sources containing `qa:`
- Entity IDs containing `-mismatch` or `-failure`
- Explicit intentional markers

Critical non-QA mismatches remain parity concerns. The analysis layer is intentionally conservative and does not dismiss unexplained production-like evidence.

## Raw vs Adjusted Readiness

`RAW_READINESS` includes all shadow evidence and mirrors the operational readiness pressure currently visible in shadow metrics.

`ADJUSTED_READINESS` excludes:

- `QA_INTENTIONAL_MISMATCH`
- `QA_INTENTIONAL_FAILURE`

Adjusted readiness is reported in parallel only. It does not change the existing readiness service, authority controls, rollback controls, or readiness thresholds.

## API Surface

Protected by existing Super Admin / Operations Admin permission:

- `GET /api/shadow-analysis/summary`
- `GET /api/shadow-analysis/mismatches`
- `GET /api/shadow-analysis/failures`

Each endpoint supports:

- `?window=24h`
- `?window=7d`
- `?window=30d`
- `?window=all`

## Operational Scripts

- `npm run ops:shadow-analysis-summary`
- `npm run ops:shadow-analysis-mismatches`
- `npm run ops:shadow-analysis-failures`

Each script auto-loads `.qa/session.env` for local operations.

## Reporting Model

The summary report includes:

- Platform raw readiness
- Platform adjusted readiness
- Domain breakdown for Settlement, Ledger, and Credit
- Mismatch counts by classification
- Failure counts by classification
- Affected domains
- Affected routes
- Affected authority candidates
- Advisory recommendation

## Extraction Decision Guidance

Authority transfer must not proceed from adjusted readiness alone.

Adjusted readiness can support the conclusion that known QA injections are responsible for blockers, but transfer planning still requires:

- No unexplained critical mismatches
- No unexplained failures above threshold
- Sufficient shadow volume
- Rollback readiness
- Operator review

## Validation

Validation command:

```bash
npm run qa:shadow-analysis
```

This verifies:

- APIs are protected
- Intentional QA mismatches are classified
- Intentional QA failures are classified
- Adjusted readiness is calculated
- Domain reports are produced

## Limitations

- Classification is heuristic and advisory.
- No automatic authority decisions are made.
- No evidence is repaired or suppressed.
- Expected test variation classification is reserved for future explicit allowlists.
