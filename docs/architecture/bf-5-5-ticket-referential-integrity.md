# BF-5.5 Ticket Referential Integrity

Canonical tickets retain exact immutable references to their account scope, wallet,
reservation, game definition version, Game Manifest version, paytable version,
availability decision, Draw Instance, and Draw Execution Manifest. Database foreign
keys and insert guards reject mismatched duplicated identifiers. Ticket items are
bound to their parent and to a wager schema/version declared by the exact manifest.

Completion evidence binds its request, ticket, item, Settlement record, Ledger
execution attempt, Wallet execution attempt, and terminal lifecycle event. All
permanent evidence remains append-only and uses restrictive deletion.

Rows accepted before an exact Draw Execution Manifest existed are retained as
`LEGACY_READ_ONLY`. The migration does not invent historical evidence, and those
rows cannot advance through canonical lifecycle commands.

The composite ticket foreign keys are installed `NOT VALID`: PostgreSQL enforces
them for every post-migration insert or update, while pre-existing read-only rows do
not have to fabricate modern version evidence. Canonical rows are separately checked
by the migration preflight and readiness function.

## Cross-Service Evidence

Production services may use separate databases, so PostgreSQL cannot enforce foreign
keys from Ticket Authority to Settlement, Ledger, Credit Wallet, Outcome, or
Compensation databases. Those boundaries use immutable authority identifiers,
canonical hashes, idempotency keys, and service-side authority validation. The local
integrated schema additionally enforces matching Settlement, Ledger, Wallet, and
Completion rows because the disposable runtime shares one PostgreSQL database.

Outcome-to-Settlement correlation remains an immutable cross-service evidence
contract. Ticket Authority does not resolve active outcome, manifest, paytable, or
availability pointers during settlement, replay, cancellation, or reporting.
