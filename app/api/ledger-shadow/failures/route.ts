import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getLedgerShadowFailures } from "@/src/domains/ledger-shadow/ledger-shadow-reporting.service";

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

function getFilters(request: Request) {
  const url = new URL(request.url);

  return {
    transactionId: url.searchParams.get("transactionId"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    limit: Number(url.searchParams.get("limit") ?? 100),
  };
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "system.admin");
    const failures = await getLedgerShadowFailures(getFilters(request));

    return NextResponse.json({
      success: true,
      failures,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load ledger shadow failures.",
      },
      { status: 500 }
    );
  }
}
