import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { excludeClassifiedQaShadowEvidence } from "@/src/domains/shadow-evidence-lifecycle/shadow-evidence-lifecycle.service";

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

export async function POST(request: Request) {
  try {
    const actor = await requirePermission(request, "system.admin");
    const result = await excludeClassifiedQaShadowEvidence({
      actor,
      correlationId: request.headers.get("x-correlation-id"),
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
        error: "Unable to exclude classified QA shadow evidence.",
        details: error instanceof Error ? error.message : null,
      },
      { status: 500 }
    );
  }
}
