# BF-6.3 Operational Change Authority

Mosera has one production change path: immutable Operational Governance command, authorization and approval policy, Operational Security validation, canonical change execution, mandatory verification, and immutable audit evidence.

The change policy catalog supports configuration publication, product publication, provider activation and deactivation, draw schedule publication, platform maintenance, recovery execution, and production release. Policies bind each change type to permitted governance command types and require authority acceptance, readiness, audit, bounded retry, and post-execution verification. The catalog is versioned and append-only.

Authority promotions and website maintenance changes use the TypeScript orchestration adapter. Production Game Engine provider activation and recovery use the .NET adapter against the same PostgreSQL authority tables and functions. Neither adapter owns a second workflow or policy system.

Maintenance begins and ends through immutable website supersession plus a linked `maintenance_events` record. There is no mutable maintenance toggle and no direct production bypass.

Failed execution or verification appends failure evidence. Recoverable retries create a new numbered attempt; verified changes cannot execute again. BF-6.3 does not deploy software, design workflows, send notifications, or provide an operator UI.
