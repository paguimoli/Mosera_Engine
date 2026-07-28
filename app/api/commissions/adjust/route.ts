import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CommissionValidationError,
  createCommissionAdjustment,
} from "@/src/domains/commissions/commission.service";
import { resolveScopedAccount } from "@/src/domains/accounts/account-scope-governance";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";

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

function getInteger(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);

  return Number.NaN;
}

export async function POST(request: Request) {
  const correlationId = getOrCreateCorrelationId(request);
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid commission adjustment payload."]);
  }

  const payload = body as Record<string, unknown>;

  try {
    const context = await requirePermission(request, "ledger.post_adjustment");
    const accountId = getString(payload.accountId ?? payload.account_id);
    await resolveScopedAccount(context, accountId);
    const adjustment = await createCommissionAdjustment({
      accountId,
      runId: getString(payload.runId ?? payload.run_id),
      adjustmentAmount: getInteger(
        payload.adjustmentAmount ?? payload.adjustment_amount
      ),
      reasonCode: getString(payload.reasonCode ?? payload.reason_code),
      notes: getString(payload.notes) || null,
      actorUserId: context.user.id,
      correlationId,
    });

    return NextResponse.json({
      success: true,
      adjustment,
      correlationId,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CommissionValidationError) {
      return validationErrorResponse(error.errors);
    }

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to create commission adjustment.",
        correlationId,
      },
      { status: 400 }
    );
  }
}
