# ADR-012 - Certification Packages

## Status

Accepted

## Decision

Certification packages must be reproducible structured objects containing rules, provider metadata, module metadata, draw generator metadata, version metadata, configuration, build, environment, hardware, validation, checksum, evidence, and approval-placeholder metadata.

## Rationale

Regulatory and partner review requires stable packages that can be regenerated and compared. Structured packages are the foundation for later archive and PDF generation.

## Consequences

- SHA256 checksums are supported now.
- Future hash algorithms are represented by the evidence model.
- Archive generation, PDF export, and external submission automation are deferred.
