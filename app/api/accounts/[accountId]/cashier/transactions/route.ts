import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { listCashierTransactionsForAccount } from "@/src/domains/cashier/cashier.service";
import { authErrorResponse } from "@/app/api/cashier/cashier-route.helpers";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ accountId: string }>;
};

export async function GET(request: Request, { params }: RouteParams) {
  const { accountId } = await params;

  try {
    await requirePermission(request, "ledger.view");
    const transactions = await listCashierTransactionsForAccount(accountId);

    return NextResponse.json({
      success: true,
      transactions,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
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
