import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  MarketBusinessRuleError,
  setDefaultMarket,
} from "@/src/domains/markets/market.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ marketId: string }>;
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
  const { marketId } = await params;

  try {
    await requirePermission(request, "markets.edit");
    const market = await setDefaultMarket(marketId);

    return NextResponse.json({
      success: true,
      market,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof MarketBusinessRuleError) {
      return NextResponse.json(
        {
          success: false,
          errors: [error.message],
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to set default market.",
      },
      { status: 500 }
    );
  }
}
