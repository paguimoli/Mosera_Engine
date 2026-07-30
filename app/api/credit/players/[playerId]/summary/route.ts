import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountScopeNotFoundError,
  requireScopedAccount,
} from "@/src/domains/accounts/account-scope-governance";
import {
  CreditReservationValidationError,
  getPlayerCreditSummary,
} from "@/src/domains/financial-authority/financial-authority.entrypoints";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ playerId: string }>;
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

export async function GET(request: Request, { params }: RouteParams) {
  const { playerId } = await params;
  const correlationId = getOrCreateCorrelationId(request);

  try {
    await requireScopedAccount(request, playerId, "accounts.view");
    const summary = await getPlayerCreditSummary(playerId);

    return NextResponse.json({
      success: true,
      summary,
      correlationId,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }
    if (error instanceof AccountScopeNotFoundError) {
      return NextResponse.json(
        { success: false, error: error.message, correlationId },
        { status: 404 }
      );
    }

    if (error instanceof CreditReservationValidationError) {
      return NextResponse.json(
        {
          success: false,
          errors: error.errors,
        },
        { status: 400 }
      );
    }

    logger.warn({
      message: "Credit summary request failed.",
      correlationId,
      metadata: {
        playerId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load credit summary.",
        correlationId,
      },
      { status: 500 }
    );
  }
}
