import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  parsePromotionExecutionDomain,
  promoteSettlementAuthority,
  PromotionExecutionValidationError,
} from "@/src/domains/promotion-execution/promotion-execution.service";
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

  return {
    name: error.name,
    message: error.message,
  };
}

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const body = await request.json().catch(() => ({}));
    const domain = parsePromotionExecutionDomain(body.domain);
    const metadata = resolveOperationalRequestMetadata(
      request, body, "AUTHORITY_PROMOTION_EXECUTION", "Settlement authority promotion"
    );
    const governed = await executeGovernedOperation(
      {
        authContext,
        commandType: "AUTHORITY_PROMOTION_EXECUTION",
        affectedAuthority: "SETTLEMENT",
        targetType: "AUTHORITY",
        targetId: domain,
        ...metadata,
        payload: { domain },
      },
      () => promoteSettlementAuthority({ actor: authContext.user, domain, correlationId: metadata.correlationId })
    );
    const promotion = governed.result;

    return NextResponse.json({
      success: true,
      promotion,
      operationalCommandId: governed.command.commandId,
      idempotent: governed.idempotent,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof PromotionExecutionValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: error.status }
      );
    }

    logger.error({
      message: "Settlement authority promotion execution failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to execute Settlement authority promotion.",
      },
      { status: 500 }
    );
  }
}
