import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountingValidationError,
  closeWeeklyAccounting,
} from "@/src/domains/accounting/accounting.service";
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

function getCloseMode(value: unknown) {
  const closeMode = getString(value).toUpperCase();

  if (closeMode === "CARRY_BALANCE" || closeMode === "ZERO_BALANCE") {
    return closeMode;
  }

  return closeMode || null;
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
    return validationErrorResponse(["Invalid weekly close payload."]);
  }

  const payload = body as Record<string, unknown>;

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const snapshots = await closeWeeklyAccounting({
      weekStart: getString(payload.weekStart ?? payload.week_start),
      weekEnd: getString(payload.weekEnd ?? payload.week_end),
      accountScope:
        getString(payload.accountScope ?? payload.account_scope) || null,
      currency: getString(payload.currency || "USD"),
      closeMode: getCloseMode(payload.closeMode ?? payload.close_mode),
      correlationId,
    });

    return NextResponse.json({
      success: true,
      snapshots,
      correlationId,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof AccountingValidationError) {
      return validationErrorResponse(error.errors);
    }

    logger.error({
      message: "Weekly accounting close failed.",
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
            : "Unable to close weekly accounting.",
        correlationId,
      },
      { status: 400 }
    );
  }
}
