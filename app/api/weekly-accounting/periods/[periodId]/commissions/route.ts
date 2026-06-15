import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { listWeeklyCommissionRecords } from "@/src/domains/commissions/commission.service";

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

export async function GET(request: Request, { params }: RouteParams) {
  const { periodId } = await params;

  try {
    await requirePermission(request, "reports.view");
    const records = await listWeeklyCommissionRecords(periodId);

    return NextResponse.json({
      success: true,
      records,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load weekly commission records.",
      },
      { status: 500 }
    );
  }
}
