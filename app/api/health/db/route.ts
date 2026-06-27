import { NextResponse } from "next/server";

import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const correlationId = getOrCreateCorrelationId(request);
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .select("id")
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error({
      message: "Database health check failed.",
      correlationId,
      metadata: {
        code: error.code,
        message: error.message,
      },
    });

    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        service: "database",
        correlationId,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "database",
    correlationId,
  });
}
