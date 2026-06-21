import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  getPromotionDecision,
  parsePromotionDecisionDomain,
} from "@/src/domains/promotion-decision/promotion-decision.service";

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
  try {
    await requirePermission(request, "system.admin");
    const url = new URL(request.url);
    const domain = parsePromotionDecisionDomain(url.searchParams.get("domain"));
    const decision = await getPromotionDecision({ domain });

    return NextResponse.json({
      success: true,
      decision,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load promotion decision.",
      },
      { status: 500 }
    );
  }
}
