import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CashierBusinessRuleError,
  rejectCashierTransaction,
} from "@/src/domains/cashier/cashier.service";
import {
  authErrorResponse,
  getMetadata,
  getString,
  readJsonObject,
  validationErrorResponse,
} from "../../../cashier-route.helpers";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ transactionId: string }>;
};

export async function POST(request: Request, { params }: RouteParams) {
  const { transactionId } = await params;
  const { payload, response } = await readJsonObject(request);

  if (response) {
    return response;
  }

  if (!payload) {
    return validationErrorResponse(["Invalid cashier payload."]);
  }

  try {
    const authContext = await requirePermission(request, "ledger.post_adjustment");
    const transaction = await rejectCashierTransaction({
      transactionId,
      rejectedByUserId: authContext.user.id,
      reason: getString(payload.reason),
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
        error: "Unable to reject cashier transaction.",
      },
      { status: 500 }
    );
  }
}
