import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getConcurrencyBaseline } from "@/src/domains/load-testing/load-testing.service";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    { success: false, error: error.message },
    { status: error.status }
  );
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "system.admin");
    const concurrencyBaseline = await getConcurrencyBaseline();

    return NextResponse.json({ success: true, concurrencyBaseline });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) return authErrorResponse(error);

    logger.error({
      message: "Concurrency baseline report failed.",
      metadata: { error: error instanceof Error ? error.message : "Unknown error." },
    });

    return NextResponse.json(
      { success: false, error: "Unable to load concurrency baseline." },
      { status: 500 }
    );
  }
}
