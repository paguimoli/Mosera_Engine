import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { assertTicketScope } from "@/src/domains/tickets/canonical-ticket.authorization";
import {
  findCanonicalTicket,
  getCanonicalTicketHistory,
} from "@/src/domains/tickets/canonical-ticket.repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ ticketId: string }> }
) {
  try {
    const auth = await requirePermission(request, "tickets.read");
    const { ticketId } = await context.params;
    const ticket = await findCanonicalTicket(ticketId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }
    assertTicketScope(auth, ticket);
    return NextResponse.json({
      ticketId,
      status: ticket.status,
      history: await getCanonicalTicketHistory(ticketId),
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Ticket history read failed." }, { status: 500 });
  }
}
