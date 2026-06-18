import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  listOperationalUsers,
  OperationalAccessError,
} from "@/src/domains/operational-access/operational-access.service";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";
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

export async function GET(request: Request) {
  const correlationId = getOrCreateCorrelationId(request);

  try {
    await requirePermission(request, "system.admin");
    const users = await listOperationalUsers();

    return NextResponse.json({
      success: true,
      users,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof OperationalAccessError) {
      logger.error({
        message: "Operational user inventory failed.",
        correlationId,
        metadata: {
          error: error.message,
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 400 }
      );
    }

    logger.error({
      message: "Operational user inventory failed unexpectedly.",
      correlationId,
      metadata: {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Unknown operational inventory failure.",
      },
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load operational users.",
      },
      { status: 500 }
    );
  }
}
