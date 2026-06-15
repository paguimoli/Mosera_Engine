import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CommissionBusinessRuleError,
  generateWeeklyCommissionRecords,
} from "@/src/domains/commissions/commission.service";

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

export async function POST(request: Request, { params }: RouteParams) {
  const { periodId } = await params;

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const records = await generateWeeklyCommissionRecords(periodId);

    return NextResponse.json({
      success: true,
      records,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CommissionBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to generate weekly commission records.",
      },
      { status: 500 }
    );
  }
}
