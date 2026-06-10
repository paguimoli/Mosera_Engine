import type { Ticket, TicketLine } from "./ticket.types";

export function saveTicket(tickets: Ticket[], ticket: Ticket) {
  return [...tickets, ticket];
}

export function saveTicketLines(ticketLines: TicketLine[], lines: TicketLine[]) {
  return [...ticketLines, ...lines];
}

export function findTicketById(tickets: Ticket[], ticketId: string) {
  return tickets.find((ticket) => ticket.id === ticketId);
}

export function listTicketLinesByTicketId(
  ticketLines: TicketLine[],
  ticketId: string
) {
  return ticketLines.filter((line) => line.ticketId === ticketId);
}

export function updateTicketStatus(tickets: Ticket[], nextTicket: Ticket) {
  return tickets.map((ticket) =>
    ticket.id === nextTicket.id ? nextTicket : ticket
  );
}
