import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { listCashierTransactions } from "@/src/domains/cashier/cashier.service";
import { authErrorResponse } from "../cashier-route.helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requirePermission(request, "ledger.view");
    const transactions = await listCashierTransactions();

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
        error: "Unable to load cashier transactions.",
      },
      { status: 500 }
    );
  }
}
