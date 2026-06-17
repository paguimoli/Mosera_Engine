import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  ReconciliationValidationError,
  runReconciliation,
} from "@/src/domains/reconciliation/reconciliation.service";
import type {
  ReconciliationRunType,
  ReconciliationScopeType,
} from "@/src/domains/reconciliation/reconciliation.types";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";

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
    return validationErrorResponse(["Invalid reconciliation run payload."]);
  }

  const payload = body as Record<string, unknown>;

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const result = await runReconciliation({
      runType: (getString(payload.runType ?? payload.run_type).toUpperCase() ||
        "FULL") as ReconciliationRunType,
      scopeType: (getString(
        payload.scopeType ?? payload.scope_type
      ).toUpperCase() || "GLOBAL") as ReconciliationScopeType,
      scopeId: getString(payload.scopeId ?? payload.scope_id) || null,
      weekStart: getString(payload.weekStart ?? payload.week_start) || null,
      weekEnd: getString(payload.weekEnd ?? payload.week_end) || null,
      currency: getString(payload.currency) || null,
      correlationId,
    });

    return NextResponse.json({
      success: true,
      ...result,
      correlationId,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof ReconciliationValidationError) {
      return validationErrorResponse(error.errors);
    }

    logger.error({
      message: "Reconciliation run failed.",
      correlationId,
      metadata: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to run reconciliation.",
        correlationId,
      },
      { status: 400 }
    );
  }
}
