import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getLedgerShadowMismatches } from "@/src/domains/ledger-shadow/ledger-shadow-reporting.service";

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
    accountId: url.searchParams.get("accountId"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    limit: Number(url.searchParams.get("limit") ?? 100),
  };
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "system.admin");
    const mismatches = await getLedgerShadowMismatches(getFilters(request));

    return NextResponse.json({
      success: true,
      mismatches,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load ledger shadow mismatches.",
      },
      { status: 500 }
    );
  }
}
