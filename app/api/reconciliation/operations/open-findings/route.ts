import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getOpenReconciliationFindings } from "@/src/domains/reconciliation/reconciliation.service";

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
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);

  try {
    await requirePermission(request, "system.admin");
    const findings = await getOpenReconciliationFindings(
      Number.isInteger(limit) && limit > 0 ? limit : 100
    );

    return NextResponse.json({
      success: true,
      findings,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load open reconciliation findings.",
      },
      { status: 500 }
    );
  }
}
