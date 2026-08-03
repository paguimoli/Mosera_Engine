import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { AuthMiddlewareError, requirePermission } from "@/src/domains/auth/auth-middleware";
import {
  endPrivilegedSession,
  OperationalSecurityError,
} from "@/src/domains/operational-security/operational-security.service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const { sessionId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const ticketReference = typeof body.ticketReference === "string" ? body.ticketReference.trim() : "";
    if (!reason || !ticketReference) {
      return NextResponse.json(
        { success: false, error: "Reason and ticket reference are required." },
        { status: 400 }
      );
    }
    await endPrivilegedSession({
      privilegedSessionId: sessionId,
      actorIdentityId: authContext.user.id,
      reason,
      ticketReference,
      correlationId: request.headers.get("x-correlation-id")?.trim() || randomUUID(),
      forced: body.forced === true,
    });
    return NextResponse.json({ success: true, privilegedSessionId: sessionId, terminated: true });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (error instanceof OperationalSecurityError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: "Unable to terminate privileged session." }, { status: 500 });
  }
}
