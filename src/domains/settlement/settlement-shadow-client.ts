import { logger } from "@/src/lib/observability/logger";
import type { Ticket, TicketLine } from "../tickets/ticket.types";
import type { SettlementRecord } from "./settlement.types";

type ShadowComparisonStatus = "MATCH" | "MISMATCH" | "NOT_COMPARED";

type ShadowSettlementResponse = {
  success: boolean;
  shadowSettlementId: string;
  comparisonStatus: ShadowComparisonStatus;
  mismatches: Array<{
    field: string;
    expected: string;
    actual: string;
  }>;
  correlationId: string;
};

export type SettlementShadowExecutionSummary = {
  attempted: number;
  matches: number;
  mismatches: number;
  failures: number;
  lastMismatchAt?: string | null;
};

function isShadowModeEnabled() {
  return process.env.SETTLEMENT_SHADOW_MODE_ENABLED === "true";
}

function getSettlementServiceUrl() {
  return (
    process.env.SETTLEMENT_SERVICE_URL?.replace(/\/$/, "") ||
    "http://settlement-service:8080"
  );
}

function mapOutcome(outcome: SettlementRecord["outcome"]) {
  if (outcome === "win") return "WIN";
  if (outcome === "push") return "PUSH";
  if (outcome === "void") return "VOID";

  return "LOSS";
}

async function callShadowSettlement({
  settlementRecord,
  ticket,
  ticketLine,
  winningNumbers,
  currency,
  correlationId,
}: {
  settlementRecord: SettlementRecord;
  ticket: Ticket;
  ticketLine: TicketLine;
  winningNumbers: number[];
  currency: string;
  correlationId?: string | null;
}): Promise<ShadowSettlementResponse> {
  const mappedOutcome = mapOutcome(settlementRecord.outcome);
  const response = await fetch(
    `${getSettlementServiceUrl()}/v1/settlement/shadow/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(correlationId ? { "x-correlation-id": correlationId } : {}),
      },
      body: JSON.stringify({
        correlationId,
        settlementRunId: settlementRecord.settlementRunId,
        ticketId: settlementRecord.ticketId,
        drawingId: settlementRecord.drawingId,
        gameId: settlementRecord.gameId,
        wagerType: settlementRecord.wagerTypeId,
        stakeAmount: settlementRecord.stake,
        currency,
        selectedNumbers: ticketLine.selectedNumbers ?? [],
        winningNumbers,
        expectedMonolithResult: {
          calculatedOutcome: mappedOutcome,
          grossPayout: settlementRecord.payout,
          netAmount: settlementRecord.netAmount,
          stakeAmount: settlementRecord.stake,
          currency,
        },
        metadata: {
          ticketNumber: ticket.ticketNumber,
          ticketLineId: ticketLine.id,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Settlement shadow endpoint returned ${response.status}.`);
  }

  return response.json() as Promise<ShadowSettlementResponse>;
}

export async function runSettlementShadowComparison({
  settlementRecords,
  tickets,
  ticketLines,
  winningNumbers,
  currency,
  correlationId,
}: {
  settlementRecords: SettlementRecord[];
  tickets: Ticket[];
  ticketLines: TicketLine[];
  winningNumbers: number[];
  currency?: string | null;
  correlationId?: string | null;
}): Promise<SettlementShadowExecutionSummary> {
  const summary: SettlementShadowExecutionSummary = {
    attempted: 0,
    matches: 0,
    mismatches: 0,
    failures: 0,
    lastMismatchAt: null,
  };

  if (!isShadowModeEnabled()) {
    return summary;
  }

  if (!currency) {
    logger.warn({
      message: "Settlement shadow comparison skipped because currency is missing.",
      correlationId,
      metadata: {
        settlementRecordCount: settlementRecords.length,
      },
    });

    return summary;
  }

  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const ticketLinesById = new Map(
    ticketLines.map((ticketLine) => [ticketLine.id, ticketLine])
  );

  for (const settlementRecord of settlementRecords) {
    const ticket = ticketsById.get(settlementRecord.ticketId);
    const ticketLine = ticketLinesById.get(settlementRecord.ticketLineId);

    if (!ticket || !ticketLine) {
      continue;
    }

    summary.attempted += 1;

    try {
      const shadowResult = await callShadowSettlement({
        settlementRecord,
        ticket,
        ticketLine,
        winningNumbers,
        currency,
        correlationId,
      });

      if (shadowResult.comparisonStatus === "MATCH") {
        summary.matches += 1;
      } else if (shadowResult.comparisonStatus === "MISMATCH") {
        summary.mismatches += 1;
        summary.lastMismatchAt = new Date().toISOString();
        logger.warn({
          message: "Settlement shadow comparison mismatch.",
          correlationId,
          metadata: {
            settlementRecordId: settlementRecord.id,
            ticketId: settlementRecord.ticketId,
            shadowSettlementId: shadowResult.shadowSettlementId,
            mismatches: shadowResult.mismatches,
          },
        });
      }
    } catch (error) {
      summary.failures += 1;
      logger.warn({
        message: "Settlement shadow comparison failed.",
        correlationId,
        metadata: {
          settlementRecordId: settlementRecord.id,
          ticketId: settlementRecord.ticketId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown settlement shadow error.",
        },
      });
    }
  }

  logger.info({
    message: "Settlement shadow comparison completed.",
    correlationId,
    metadata: summary,
  });

  return summary;
}
