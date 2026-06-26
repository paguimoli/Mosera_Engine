import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  certifyCreditAuthority,
  CreditAuthorityValidationError,
} from "@/src/domains/credit-authority/credit-authority.service";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

const CREDIT_CERTIFICATION_GROUPS = new Set(["Super Admin", "Operations Admin"]);

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

function sanitizeError(error: unknown) {
  if (!(error instanceof Error)) {
    return { message: "Unknown error." };
  }

  const maybeDetails = (error as Error & { details?: unknown }).details;

  return {
    name: error.name,
    message: error.message,
    details: maybeDetails,
  };
}

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");

    if (
      !authContext.groups.some((group) =>
        CREDIT_CERTIFICATION_GROUPS.has(group.name)
      )
    ) {
      throw new AuthMiddlewareError(403, "Permission denied.");
    }

    const body = await request.json().catch(() => ({}));
    const result = await certifyCreditAuthority({
      actor: authContext.user,
      justification: body.justification,
      acknowledgedWarnings: body.acknowledgedWarnings,
      correlationId: body.correlationId,
    });

    return NextResponse.json({
      success: true,
      approval: result.approval,
      idempotent: result.idempotent,
      stabilizationBefore: result.stabilizationBefore,
      stabilizationAfter: result.stabilizationAfter,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CreditAuthorityValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status }
      );
    }

    logger.error({
      message: "Credit certification capture failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to capture Credit certification.",
      },
      { status: 500 }
    );
  }
}
