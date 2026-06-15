import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  closeWeeklyPeriod,
  WeeklyAccountingBusinessRuleError,
} from "@/src/domains/weekly-accounting/weekly-accounting.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ periodId: string }>;
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
  const { periodId } = await params;

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const period = await closeWeeklyPeriod(periodId);

    return NextResponse.json({
      success: true,
      period,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof WeeklyAccountingBusinessRuleError) {
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
        error: "Unable to close weekly accounting period.",
      },
      { status: 500 }
    );
  }
}
