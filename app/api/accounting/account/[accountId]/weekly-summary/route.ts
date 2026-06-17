import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountingValidationError,
  getWeeklyAccountingSnapshots,
} from "@/src/domains/accounting/accounting.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ accountId: string }>;
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
  const { accountId } = await params;
  const url = new URL(request.url);

  try {
    await requirePermission(request, "reports.view");
    const snapshots = await getWeeklyAccountingSnapshots({
      accountId,
      weekStart: url.searchParams.get("weekStart"),
      weekEnd: url.searchParams.get("weekEnd"),
      currency: url.searchParams.get("currency"),
    });

    return NextResponse.json({
      success: true,
      snapshots,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof AccountingValidationError) {
      return validationErrorResponse(error.errors);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load account weekly accounting snapshots.",
      },
      { status: 500 }
    );
  }
}
