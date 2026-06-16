import { NextResponse } from "next/server";

import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";
import { listRecentOutboxEvents } from "@/src/domains/outbox/outbox.service";
import type { OutboxEventStatus } from "@/src/domains/outbox/outbox.types";
import {
  authErrorResponse,
  getPositiveInteger,
  requireAnyPermission,
} from "../worker-route.helpers";

export const runtime = "nodejs";

const OUTBOX_EVENT_STATUSES: OutboxEventStatus[] = [
  "PENDING",
  "PUBLISHED",
  "FAILED",
  "DEAD_LETTER",
];

function getOutboxStatus(value: string | null): OutboxEventStatus | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase() as OutboxEventStatus;

  return OUTBOX_EVENT_STATUSES.includes(normalized) ? normalized : undefined;
}

export async function GET(request: Request) {
  try {
    await requireAnyPermission(request, ["settings.view"]);

    const url = new URL(request.url);
    const outboxEvents = await listRecentOutboxEvents({
      limit: getPositiveInteger(url.searchParams.get("limit"), 50),
      status: getOutboxStatus(url.searchParams.get("status")),
    });

    return NextResponse.json({
      success: true,
      outboxEvents,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load outbox events.",
      },
      { status: 500 }
    );
  }
}
