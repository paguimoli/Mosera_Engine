import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  ReconciliationBusinessRuleError,
  ReconciliationValidationError,
  reviewReconciliationRun,
} from "@/src/domains/reconciliation/reconciliation.service";
import type { ReconciliationRunReviewStatus } from "@/src/domains/reconciliation/reconciliation.types";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ runId: string }>;
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

function getReviewStatus(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  return ["PENDING", "REVIEWED", "REQUIRES_ATTENTION"].includes(normalized)
    ? (normalized as ReconciliationRunReviewStatus)
    : null;
}

export async function POST(request: Request, { params }: RouteParams) {
  const correlationId = getOrCreateCorrelationId(request);
  let body: unknown = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    body = {};
  }

  try {
    const actor = await requirePermission(request, "system.admin");
    const { runId } = await params;
    const payload = body as Record<string, unknown>;
    const run = await reviewReconciliationRun({
      runId,
      actor,
      reviewStatus: getReviewStatus(payload.reviewStatus ?? payload.review_status),
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

    if (error instanceof ReconciliationValidationError) {
      return NextResponse.json(
        {
          success: false,
          errors: error.errors,
          correlationId,
        },
        { status: 400 }
      );
    }

    if (error instanceof ReconciliationBusinessRuleError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          correlationId,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to review reconciliation run.",
        correlationId,
      },
      { status: 500 }
    );
  }
}
