import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  approveAuthorityPromotion,
  AuthorityApprovalValidationError,
} from "@/src/domains/authority-approval/authority-approval.service";
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
      request, body, "AUTHORITY_APPROVAL_CAPTURE", "Authority promotion approval"
    );
    const governed = await executeGovernedOperation(
      {
        authContext,
        commandType: "AUTHORITY_APPROVAL_CAPTURE",
        affectedAuthority: String(body.domain ?? "UNKNOWN"),
        targetType: "PROMOTION_APPROVAL",
        targetId: String(body.domain ?? "UNKNOWN"),
        ...metadata,
        payload: {
          domain: body.domain,
          acknowledgedWarnings: body.acknowledgedWarnings,
        },
      },
      () => approveAuthorityPromotion({
        actor: authContext.user,
        domain: body.domain,
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
      promotionDecisionBefore: result.promotionDecisionBefore,
      promotionDecisionAfter: result.promotionDecisionAfter,
      operationalCommandId: governed.command.commandId,
      operationalIdempotent: governed.idempotent,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof AuthorityApprovalValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status }
      );
    }

    logger.error({
      message: "Promotion approval capture failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to capture promotion approval.",
      },
      { status: 500 }
    );
  }
}
