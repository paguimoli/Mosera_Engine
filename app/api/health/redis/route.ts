import { NextResponse } from "next/server";

import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";
import { pingRedis } from "@/src/lib/redis/redis.client";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const correlationId = getOrCreateCorrelationId(request);

  try {
    await pingRedis();

    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "redis",
      correlationId,
    });
  } catch (error) {
    logger.error({
      message: "Redis health check failed.",
      correlationId,
      metadata: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        service: "redis",
        correlationId,
      },
      { status: 503 }
    );
  }
}
