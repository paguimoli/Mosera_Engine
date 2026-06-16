import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  cancelCashierTransaction,
  CashierBusinessRuleError,
} from "@/src/domains/cashier/cashier.service";
import {
  authErrorResponse,
  getMetadata,
  getString,
  readOptionalJsonObject,
  validationErrorResponse,
} from "../../../cashier-route.helpers";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ transactionId: string }>;
};

export async function POST(request: Request, { params }: RouteParams) {
  const { transactionId } = await params;
  const { payload, response } = await readOptionalJsonObject(request);

  if (response) {
    return response;
  }

  if (!payload) {
    return validationErrorResponse(["Invalid cashier payload."]);
  }

  try {
    const authContext = await requirePermission(request, "ledger.post_adjustment");
    const transaction = await cancelCashierTransaction({
      transactionId,
      cancelledByUserId: authContext.user.id,
      reason: getString(payload.reason) || null,
      metadata: getMetadata(payload.metadata),
    });

    return NextResponse.json({
      success: true,
      transaction,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof CashierBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to cancel cashier transaction.",
      },
      { status: 500 }
    );
  }
}
