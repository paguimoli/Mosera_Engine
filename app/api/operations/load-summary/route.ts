import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getLoadSummary } from "@/src/domains/load-testing/load-testing.service";
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
    const loadSummary = await getLoadSummary();

    return NextResponse.json({ success: true, loadSummary });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) return authErrorResponse(error);

    logger.error({
      message: "Load summary report failed.",
      metadata: { error: error instanceof Error ? error.message : "Unknown error." },
    });

    return NextResponse.json(
      { success: false, error: "Unable to load summary." },
      { status: 500 }
    );
  }
}
