import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getLedgerReferenceAudit } from "@/src/domains/platform-evidence/platform-evidence.service";
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

export async function GET(request: Request) {
  try {
    await requirePermission(request, "system.admin");
    const ledgerReferenceAudit = await getLedgerReferenceAudit();

    return NextResponse.json({
      success: true,
      ledgerReferenceAudit,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    logger.error({
      message: "Ledger reference audit failed.",
      metadata: {
        error: error instanceof Error ? error.message : "Unknown error.",
      },
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load ledger reference audit.",
      },
      { status: 500 }
    );
  }
}
