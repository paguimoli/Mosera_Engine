import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  getLedgerReferenceRemediationExecutionPlan,
  LedgerReferenceRemediationValidationError,
} from "@/src/domains/ledger-reference-remediation/ledger-reference-remediation.service";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json({ success: false, error: error.message }, { status: error.status });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ remediationId: string }> }
) {
  try {
    await requirePermission(request, "system.admin");
    const { remediationId } = await context.params;
    const executionPlan =
      await getLedgerReferenceRemediationExecutionPlan(remediationId);

    return NextResponse.json({ success: true, executionPlan });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) return authErrorResponse(error);
    if (error instanceof LedgerReferenceRemediationValidationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }

    logger.error({
      message: "Ledger reference remediation execution plan failed.",
      metadata: { error: error instanceof Error ? error.message : "Unknown error." },
    });

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load ledger reference remediation execution plan.",
      },
      { status: 500 }
    );
  }
}
