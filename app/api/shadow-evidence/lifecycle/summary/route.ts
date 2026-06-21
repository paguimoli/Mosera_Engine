import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getShadowEvidenceLifecycleSummary } from "@/src/domains/shadow-evidence-lifecycle/shadow-evidence-lifecycle.service";

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
    const summary = await getShadowEvidenceLifecycleSummary();

    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load shadow evidence lifecycle summary.",
      },
      { status: 500 }
    );
  }
}
