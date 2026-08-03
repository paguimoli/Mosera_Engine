import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  captureLedgerReferenceRemediationApproval,
  LedgerReferenceRemediationValidationError,
} from "@/src/domains/ledger-reference-remediation/ledger-reference-remediation.service";
import {
  executeGovernedOperation,
  resolveOperationalRequestMetadata,
} from "@/src/domains/operational-governance/operational-governance.service";
import { logger } from "@/src/lib/observability/logger";

export const runtime = "nodejs";

const REMEDIATION_APPROVAL_GROUPS = new Set(["Super Admin", "Operations Admin"]);

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json({ success: false, error: error.message }, { status: error.status });
}

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");

    if (
      !authContext.groups.some((group) =>
        REMEDIATION_APPROVAL_GROUPS.has(group.name)
      )
    ) {
      throw new AuthMiddlewareError(403, "Permission denied.");
    }

    const body = await request.json().catch(() => ({}));
    const metadata = resolveOperationalRequestMetadata(
      request,
      body,
      "LEDGER_REMEDIATION_APPROVAL_CAPTURE",
      "Ledger reference remediation approval"
    );
    const governed = await executeGovernedOperation(
      {
        authContext,
        commandType: "LEDGER_REMEDIATION_APPROVAL_CAPTURE",
        affectedAuthority: "LEDGER",
        targetType: "LEDGER_REMEDIATION",
        targetId: String(body.remediationId ?? "UNKNOWN"),
        ...metadata,
        payload: {
          remediationId: body.remediationId,
          remediationDecision: body.remediationDecision,
        },
      },
      () => captureLedgerReferenceRemediationApproval({
        actor: authContext.user,
        remediationId: body.remediationId,
        remediationDecision: body.remediationDecision,
        justification: body.justification,
        correlationId: metadata.correlationId,
      })
    );
    const result = governed.result;

    return NextResponse.json({
      success: true,
      approval: result.approval,
      outboxEventId: result.outboxEventId,
      idempotent: result.idempotent,
      candidateBefore: result.candidateBefore,
      candidateAfter: result.candidateAfter,
      operationalCommandId: governed.command.commandId,
      operationalIdempotent: governed.idempotent,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) return authErrorResponse(error);
    if (error instanceof LedgerReferenceRemediationValidationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }

    logger.error({
      message: "Ledger reference remediation approval failed.",
      metadata: { error: error instanceof Error ? error.message : "Unknown error." },
    });

    return NextResponse.json(
      { success: false, error: "Unable to capture ledger reference remediation approval." },
      { status: 500 }
    );
  }
}
