import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  LedgerAuthorityValidationError,
  promoteLedgerAuthority,
} from "@/src/domains/ledger-authority/ledger-authority.service";
import { logger } from "@/src/lib/observability/logger";

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

function sanitizeError(error: unknown) {
  if (!(error instanceof Error)) {
    return { message: "Unknown error." };
  }

  return {
    name: error.name,
    message: error.message,
  };
}

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const body = await request.json().catch(() => ({}));
    const promotion = await promoteLedgerAuthority({
      actor: authContext.user,
      domain: body.domain,
      mode: body.mode,
      justification: body.justification,
      correlationId: body.correlationId,
    });

    return NextResponse.json({
      success: true,
      promotion,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof LedgerAuthorityValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status }
      );
    }

    logger.error({
      message: "Ledger authority promotion execution failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to execute Ledger authority promotion.",
      },
      { status: 500 }
    );
  }
}
