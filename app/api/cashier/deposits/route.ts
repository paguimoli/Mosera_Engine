import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  CashierBusinessRuleError,
  CashierValidationError,
  requestDeposit,
} from "@/src/domains/cashier/cashier.service";
import {
  authErrorResponse,
  getMetadata,
  getNumber,
  getString,
  readJsonObject,
  validationErrorResponse,
} from "../cashier-route.helpers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { payload, response } = await readJsonObject(request);

  if (response) {
    return response;
  }

  if (!payload) {
    return validationErrorResponse(["Invalid cashier payload."]);
  }

  try {
    const authContext = await requirePermission(request, "ledger.post_deposit");
    const transaction = await requestDeposit({
      accountId: getString(payload.accountId ?? payload.account_id),
      walletId: getString(payload.walletId ?? payload.wallet_id) || null,
      transactionType: "DEPOSIT",
      amount: getNumber(payload.amount),
      currencyCode: getString(payload.currencyCode ?? payload.currency_code),
      paymentMethod:
        getString(payload.paymentMethod ?? payload.payment_method) || null,
      provider: getString(payload.provider) || null,
      providerReference:
        getString(payload.providerReference ?? payload.provider_reference) ||
        null,
      requestedByUserId: authContext.user.id,
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

    if (error instanceof CashierValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof CashierBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to request deposit.",
      },
      { status: 500 }
    );
  }
}
