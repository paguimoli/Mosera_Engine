import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CommissionValidationError,
  generateSnapshotCommissionRun,
} from "@/src/domains/commissions/commission.service";
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

export async function POST(request: Request) {
  const correlationId = getOrCreateCorrelationId(request);
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid commission run payload."]);
  }

  const payload = body as Record<string, unknown>;

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const run = await generateSnapshotCommissionRun({
      weekStart: getString(payload.weekStart ?? payload.week_start),
      weekEnd: getString(payload.weekEnd ?? payload.week_end),
      currency: getString(payload.currency || "USD"),
      correlationId,
    });

    return NextResponse.json({
      success: true,
      run,
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
            : "Unable to generate commission run.",
        correlationId,
      },
      { status: 400 }
    );
  }
}
