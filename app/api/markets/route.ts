import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  listMarkets,
} from "@/src/domains/markets/market.service";
import { legacyPlatformMutationGone } from "@/src/domains/platform-management/platform-mutation-authority";

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
    await requirePermission(request, "markets.view");
    const markets = await listMarkets();

    return NextResponse.json({
      success: true,
      markets,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load markets.",
      },
      { status: 500 }
    );
  }
}

export async function POST() {
  return legacyPlatformMutationGone("market");
}
