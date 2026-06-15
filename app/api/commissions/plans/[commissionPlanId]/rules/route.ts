import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  addCommissionPlanRule,
  CommissionBusinessRuleError,
} from "@/src/domains/commissions/commission.service";
import type {
  CommissionRuleType,
  CreateCommissionPlanRuleInput,
} from "@/src/domains/commissions/commission.types";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ commissionPlanId: string }>;
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

function getNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return typeof value === "number" || typeof value === "string"
    ? Number(value)
    : null;
}

function parseRuleType(value: unknown): CommissionRuleType | null {
  const ruleType = getString(value);

  if (
    ruleType === "NET_LOSS_PERCENT" ||
    ruleType === "TURNOVER_PERCENT" ||
    ruleType === "FLAT_AMOUNT"
  ) {
    return ruleType;
  }

  return null;
}

function parseAppliesToAccountType(
  value: unknown
): CreateCommissionPlanRuleInput["appliesToAccountType"] {
  const accountType = getString(value);

  if (
    accountType === "MASTER_AGENT" ||
    accountType === "AGENT" ||
    accountType === "PLAYER"
  ) {
    return accountType;
  }

  return null;
}

export async function POST(request: Request, { params }: RouteParams) {
  const { commissionPlanId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid commission rule payload."]);
  }

  const payload = body as Record<string, unknown>;
  const ruleType = parseRuleType(payload.ruleType ?? payload.rule_type);

  if (!ruleType) {
    return validationErrorResponse(["Commission rule type is invalid."]);
  }

  try {
    await requirePermission(request, "settings.edit");
    const rule = await addCommissionPlanRule({
      commissionPlanId,
      ruleType,
      rate: Number(payload.rate),
      appliesToAccountType: parseAppliesToAccountType(
        payload.appliesToAccountType ?? payload.applies_to_account_type
      ),
      minAmount: getNullableNumber(payload.minAmount ?? payload.min_amount),
      maxAmount: getNullableNumber(payload.maxAmount ?? payload.max_amount),
    });

    return NextResponse.json({
      success: true,
      rule,
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
        error: "Unable to create commission plan rule.",
      },
      { status: 500 }
    );
  }
}
