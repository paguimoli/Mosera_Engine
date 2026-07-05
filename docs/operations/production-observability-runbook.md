# Production Observability Runbook

## Scope

Production telemetry flows from app, service, and worker containers to the
production OpenTelemetry Collector. The collector forwards traces, metrics, and
logs to Grafana Cloud over OTLP. Prometheus and Grafana are not self-hosted in
the v1 production topology.

## Required Configuration

- `OTEL_EXPORTER_OTLP_ENDPOINT`: Grafana Cloud OTLP endpoint for the collector.
- `OTEL_EXPORTER_OTLP_HEADERS`: authorization header injected by the production
  secret manager.
- `DEPLOYMENT_ENVIRONMENT=production`.
- `RELEASE_VERSION`: immutable release or git SHA.
- `SERVICE_NAME`: unique workload name per app, service, or worker.

Application containers export to `http://otel-collector:4318`. Only the
collector receives Grafana Cloud credentials.

## Redaction Rules

The shared application logger redacts sensitive metadata keys before writing
structured logs. The collector also removes common secret, token, credential,
cookie, email, and phone attributes before export.

Do not emit raw passwords, tokens, cookies, secret references, customer emails,
phone numbers, or account documents in operational logs.

## Alert Response

### Service Down

Confirm the container state, Caddy routing, and managed dependency readiness.
Roll back to the previous immutable image if the failure follows a release.

### Readiness Failure

Check `/health/ready` for the affected service. Treat database, Redis, RabbitMQ,
or Auth Service readiness failures as production-impacting until proven
otherwise.

### Queue Or DLQ Growth

Pause non-critical releases. Inspect RabbitMQ queue depth, dead-letter routing,
consumer health, and idempotency evidence before replaying messages.

### Settlement Failure

Stop settlement promotion activity. Capture run, draw, ticket, and correlation
IDs. Use settlement recovery/resume tooling before manual correction.

### Auth Failure Spike

Check source IP concentration, user-agent patterns, and rate-limit evidence.
Escalate repeated administrative-account failures as a security incident.

### Cashier Ledger Inconsistency

Freeze cashier completion for affected accounts, capture ledger transaction IDs,
cashier transaction IDs, and outbox event IDs, then follow financial incident
reconciliation procedures.

## Evidence

For every critical alert, retain:

- alert name and severity;
- affected service;
- release version;
- correlation IDs;
- remediation action;
- rollback or forward-fix decision.
