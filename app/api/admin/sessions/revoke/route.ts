import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  OperationalAccessError,
  revokeOperationalSession,
} from "@/src/domains/operational-access/operational-access.service";
import {
  executeGovernedOperation,
  resolveOperationalRequestMetadata,
} from "@/src/domains/operational-governance/operational-governance.service";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid JSON body.",
      },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid session revocation payload.",
      },
      { status: 400 }
    );
  }

  try {
    const actor = await requirePermission(request, "system.admin");
    const record = body as Record<string, unknown>;
    const sessionId = getString(record.sessionId ?? record.session_id);

    const metadata = resolveOperationalRequestMetadata(
      request, record, "SESSION_REVOCATION", "Revoke operational session"
    );
    const governed = await executeGovernedOperation(
      {
        authContext: actor,
        commandType: "SESSION_REVOCATION",
        affectedAuthority: "AUTHENTICATION",
        targetType: "SESSION",
        targetId: sessionId,
        ...metadata,
        payload: { sessionId },
      },
      async () => {
        await revokeOperationalSession({ sessionId, actor });
        return { sessionId, revoked: true };
      }
    );

    return NextResponse.json({
      success: true,
      operationalCommandId: governed.command.commandId,
      idempotent: governed.idempotent,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof OperationalAccessError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to revoke session.",
      },
      { status: 500 }
    );
  }
}
