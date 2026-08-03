import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  certifySettlementAuthority,
  SettlementStabilizationValidationError,
} from "@/src/domains/settlement-stabilization/settlement-stabilization.service";
import {
  executeGovernedOperation,
  resolveOperationalRequestMetadata,
} from "@/src/domains/operational-governance/operational-governance.service";
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
    const body = await request.json().catch(() => ({}));
    const metadata = resolveOperationalRequestMetadata(
      request, body, "AUTHORITY_CERTIFICATION_CAPTURE", "Settlement authority certification"
    );
    const governed = await executeGovernedOperation(
      {
        authContext,
        commandType: "AUTHORITY_CERTIFICATION_CAPTURE",
        affectedAuthority: "SETTLEMENT",
        targetType: "CERTIFICATION",
        targetId: "SETTLEMENT",
        ...metadata,
        payload: { acknowledgedWarnings: body.acknowledgedWarnings },
      },
      () => certifySettlementAuthority({
        actor: authContext.user,
        justification: body.justification,
        acknowledgedWarnings: body.acknowledgedWarnings,
        correlationId: metadata.correlationId,
      })
    );
    const result = governed.result;

    return NextResponse.json({
      success: true,
      approval: result.approval,
      idempotent: result.idempotent,
      stabilizationBefore: result.stabilizationBefore,
      stabilizationAfter: result.stabilizationAfter,
      operationalCommandId: governed.command.commandId,
      operationalIdempotent: governed.idempotent,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof SettlementStabilizationValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status }
      );
    }

    logger.error({
      message: "Settlement certification capture failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to capture Settlement certification.",
      },
      { status: 500 }
    );
  }
}
