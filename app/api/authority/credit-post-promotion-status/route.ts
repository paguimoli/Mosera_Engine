import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getCreditPostPromotionStatus } from "@/src/domains/credit-authority/credit-authority.service";
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
    const postPromotionStatus = await getCreditPostPromotionStatus();

    return NextResponse.json({
      success: true,
      postPromotionStatus,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    logger.error({
      message: "Credit post-promotion status failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load Credit post-promotion status.",
      },
      { status: 500 }
    );
  }
}
