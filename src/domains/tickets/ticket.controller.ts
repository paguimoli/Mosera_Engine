import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import {
  findTicketById,
  saveTicket,
  saveTicketLines,
  updateTicketStatus,
} from "./ticket.repository";
import {
  applyTicketStatusTransition,
  buildDraftTicketLine,
  buildTestTicketPayload,
  type DraftTicketLine,
} from "./ticket.service";
import type { Ticket, TicketLine, TicketStatus } from "./ticket.types";
import { validateTicketForm, validateTicketLineForm } from "./ticket.validation";

export function addTicketLineController(form: {
  wagerTypeId: string;
  wagerOptionId: string;
  selectedNumbers: string;
  stake: string;
  potentialPayout: string;
}) {
  const validation = validateTicketLineForm(form);

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const result = buildDraftTicketLine(form);

  if (!result.ok || !result.line) {
    return controllerFailure(result.message);
  }

  return controllerSuccess({ line: result.line });
}

export function createTicketController({
  form,
  draftLines,
  tickets,
  ticketLines,
}: {
  form: Parameters<typeof buildTestTicketPayload>[0]["form"];
  draftLines: DraftTicketLine[];
  tickets: Ticket[];
  ticketLines: TicketLine[];
}) {
  const validation = validateTicketForm({ form, draftLines });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const result = buildTestTicketPayload({ form, draftLines });

  if (!result.ok || !result.ticket) {
    return controllerFailure(result.message);
  }

  return controllerSuccess({
    ticket: result.ticket,
    lines: result.lines,
    tickets: saveTicket(tickets, result.ticket),
    ticketLines: saveTicketLines(ticketLines, result.lines),
  });
}

export function updateTicketStatusController({
  tickets,
  ticketId,
  nextStatus,
}: {
  tickets: Ticket[];
  ticketId: string;
  nextStatus: TicketStatus;
}) {
  const ticket = findTicketById(tickets, ticketId);

  if (!ticket) {
    return controllerFailure("Ticket not found.");
  }

  const nextTicket = applyTicketStatusTransition(ticket, nextStatus);

  return controllerSuccess({
    tickets: updateTicketStatus(tickets, nextTicket),
  });
}
