import { generateTicketNumber, parseTicketSelectedNumbers } from "./ticket.helpers";
import type {
  Ticket,
  TicketFundingType,
  TicketLine,
  TicketStatus,
} from "./ticket.types";

export type DraftTicketLine = Omit<TicketLine, "id" | "ticketId" | "createdAt">;

export function calculateTicketTotalStake(lines: Array<{ stake: number }>) {
  return lines.reduce((total, line) => total + Number(line.stake || 0), 0);
}

export function calculateTicketPotentialPayout(
  lines: Array<{ potentialPayout: number }>
) {
  return lines.reduce(
    (total, line) => total + Number(line.potentialPayout || 0),
    0
  );
}

export function buildDraftTicketLine(form: {
  wagerTypeId: string;
  wagerOptionId: string;
  selectedNumbers: string;
  stake: string;
  potentialPayout: string;
}) {
  const stake = Number(form.stake || 0);
  const potentialPayout = Number(form.potentialPayout || 0);

  if (!form.wagerTypeId) {
    return {
      ok: false,
      message: "Please select a wager type.",
      line: null,
    };
  }

  if (Number.isNaN(stake) || stake <= 0) {
    return {
      ok: false,
      message: "Ticket line stake must be greater than 0.",
      line: null,
    };
  }

  if (Number.isNaN(potentialPayout)) {
    return {
      ok: false,
      message: "Potential payout must be numeric.",
      line: null,
    };
  }

  return {
    ok: true,
    message: "",
    line: {
      wagerTypeId: form.wagerTypeId,
      wagerOptionId: form.wagerOptionId || null,
      selectedNumbers: parseTicketSelectedNumbers(form.selectedNumbers),
      stake,
      potentialPayout,
      status: "pending",
      resultAmount: null,
    } satisfies DraftTicketLine,
  };
}

export function buildTestTicketPayload({
  form,
  draftLines,
}: {
  form: {
    accountId: string;
    marketId: string;
    gameId: string;
    drawingId: string;
    fundingType: TicketFundingType;
    notes: string;
  };
  draftLines: DraftTicketLine[];
}) {
  if (!form.accountId || !form.gameId || !form.drawingId || !form.fundingType) {
    return {
      ok: false,
      message: "Please select account, game, drawing, and funding type.",
      ticket: null,
      lines: [],
    };
  }

  if (draftLines.length === 0) {
    return {
      ok: false,
      message: "Please add at least one ticket line.",
      ticket: null,
      lines: [],
    };
  }

  const ticketId = `TICKET-ID-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const totalStake = calculateTicketTotalStake(draftLines);
  const potentialPayout = calculateTicketPotentialPayout(draftLines);
  const ticket: Ticket = {
    id: ticketId,
    ticketNumber: generateTicketNumber(),
    accountId: form.accountId,
    marketId: form.marketId || null,
    gameId: form.gameId,
    drawingId: form.drawingId,
    totalStake,
    potentialPayout,
    fundingType: form.fundingType,
    status: "pending",
    createdAt,
    acceptedAt: null,
    settledAt: null,
    ledgerTransactionIds: [],
    notes: form.notes.trim(),
  };
  const lines: TicketLine[] = draftLines.map((line, index) => ({
    ...line,
    id: `TICKET-LINE-${Date.now()}-${index}`,
    ticketId,
    createdAt,
  }));

  return {
    ok: true,
    message: "",
    ticket,
    lines,
  };
}

export function applyTicketStatusTransition(
  ticket: Ticket,
  nextStatus: TicketStatus
) {
  if (nextStatus === "accepted" && ticket.status !== "pending") {
    return ticket;
  }

  if (nextStatus === "cancelled" && ticket.status !== "pending") {
    return ticket;
  }

  if (
    nextStatus === "void" &&
    ticket.status !== "pending" &&
    ticket.status !== "accepted"
  ) {
    return ticket;
  }

  return {
    ...ticket,
    status: nextStatus,
    acceptedAt:
      nextStatus === "accepted" ? new Date().toISOString() : ticket.acceptedAt,
  };
}
