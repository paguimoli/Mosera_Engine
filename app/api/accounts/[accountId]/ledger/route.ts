import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountScopeNotFoundError,
  requireScopedAccount,
} from "@/src/domains/accounts/account-scope-governance";
import { listLedgerEntriesForAccount } from "@/src/domains/financial-authority/financial-authority.entrypoints";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ accountId: string }>;
};

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export async function GET(request: Request, { params }: RouteParams) {
  const { accountId } = await params;

  try {
    await requireScopedAccount(request, accountId, "ledger.view");
    const ledgerEntries = await listLedgerEntriesForAccount(accountId);

    return NextResponse.json({
      success: true,
      ledgerEntries,
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
        error: "Unable to load ledger entries.",
      },
      { status: 500 }
    );
  }
}
