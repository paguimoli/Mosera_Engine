# Shadow Evidence Lifecycle Runbook

## Purpose

This runbook describes how operators classify shadow evidence for promotion visibility without deleting or editing the original shadow records.

## Commands

```bash
npm run ops:shadow-evidence-lifecycle-summary
npm run ops:shadow-evidence-lifecycle-events
npm run ops:shadow-evidence-exclude-classified-qa
```

## QA Evidence Exclusion

Run:

```bash
npm run ops:shadow-evidence-exclude-classified-qa
```

This appends lifecycle events for evidence already classified as intentional QA mismatch or intentional QA failure.

It does not delete evidence. It does not update evidence. It only appends lifecycle records.

## Operator Rules

- Do not delete shadow evidence.
- Do not modify shadow evidence rows.
- Do not use lifecycle exclusion to hide unexplained production-equivalent evidence.
- Use `REVIEW_REQUIRED` or future manual exclusion workflows for non-QA evidence.
- Keep raw readiness visible in promotion reviews.

## Promotion Review

Before promotion review, operators should compare:

- raw readiness
- adjusted readiness
- promotion readiness
- lifecycle event history
- classification summary

Promotion readiness can become ready after QA evidence exclusion, but authority transfer still requires separate operator approval and rollback readiness.

## Audit Review

For each lifecycle event, verify:

- actor user id
- correlation id
- reason code
- previous status
- new status
- timestamp

Lifecycle events are append-only and immutable.
