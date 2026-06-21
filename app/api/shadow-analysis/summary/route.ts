import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  getShadowAnalysisSummary,
  parseShadowAnalysisWindow,
} from "@/src/domains/shadow-analysis/shadow-analysis.service";

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
    const url = new URL(request.url);
    const window = parseShadowAnalysisWindow(url.searchParams.get("window"));
    const analysis = await getShadowAnalysisSummary(window);

    return NextResponse.json({
      success: true,
      analysis,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load shadow evidence analysis.",
      },
      { status: 500 }
    );
  }
}
