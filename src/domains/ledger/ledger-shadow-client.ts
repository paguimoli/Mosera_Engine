import { logger } from "@/src/lib/observability/logger";
import type { CreateLedgerEntryInput, LedgerEntry } from "./ledger.types";

type LedgerShadowComparisonStatus = "MATCH" | "MISMATCH" | "NOT_COMPARED";

type LedgerShadowResponse = {
  success: boolean;
  shadowLedgerRunId?: string | null;
  comparisonStatus: LedgerShadowComparisonStatus;
  mismatches: Array<{
    field: string;
    expected: string;
    actual: string;
    mismatchType: string;
    severity: string;
  }>;
  correlationId: string;
};

function isShadowModeEnabled() {
  return process.env.LEDGER_SHADOW_MODE_ENABLED === "true";
}

function getLedgerServiceUrl() {
  return (
    process.env.LEDGER_SERVICE_URL?.replace(/\/$/, "") ||
    "http://ledger-service:8080"
  );
}

function getCorrelationId(input: CreateLedgerEntryInput) {
  const value = input.metadata?.correlationId;

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function runLedgerShadowComparison({
  input,
  ledgerEntry,
}: {
  input: CreateLedgerEntryInput;
  ledgerEntry: LedgerEntry;
}): Promise<void> {
  if (!isShadowModeEnabled()) {
    return;
  }

  const correlationId = getCorrelationId(input);

  try {
    const response = await fetch(
      `${getLedgerServiceUrl()}/v1/ledger/shadow/execute`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(correlationId ? { "x-correlation-id": correlationId } : {}),
        },
        body: JSON.stringify({
          correlationId,
          transactionId: ledgerEntry.id,
          accountId: ledgerEntry.accountId,
          walletId: ledgerEntry.walletId,
          entryType: ledgerEntry.transactionType,
          direction: ledgerEntry.direction,
          amountMinor: ledgerEntry.amount,
          currency: ledgerEntry.currencyCode,
          actorId:
            typeof input.metadata?.actorUserId === "string"
              ? input.metadata.actorUserId
              : null,
          idempotencyKey: ledgerEntry.idempotencyKey,
          metadata: {
            referenceType: ledgerEntry.referenceType,
            referenceId: ledgerEntry.referenceId,
            reversalOfLedgerEntryId: ledgerEntry.reversalOfLedgerEntryId,
          },
          expectedMonolithResult: {
            transactionId: ledgerEntry.id,
            accountId: ledgerEntry.accountId,
            walletId: ledgerEntry.walletId,
            entryType: ledgerEntry.transactionType,
            direction: ledgerEntry.direction,
            amountMinor: ledgerEntry.amount,
            currency: ledgerEntry.currencyCode,
            idempotencyKey: ledgerEntry.idempotencyKey,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Ledger shadow endpoint returned ${response.status}.`);
    }

    const shadowResult = (await response.json()) as LedgerShadowResponse;

    if (shadowResult.comparisonStatus === "MISMATCH") {
      logger.warn({
        message: "Ledger shadow comparison mismatch.",
        correlationId: shadowResult.correlationId,
        metadata: {
          ledgerEntryId: ledgerEntry.id,
          shadowLedgerRunId: shadowResult.shadowLedgerRunId ?? null,
          mismatches: shadowResult.mismatches,
        },
      });
      return;
    }

    logger.info({
      message: "Ledger shadow comparison completed.",
      correlationId: shadowResult.correlationId,
      metadata: {
        ledgerEntryId: ledgerEntry.id,
        shadowLedgerRunId: shadowResult.shadowLedgerRunId ?? null,
        comparisonStatus: shadowResult.comparisonStatus,
      },
    });
  } catch (error) {
    logger.warn({
      message: "Ledger shadow comparison failed.",
      correlationId,
      metadata: {
        ledgerEntryId: ledgerEntry.id,
        error:
          error instanceof Error ? error.message : "Unknown ledger shadow error.",
      },
    });
  }
}
