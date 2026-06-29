# Phase 22.6D - Draw Authority Framework & Approval Gates

## Purpose

Phase 22.6D adds the Draw Authority framework inside the .NET Game Engine. Draw Authorities are shared, independently configured result sources that can be assigned prospectively to game bindings after approval gates pass.

This phase does not implement production RNG, external provider integrations, production draw generation, settlement integration, or production game activation.

## Authority Model

Draw Authorities track:

- Authority identity and type
- Provider type
- Lifecycle status
- Approval status
- Active version metadata
- Capabilities
- Provider health
- Production readiness

Current placeholder authorities:

- Manual Certified Entry
- Official Feed Placeholder
- Internal Production PRNG Placeholder
- Internal Test PRNG Placeholder
- External RNG Placeholder

## Approval Gates

Production assignment requires:

- `Production` status, or `ExternallyCertified` when configured as sufficient
- version metadata
- valid provider health
- matching capabilities
- non-retired authority
- approval metadata

Internal Test PRNG authorities are never production-assignable. Internal Production PRNG authorities are not production-assignable until approval evidence exists. Manual Certified Entry requires operator certification metadata before an official result can be certified.

## Official Result Rules

- Multiple result submissions may exist for one draw.
- Result submissions are immutable.
- Exactly one Official Certified Result may exist per draw.
- Manual certified results require operator certification metadata.
- Existing Official Certified Results cannot be overwritten.
- Correction/replacement workflows are deferred.

## Diagnostics

Added endpoints:

- `GET /api/game-engine/draw-authorities`
- `GET /api/game-engine/draw-authorities/{id}`
- `GET /api/game-engine/draw-authorities/{id}/versions`
- `GET /api/game-engine/draw-authorities/{id}/health`
- `GET /api/game-engine/draw-authority-registry-status`
- `GET /api/game-engine/draw-result-submissions`
- `GET /api/game-engine/official-certified-results`

Placeholder admin endpoints remain diagnostic-only:

- `POST /api/game-engine/draw-authorities/{id}/approve`
- `POST /api/game-engine/manual-results`

## Current Limitations

All providers are placeholders. No real RNG, feed ingestion, result comparison, correction workflow, persistence, settlement trigger, or production activation is implemented.
