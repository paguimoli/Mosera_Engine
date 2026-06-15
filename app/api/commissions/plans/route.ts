import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CommissionBusinessRuleError,
  createPersistedCommissionPlan,
  listPersistedCommissionPlans,
} from "@/src/domains/commissions/commission.service";
import type {
  CommissionCalculationBasis,
  PersistedCommissionPlanStatus,
} from "@/src/domains/commissions/commission.types";

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

function parseCalculationBasis(
  value: unknown
): CommissionCalculationBasis | null {
  const basis = getString(value);

  if (basis === "NET_LOSS" || basis === "TURNOVER" || basis === "HYBRID") {
    return basis;
  }

  return null;
}

function parsePlanStatus(
  value: unknown
): PersistedCommissionPlanStatus | undefined {
  const status = getString(value);

  if (status === "ACTIVE" || status === "DISABLED") {
    return status;
  }

  return undefined;
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "settings.view");
    const plans = await listPersistedCommissionPlans();

    return NextResponse.json({
      success: true,
      plans,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load commission plans.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid commission plan payload."]);
  }

  const payload = body as Record<string, unknown>;
  const calculationBasis = parseCalculationBasis(
    payload.calculationBasis ?? payload.calculation_basis
  );

  if (!calculationBasis) {
    return validationErrorResponse(["Commission calculation basis is invalid."]);
  }

  try {
    await requirePermission(request, "settings.edit");
    const parsedStatus = parsePlanStatus(payload.status);
    const plan = await createPersistedCommissionPlan({
      code: getString(payload.code),
      name: getString(payload.name),
      description: getString(payload.description) || null,
      calculationBasis,
      ...(parsedStatus ? { status: parsedStatus } : {}),
    });

    return NextResponse.json({
      success: true,
      plan,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CommissionBusinessRuleError) {
      const status = error.message.includes("already exists") ? 409 : 400;

      return NextResponse.json(
        {
          success: false,
          errors: [error.message],
        },
        { status }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to create commission plan.",
      },
      { status: 500 }
    );
  }
}
