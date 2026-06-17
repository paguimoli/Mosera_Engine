import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CommissionBusinessRuleError,
  CommissionValidationError,
  getSnapshotCommissionRun,
} from "@/src/domains/commissions/commission.service";

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
    const result = await getSnapshotCommissionRun(runId);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CommissionValidationError) {
      return NextResponse.json(
        {
          success: false,
          errors: error.errors,
        },
        { status: 400 }
      );
    }

    if (error instanceof CommissionBusinessRuleError) {
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
        error: "Unable to load commission run.",
      },
      { status: 500 }
    );
  }
}
