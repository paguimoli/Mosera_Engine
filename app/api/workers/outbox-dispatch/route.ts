import { NextResponse } from "next/server";

import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";
import { dispatchPendingOutboxEvents } from "@/src/domains/workers/outbox-dispatcher.service";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";
import {
  authErrorResponse,
  getPositiveInteger,
  requireAnyPermission,
} from "../worker-route.helpers";

export const runtime = "nodejs";

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

// TODO: This route should be replaced or restricted before production when dedicated worker containers exist.
export async function POST(request: Request) {
  try {
    await requireAnyPermission(request, [
      "settings.edit",
      "ledger.post_adjustment",
    ]);

    const correlationId = getOrCreateCorrelationId(request);
    const body = await readJsonBody(request);
    const result = await dispatchPendingOutboxEvents({
      limit: getPositiveInteger(body.limit, 25),
      correlationId,
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to dispatch outbox events.",
      },
      { status: 500 }
    );
  }
}
