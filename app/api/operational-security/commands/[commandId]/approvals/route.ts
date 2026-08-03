import { NextResponse } from "next/server";

import { AuthMiddlewareError, requirePermission } from "@/src/domains/auth/auth-middleware";
import { approveGovernedOperation } from "@/src/domains/operational-governance/operational-governance.service";
import { assertActivePrivilegedSession } from "@/src/domains/operational-security/operational-security.repository";
import { resolvePrivilegedSessionId } from "@/src/domains/operational-security/operational-security.service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ commandId: string }> }
) {
  try {
    const approver = await requirePermission(request, "system.admin");
    const privilegedSessionId = resolvePrivilegedSessionId(request);
    if (!privilegedSessionId) {
      return NextResponse.json({ success: false, error: "Privileged session required." }, { status: 403 });
    }
    await assertActivePrivilegedSession({ privilegedSessionId, authContext: approver });
    const { commandId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const decision = body.decision === "REJECTED" ? "REJECTED" : "APPROVED";
    await approveGovernedOperation({ commandId, approver, source: "HUMAN", decision, reason });
    return NextResponse.json({ success: true, commandId, decision }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Approval denied." },
      { status: 403 }
    );
  }
}
