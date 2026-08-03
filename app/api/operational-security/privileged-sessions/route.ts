import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { AuthMiddlewareError, requirePermission } from "@/src/domains/auth/auth-middleware";
import {
  activatePrivilegedSession,
  OperationalSecurityError,
} from "@/src/domains/operational-security/operational-security.service";
import { canonicalHash } from "@/src/domains/operational-governance/operational-governance.repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const correlationId = request.headers.get("x-correlation-id")?.trim() || randomUUID();
    const mfaEvidenceId = typeof body.mfaEvidenceId === "string" ? body.mfaEvidenceId.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const ticketReference = typeof body.ticketReference === "string" ? body.ticketReference.trim() : "";
    const sessionKind = body.sessionKind === "BREAK_GLASS" ? "BREAK_GLASS" : "PRIVILEGED";
    const durationMinutes = typeof body.durationMinutes === "number" ? body.durationMinutes : 15;
    const session = await activatePrivilegedSession({
      authContext,
      sessionKind,
      mfaEvidenceId,
      mfaEvidenceHash: canonicalHash({ mfaEvidenceId, identityId: authContext.user.id }),
      reason,
      ticketReference,
      correlationId,
      durationMinutes,
      authorizationCommandId:
        typeof body.authorizationCommandId === "string" ? body.authorizationCommandId.trim() : null,
    });
    return NextResponse.json({ success: true, session }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (error instanceof OperationalSecurityError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: "Unable to activate privileged session." }, { status: 500 });
  }
}
