import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  createWeeklySummariesForPeriod,
  listSummariesForPeriod,
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

function validationErrorResponse(errors: string[]) {
  return NextResponse.json(
    {
      success: false,
      errors,
    },
    { status: 400 }
  );
}

export async function GET(request: Request, { params }: RouteParams) {
  const { periodId } = await params;

  try {
    await requirePermission(request, "reports.view");
    const summaries = await listSummariesForPeriod(periodId);

    return NextResponse.json({
      success: true,
      summaries,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load weekly account summaries.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const { periodId } = await params;

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const summaries = await createWeeklySummariesForPeriod(periodId);

    return NextResponse.json({
      success: true,
      summaries,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof WeeklyAccountingBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to create weekly account summaries.",
      },
      { status: 500 }
    );
  }
}
