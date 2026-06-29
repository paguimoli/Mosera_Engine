# Deferred Production Register

This register tracks items intentionally deferred until a later production-readiness phase.

| Item | Category | Reason Deferred | Risk If Forgotten | Latest Safe Phase | Recommendation |
| --- | --- | --- | --- | --- | --- |
| External RNG provider sourcing | Integration | Provider selection is not approved yet. | Launch game may lack certified result source. | Before draw/RNG launch | Select provider and define contract tests. |
| PRNG certification strategy | Compliance | Jurisdiction requirements are not finalized. | Internal RNG may be unsuitable for production use. | Before internal RNG production use | Define certification evidence and approval workflow. |
| Strict regulatory RNG certification if jurisdiction requires | Compliance | Depends on market and regulator. | Launch may fail compliance review. | Before regulated launch | Confirm jurisdiction requirements. |
| Results comparison engine | Game Integrity | Production result providers are not selected. | Manual/provider result discrepancies may lack review workflow. | Before multi-provider results | Design comparison and dispute handling. |
| Production Game Engine deployment hardening | Infrastructure | Phase 22.6A creates only a skeleton. | Service may lack production security and observability. | Before Game Engine production traffic | Add auth, metrics, alerting, scaling, and runbooks. |
| Official result correction workflow | Game Integrity | Phase 22.6D enforces one official result and defers correction/replacement. | Incorrect certified result may lack governed remediation. | Before production draw certification | Define append-only correction and supersession workflow. |
| External feed provider implementation | Integration | Official feed provider is a placeholder. | State/official draw products cannot ingest certified results automatically. | Before official-feed games launch | Implement provider contract, auth, polling/webhook validation, and replay safety. |
| Production PRNG implementation | Game Integrity | Internal Production PRNG is a placeholder and not production-ready. | Internal proprietary games may lack approved result generation. | Before internal RNG games launch | Implement non-reproducible CSPRNG provider with certification evidence. |
| PRNG approval evidence | Compliance | Approval metadata is placeholder-only. | Internal RNG may be used without documented approval. | Before internal RNG production use | Store approval references, certification artifacts, and operator acceptance. |
| Draw result comparison engine | Game Integrity | Multi-source comparison is deferred. | Conflicting draw results may not be detected before certification. | Before multi-provider result intake | Build comparison, discrepancy, and operator review workflows. |
