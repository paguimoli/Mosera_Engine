import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  OperationalAccessError,
  revokeAllOperationalSessionsForUser,
} from "@/src/domains/operational-access/operational-access.service";
import {
  executeGovernedOperation,
  resolveOperationalRequestMetadata,
} from "@/src/domains/operational-governance/operational-governance.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ userId: string }>;
};

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const actor = await requirePermission(request, "system.admin");
    const { userId } = await params;

    const metadata = resolveOperationalRequestMetadata(
      request, {}, "SESSION_REVOCATION", "Revoke all operational sessions"
    );
    const governed = await executeGovernedOperation(
      {
        authContext: actor,
        commandType: "SESSION_REVOCATION",
        affectedAuthority: "AUTHENTICATION",
        targetType: "IDENTITY_SESSIONS",
        targetId: userId,
        ...metadata,
        payload: { userId, allSessions: true },
      },
      async () => {
        await revokeAllOperationalSessionsForUser({ userId, actor });
        return { userId, revoked: true };
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
        error: "Unable to revoke user sessions.",
      },
      { status: 500 }
    );
  }
}
