import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CreditReservationValidationError,
  reserveCreditExposure,
} from "@/src/domains/credit/credit.entrypoints";
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

function getInteger(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);

  return Number.NaN;
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
    return validationErrorResponse(["Invalid credit reservation payload."]);
  }

  const payload = body as Record<string, unknown>;

  try {
    await requirePermission(request, "tickets.create");

    const reservation = await reserveCreditExposure({
      playerId: getString(payload.playerId),
      ticketId: getString(payload.ticketId),
      amount: getInteger(payload.amount),
      currency: getString(payload.currency).toUpperCase(),
      idempotencyKey:
        getString(payload.idempotencyKey) ||
        request.headers.get("Idempotency-Key")?.trim() ||
        "",
      correlationId,
      metadata:
        typeof payload.metadata === "object" &&
        payload.metadata !== null &&
        !Array.isArray(payload.metadata)
          ? (payload.metadata as Record<string, unknown>)
          : {},
    });

    return NextResponse.json({
      success: true,
      reservation,
      correlationId,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CreditReservationValidationError) {
      return validationErrorResponse(error.errors);
    }

    logger.warn({
      message: "Credit reservation request failed.",
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
            : "Unable to reserve credit exposure.",
        correlationId,
      },
      { status: 400 }
    );
  }
}
