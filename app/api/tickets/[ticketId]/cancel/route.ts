import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { assertTicketScope } from "@/src/domains/tickets/canonical-ticket.authorization";
import {
  cancelCanonicalTicket,
  CanonicalTicketRepositoryError,
  findCanonicalTicket,
} from "@/src/domains/tickets/canonical-ticket.repository";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";

export async function POST(
  request: Request,
  context: { params: Promise<{ ticketId: string }> }
) {
  try {
    const auth = await requirePermission(request, "tickets.cancel");
    const { ticketId } = await context.params;
    const ticket = await findCanonicalTicket(ticketId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }
    assertTicketScope(auth, ticket);

    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "Idempotency-Key header is required." },
        { status: 400 }
      );
    }
    const body = (await request.json()) as { reasonCode?: unknown };
    if (typeof body.reasonCode !== "string" || body.reasonCode.trim() === "") {
      return NextResponse.json({ error: "reasonCode is required." }, { status: 400 });
    }

    const result = await cancelCanonicalTicket({
      ticketId,
      idempotencyKey,
      reasonCode: body.reasonCode.trim(),
      requestedBy: auth.user.id,
      correlationId: getOrCreateCorrelationId(request),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CanonicalTicketRepositoryError) {
      const status = error.message.includes("conflict") ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "Ticket cancellation failed." }, { status: 500 });
  }
}
