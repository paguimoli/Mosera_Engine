import { applyCreditSettlement } from "../financial-authority/financial-authority-credit";
import { resolveTicketFundingSnapshot } from "../financial-authority/financial-authority.policy";
import type { CreditSettlementApplicationResult } from "../credit/credit-reservation.types";
import type { Ticket } from "../tickets/ticket.types";
import type { SettlementRecord } from "./settlement.types";

export type SettlementCreditApplicationStatus =
  | "applied"
  | "skipped"
  | "failed";

export type SettlementCreditApplicationResult = {
  settlementRecordId: string;
  ticketId: string;
  reservationId?: string | null;
  status: SettlementCreditApplicationStatus;
  reason?: string;
  application?: CreditSettlementApplicationResult;
};

export type ApplyCreditSettlementForRecordInput = {
  settlementRecord: SettlementRecord;
  ticket: Ticket;
  currency: string;
  correlationId?: string | null;
  idempotencyKey?: string | null;
};

export type ApplyCreditSettlementForRecordsInput = {
  settlementRecords: SettlementRecord[];
  tickets: Ticket[];
  currency: string;
  correlationId?: string | null;
};

function isIntegerMinorUnitAmount(value: number) {
  return Number.isInteger(value);
}

function createSettlementId(record: SettlementRecord) {
  return record.id || `${record.settlementRunId}:${record.ticketLineId}`;
}

function createIdempotencyKey(record: SettlementRecord) {
  return `credit-settlement:${createSettlementId(record)}`;
}

function isCreditSettlementEligible(record: SettlementRecord, ticket: Ticket) {
  const fundingInstrument = resolveTicketFundingSnapshot(ticket.fundingType);
  if (!fundingInstrument) {
    return "Ticket does not use a reservable launch funding instrument.";
  }

  if (!ticket.reservationId) {
    return "Credit ticket does not have a reservation id.";
  }

  if (record.status !== "settled" && record.status !== "void") {
    return "Settlement record is not final.";
  }

  if (!isIntegerMinorUnitAmount(record.stake) || record.stake <= 0) {
    return "Settlement record stake is not a positive integer minor unit value.";
  }

  if (!isIntegerMinorUnitAmount(record.netAmount)) {
    return "Settlement record net amount is not an integer minor unit value.";
  }

  return null;
}

export async function applyCreditSettlementForRecord({
  settlementRecord,
  ticket,
  currency,
  correlationId,
  idempotencyKey,
}: ApplyCreditSettlementForRecordInput): Promise<SettlementCreditApplicationResult> {
  const ineligibleReason = isCreditSettlementEligible(settlementRecord, ticket);

  if (ineligibleReason) {
    return {
      settlementRecordId: settlementRecord.id,
      ticketId: settlementRecord.ticketId,
      reservationId: ticket.reservationId ?? null,
      status: "skipped",
      reason: ineligibleReason,
    };
  }

  try {
    const application = await applyCreditSettlement({
      reservationId: ticket.reservationId || "",
      ticketId: settlementRecord.ticketId,
      settlementId: createSettlementId(settlementRecord),
      releaseAmount: settlementRecord.stake,
      balanceImpact: settlementRecord.netAmount,
      currency,
      idempotencyKey: idempotencyKey || createIdempotencyKey(settlementRecord),
      correlationId,
      metadata: {
        fundingInstrument: resolveTicketFundingSnapshot(ticket.fundingType),
        settlementRunId: settlementRecord.settlementRunId,
        ticketLineId: settlementRecord.ticketLineId,
        outcome: settlementRecord.outcome,
        settlementRecordStatus: settlementRecord.status,
      },
    });

    return {
      settlementRecordId: settlementRecord.id,
      ticketId: settlementRecord.ticketId,
      reservationId: ticket.reservationId,
      status: "applied",
      application,
    };
  } catch (error) {
    return {
      settlementRecordId: settlementRecord.id,
      ticketId: settlementRecord.ticketId,
      reservationId: ticket.reservationId ?? null,
      status: "failed",
      reason:
        error instanceof Error
          ? error.message
          : "Credit settlement application failed.",
    };
  }
}

export async function applyCreditSettlementForRecords({
  settlementRecords,
  tickets,
  currency,
  correlationId,
}: ApplyCreditSettlementForRecordsInput): Promise<
  SettlementCreditApplicationResult[]
> {
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const results: SettlementCreditApplicationResult[] = [];

  for (const settlementRecord of settlementRecords) {
    const ticket = ticketsById.get(settlementRecord.ticketId);

    if (!ticket) {
      results.push({
        settlementRecordId: settlementRecord.id,
        ticketId: settlementRecord.ticketId,
        status: "skipped",
        reason: "Ticket not found for settlement record.",
      });
      continue;
    }

    results.push(
      await applyCreditSettlementForRecord({
        settlementRecord,
        ticket,
        currency,
        correlationId,
      })
    );
  }

  return results;
}
