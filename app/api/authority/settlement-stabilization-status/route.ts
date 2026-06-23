import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  getSettlementStabilizationStatus,
  parseSettlementStabilizationWindow,
  SettlementStabilizationValidationError,
} from "@/src/domains/settlement-stabilization/settlement-stabilization.service";
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

export async function GET(request: Request) {
  try {
    await requirePermission(request, "system.admin");
    const url = new URL(request.url);
    const window = parseSettlementStabilizationWindow(
      url.searchParams.get("window")
    );
    const stabilizationStatus = await getSettlementStabilizationStatus({
      window,
    });

    return NextResponse.json({
      success: true,
      stabilizationStatus,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }
    if (error instanceof SettlementStabilizationValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status }
      );
    }

    logger.error({
      message: "Settlement stabilization status failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load Settlement stabilization status.",
      },
      { status: 500 }
    );
  }
}
