import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { getLedgerReferenceRemediationQueue } from "@/src/domains/ledger-reference-remediation/ledger-reference-remediation.service";
import type {
  LedgerReferenceRemediationConfidence,
  LedgerReferenceRemediationStatus,
} from "@/src/domains/ledger-reference-remediation/ledger-reference-remediation.types";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json({ success: false, error: error.message }, { status: error.status });
}

function optionalEnum<T extends string>(
  value: string | null,
  allowed: readonly T[]
): T | undefined {
  return value && allowed.includes(value as T) ? (value as T) : undefined;
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "system.admin");
    const url = new URL(request.url);
    const queue = await getLedgerReferenceRemediationQueue({
      status: optionalEnum<LedgerReferenceRemediationStatus>(
        url.searchParams.get("status"),
        ["NEW", "UNDER_REVIEW", "APPROVED", "REJECTED", "COMPLETED", "EXPIRED"]
      ),
      confidence: optionalEnum<LedgerReferenceRemediationConfidence>(
        url.searchParams.get("confidence"),
        ["HIGH", "MEDIUM", "LOW", "UNKNOWN"]
      ),
      search: url.searchParams.get("search") ?? undefined,
    });

    return NextResponse.json({ success: true, remediationQueue: queue });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) return authErrorResponse(error);

    logger.error({
      message: "Ledger reference remediation queue failed.",
      metadata: { error: error instanceof Error ? error.message : "Unknown error." },
    });

    return NextResponse.json(
      { success: false, error: "Unable to load ledger reference remediation queue." },
      { status: 500 }
    );
  }
}
