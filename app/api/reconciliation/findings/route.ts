import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  getReconciliationFindings,
  ReconciliationValidationError,
} from "@/src/domains/reconciliation/reconciliation.service";
import type { ReconciliationSeverity } from "@/src/domains/reconciliation/reconciliation.types";

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
    await requirePermission(request, "reports.view");
    const findings = await getReconciliationFindings({
      runId: url.searchParams.get("runId"),
      severity: url.searchParams.get("severity") as ReconciliationSeverity | null,
      checkCode: url.searchParams.get("checkCode"),
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100,
    });

    return NextResponse.json({
      success: true,
      findings,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof ReconciliationValidationError) {
      return NextResponse.json(
        {
          success: false,
          errors: error.errors,
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load reconciliation findings.",
      },
      { status: 500 }
    );
  }
}
