# Deferred Production Register

This register tracks items intentionally deferred until a later production-readiness phase.

| Item | Category | Reason Deferred | Risk If Forgotten | Latest Safe Phase | Recommendation |
| --- | --- | --- | --- | --- | --- |
| External RNG provider sourcing | Integration | Provider selection is not approved yet. | Launch game may lack certified result source. | Before draw/RNG launch | Select provider and define contract tests. |
| PRNG certification strategy | Compliance | Jurisdiction requirements are not finalized. | Internal RNG may be unsuitable for production use. | Before internal RNG production use | Define certification evidence and approval workflow. |
| Strict regulatory RNG certification if jurisdiction requires | Compliance | Depends on market and regulator. | Launch may fail compliance review. | Before regulated launch | Confirm jurisdiction requirements. |
| Results comparison engine | Game Integrity | Production result providers are not selected. | Manual/provider result discrepancies may lack review workflow. | Before multi-provider results | Design comparison and dispute handling. |
| Production Game Engine deployment hardening | Infrastructure | Phase 22.6A creates only a skeleton. | Service may lack production security and observability. | Before Game Engine production traffic | Add auth, metrics, alerting, scaling, and runbooks. |
