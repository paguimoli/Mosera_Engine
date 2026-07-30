import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountScopeNotFoundError,
  requireScopedAccount,
} from "@/src/domains/accounts/account-scope-governance";
import { listCashierTransactionsForAccount } from "@/src/domains/financial-authority/financial-authority.entrypoints";
import { authErrorResponse } from "@/app/api/cashier/cashier-route.helpers";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ accountId: string }>;
};

export async function GET(request: Request, { params }: RouteParams) {
  const { accountId } = await params;

  try {
    await requireScopedAccount(request, accountId, "ledger.view");
    const transactions = await listCashierTransactionsForAccount(accountId);

    return NextResponse.json({
      success: true,
      transactions,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }
    if (error instanceof AccountScopeNotFoundError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load account cashier transactions.",
      },
      { status: 500 }
    );
  }
}
