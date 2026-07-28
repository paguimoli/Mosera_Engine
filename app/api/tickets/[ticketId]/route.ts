import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  assertTicketScope,
} from "@/src/domains/tickets/canonical-ticket.authorization";
import {
  CanonicalTicketRepositoryError,
  findCanonicalTicket,
  getCanonicalTicketCorrelations,
  getCanonicalTicketHistory,
} from "@/src/domains/tickets/canonical-ticket.repository";

export const runtime = "nodejs";

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
    const [history, correlations] = await Promise.all([
      getCanonicalTicketHistory(ticketId),
      getCanonicalTicketCorrelations(ticketId),
    ]);
    return NextResponse.json({ ticket, history, correlations });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CanonicalTicketRepositoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Ticket read failed." }, { status: 500 });
  }
}
