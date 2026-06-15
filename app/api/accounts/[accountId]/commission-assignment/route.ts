import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  assignCommissionPlanToAccount,
  CommissionBusinessRuleError,
  getActiveCommissionAssignment,
  listAssignmentsForAccount,
} from "@/src/domains/commissions/commission.service";

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

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function GET(request: Request, { params }: RouteParams) {
  const { accountId } = await params;

  try {
    await requirePermission(request, "accounts.view");
    const activeAssignment = await getActiveCommissionAssignment(accountId);
    const assignments = await listAssignmentsForAccount(accountId);

    return NextResponse.json({
      success: true,
      assignment: activeAssignment,
      assignments,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load commission assignment.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const { accountId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid commission assignment payload."]);
  }

  const payload = body as Record<string, unknown>;
  const commissionPlanId = getString(
    payload.commissionPlanId ?? payload.commission_plan_id
  );

  if (!commissionPlanId) {
    return validationErrorResponse(["Commission plan id is required."]);
  }

  try {
    await requirePermission(request, "accounts.edit");
    const assignment = await assignCommissionPlanToAccount({
      accountId,
      commissionPlanId,
      effectiveFrom: getString(payload.effectiveFrom ?? payload.effective_from) ||
        null,
      effectiveTo: getString(payload.effectiveTo ?? payload.effective_to) ||
        null,
    });

    return NextResponse.json({
      success: true,
      assignment,
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
        error: "Unable to assign commission plan.",
      },
      { status: 500 }
    );
  }
}
