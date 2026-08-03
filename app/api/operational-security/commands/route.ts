import { NextResponse } from "next/server";

import { AuthMiddlewareError, requirePermission } from "@/src/domains/auth/auth-middleware";
import {
  assertActivePrivilegedSession,
  findOperationalCommandByIdempotencyKey,
} from "@/src/domains/operational-security/operational-security.repository";
import { resolvePrivilegedSessionId } from "@/src/domains/operational-security/operational-security.service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const privilegedSessionId = resolvePrivilegedSessionId(request);
    if (!privilegedSessionId) {
      return NextResponse.json({ success: false, error: "Privileged session required." }, { status: 403 });
    }
    await assertActivePrivilegedSession({ privilegedSessionId, authContext });
    const idempotencyKey = new URL(request.url).searchParams.get("idempotencyKey")?.trim() || "";
    if (!idempotencyKey) {
      return NextResponse.json({ success: false, error: "Idempotency key is required." }, { status: 400 });
    }
    const command = await findOperationalCommandByIdempotencyKey(idempotencyKey);
    return command
      ? NextResponse.json({ success: true, command })
      : NextResponse.json({ success: false, error: "Command not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: "Operational command lookup denied." }, { status: 403 });
  }
}
