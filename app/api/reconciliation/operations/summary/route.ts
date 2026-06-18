import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getReconciliationOperationsSummary } from "@/src/domains/reconciliation/reconciliation.service";

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
    const summary = await getReconciliationOperationsSummary();

    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load reconciliation operations summary.",
      },
      { status: 500 }
    );
  }
}
