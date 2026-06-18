# Credit Launch E2E QA Harness

## Purpose

The credit launch E2E harness validates the controlled North American credit lifecycle from hierarchy setup through reconciliation.

It is intentionally append-only for financial records. It creates isolated QA accounts and credit activity using a run-specific prefix, then asserts that the lifecycle remains internally consistent.

## What It Tests

Lifecycle covered:

1. Super Master creation.
2. Master creation.
3. Agent creation.
4. Player creation.
5. Credit wallet and credit limit setup.
6. Credit-backed ticket placement.
7. Reservation creation.
8. Ticket-to-reservation linkage.
9. Pending exposure increase.
10. Settlement application.
11. Exposure release.
12. Credit balance update.
13. Weekly accounting snapshot generation.
14. Commission run generation.
15. Reconciliation run completion.

## Assertions

The harness asserts:

- Reservation exists.
- Reservation amount equals ticket stake.
- Ticket stores `credit_reservation_id`.
- Pending exposure increases after ticket placement.
- Available credit follows `creditLimit + balance - pendingExposure`.
- Settlement application exists.
- Balance impact equals settlement net amount.
- Remaining exposure becomes zero after full settlement.
- Balance updates after settlement.
- Weekly snapshot includes the settlement net result.
- Agent commission run detail exists.
- Reconciliation run completes.

## Required Environment Variables

Required:

- `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `QA_ADMIN_SESSION_TOKEN`

Optional:

- `QA_APP_URL`, defaults to `http://localhost:3000`
- `QA_RUN_ID`, defaults to a timestamp
- `QA_ORGANIZATION_ID`, uses a specific existing organization for ticket intake
- `QA_ORGANIZATION_EXTERNAL_ID`, resolves a specific existing organization for ticket intake
- `QA_PLAYER_ID`, uses a specific existing external player row for ticket intake
- `QA_PLAYER_EXTERNAL_ID`, creates or resolves a specific external player id
- `QA_GAME_ID`, defaults to a logical QA value
- `QA_DRAW_ID`, uses a specific existing normalized drawing
- `QA_DRAWING_EXTERNAL_ID`, resolves a specific existing normalized drawing

`QA_ADMIN_SESSION_TOKEN` must be an active platform session with permission to run reconciliation. The harness sends it as a bearer token to `POST /api/reconciliation/run`.

## How To Run

Start the platform:

```bash
docker compose up -d --build
```

Run the harness from the repo:

```bash
npm run qa:credit-launch
```

If local Node is unavailable, run it through Docker with the repo mounted:

```bash
docker run --rm \
  --env-file .env.local \
  -e QA_APP_URL=http://host.docker.internal:3000 \
  -e QA_ADMIN_SESSION_TOKEN=<active-session-token> \
  -v "$PWD":/app \
  -w /app \
  node:20-bookworm-slim \
  npm run qa:credit-launch
```

## Expected Output

Success prints JSON logs ending with:

```json
{"level":"info","message":"Credit launch E2E QA harness passed."}
```

Failure exits non-zero and prints:

```json
{"level":"error","message":"Credit launch E2E QA harness failed."}
```

The failure output includes the assertion reason, relevant entity IDs where available, and metadata from Supabase or the API response.

## Repeatability

Each run uses a deterministic QA prefix and unique run identifier. Financial records are not deleted. Re-running with the same `QA_RUN_ID` is intended to exercise idempotent paths where supported, but most operational use should allow the default timestamped run id.

## Known Limitations

- The harness requires the credit, settlement, weekly accounting, commission, and reconciliation migrations to be applied.
- It requires the `tickets` table and `place_ticket_with_wallet_debit` RPC to exist.
- It requires an existing `organizations` row for ticket placement. Set `QA_ORGANIZATION_ID` or `QA_ORGANIZATION_EXTERNAL_ID` when more than one organization exists.
- It requires a `players` table compatible with ticket intake. The harness creates a QA external player when the table exposes `organization_id` and `external_player_id`.
- Game/draw persistence is not standardized in the current migrations. The harness identifies an existing `normalized_drawings` row or uses `QA_DRAW_ID` / `QA_DRAWING_EXTERNAL_ID`.
- Reconciliation is executed through the protected API, so an active admin session token is required.
- The harness does not delete financial records.
