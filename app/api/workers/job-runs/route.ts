import { NextResponse } from "next/server";

import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";
import { listRecentJobRuns } from "@/src/domains/jobs/job-run.service";
import {
  authErrorResponse,
  getPositiveInteger,
  requireAnyPermission,
} from "../worker-route.helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireAnyPermission(request, ["settings.view"]);

    const url = new URL(request.url);
    const jobRuns = await listRecentJobRuns({
      limit: getPositiveInteger(url.searchParams.get("limit"), 50),
    });

    return NextResponse.json({
      success: true,
      jobRuns,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load job runs.",
      },
      { status: 500 }
    );
  }
}
