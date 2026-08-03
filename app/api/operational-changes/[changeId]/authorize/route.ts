import { NextResponse } from "next/server";

import { requirePermission } from "@/src/domains/auth/auth-middleware";
import { authorizeOperationalCommand } from "@/src/domains/operational-governance/operational-governance.repository";
import { authorizeOperationalCommandSecurity,
  resolvePrivilegedSessionId } from "@/src/domains/operational-security/operational-security.service";
import { findOperationalChange } from "@/src/domains/operational-change/operational-change.repository";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ changeId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const { changeId } = await params;
    const change = await findOperationalChange(changeId);
    if (!change) return NextResponse.json({ success: false, error: "Operational change not found." },
      { status: 404 });
    if (change.actorIdentityId !== authContext.user.id) {
      return NextResponse.json({ success: false,
        error: "Only the canonical change requester may authorize execution." }, { status: 403 });
    }
    await authorizeOperationalCommandSecurity({ commandId: change.commandId, authContext,
      privilegedSessionId: resolvePrivilegedSessionId(request) });
    await authorizeOperationalCommand(change.commandId);
    return NextResponse.json({ success: true, changeId: change.changeId,
      operationalCommandId: change.commandId, changeType: change.changeType,
      executionAuthorized: true });
  } catch (error) {
    return NextResponse.json({ success: false,
      error: error instanceof Error ? error.message : "Operational change authorization failed." },
      { status: 403 });
  }
}
