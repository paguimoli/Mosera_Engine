import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  getReconciliationRun,
  ReconciliationBusinessRuleError,
  ReconciliationValidationError,
} from "@/src/domains/reconciliation/reconciliation.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ runId: string }>;
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

export async function GET(request: Request, { params }: RouteParams) {
  const { runId } = await params;

  try {
    await requirePermission(request, "reports.view");
    const result = await getReconciliationRun(runId);

    return NextResponse.json({
      success: true,
      ...result,
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

    if (error instanceof ReconciliationBusinessRuleError) {
      return NextResponse.json(
        {
          success: false,
          errors: [error.message],
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load reconciliation run.",
      },
      { status: 500 }
    );
  }
}
