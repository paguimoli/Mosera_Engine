import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  disableBreakGlassAccount,
  OperationalAccessError,
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
      request, {}, "BREAK_GLASS_LIFECYCLE", "Disable break-glass account"
    );
    const governed = await executeGovernedOperation(
      {
        authContext: actor,
        commandType: "BREAK_GLASS_LIFECYCLE",
        affectedAuthority: "AUTHENTICATION",
        targetType: "BREAK_GLASS_ACCOUNT",
        targetId: userId,
        ...metadata,
        payload: { action: "DISABLE", userId },
      },
      async () => {
        await disableBreakGlassAccount({ userId, actor });
        return { userId, status: "DISABLED" };
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
        error: "Unable to disable break-glass account.",
      },
      { status: 500 }
    );
  }
}
