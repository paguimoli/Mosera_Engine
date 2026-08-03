import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CreditAuthorityValidationError,
  promoteCreditAuthority,
} from "@/src/domains/credit-authority/credit-authority.service";
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
    const metadata = resolveOperationalRequestMetadata(
      request, body, "AUTHORITY_PROMOTION_EXECUTION", "Credit authority promotion"
    );
    const governed = await executeGovernedOperation(
      {
        authContext,
        commandType: "AUTHORITY_PROMOTION_EXECUTION",
        affectedAuthority: "CREDIT",
        targetType: "AUTHORITY",
        targetId: "CREDIT",
        ...metadata,
        payload: { domain: body.domain, mode: body.mode },
      },
      () => promoteCreditAuthority({
        actor: authContext.user,
        domain: body.domain,
        mode: body.mode,
        justification: body.justification,
        correlationId: metadata.correlationId,
      }),
      {
        changeType: "PROVIDER_ACTIVATION",
        expectedState: { authority: "CREDIT", mode: body.mode },
        verify: (result) => ({ expectedStateReached: Boolean(result), authorityAccepted: true,
          readinessMaintained: true, auditRecorded: true,
          observedState: result as unknown as Record<string, unknown> }),
      }
    );

    return NextResponse.json({
      success: true,
      promotion: governed.result,
      operationalCommandId: governed.command.commandId,
      idempotent: governed.idempotent,
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
      message: "Credit authority promotion execution failed.",
      metadata: sanitizeError(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to execute Credit authority promotion.",
      },
      { status: 500 }
    );
  }
}
