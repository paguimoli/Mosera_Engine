import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  ReconciliationBusinessRuleError,
  ReconciliationValidationError,
  resolveReconciliationFinding,
} from "@/src/domains/reconciliation/reconciliation.service";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ findingId: string }>;
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

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request, { params }: RouteParams) {
  const correlationId = getOrCreateCorrelationId(request);
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        errors: ["Invalid JSON body."],
        correlationId,
      },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      {
        success: false,
        errors: ["Invalid reconciliation finding resolution payload."],
        correlationId,
      },
      { status: 400 }
    );
  }

  try {
    const actor = await requirePermission(request, "system.admin");
    const { findingId } = await params;
    const payload = body as Record<string, unknown>;
    const finding = await resolveReconciliationFinding({
      findingId,
      actor,
      notes: getString(payload.notes ?? payload.resolutionNotes),
      correlationId,
    });

    return NextResponse.json({
      success: true,
      finding,
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
        error: "Unable to resolve reconciliation finding.",
        correlationId,
      },
      { status: 500 }
    );
  }
}
