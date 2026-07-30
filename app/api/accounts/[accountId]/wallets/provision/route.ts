import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountScopeNotFoundError,
  requireScopedAccount,
} from "@/src/domains/accounts/account-scope-governance";
import {
  provisionWalletsForAccount,
  WalletBusinessRuleError,
  WalletValidationError,
} from "@/src/domains/financial-authority/financial-authority.entrypoints";

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

function validationErrorResponse(errors: string[]) {
  return NextResponse.json(
    {
      success: false,
      errors,
    },
    { status: 400 }
  );
}

export async function POST(request: Request, { params }: RouteParams) {
  const { accountId } = await params;

  try {
    await requireScopedAccount(request, accountId, "accounts.edit");
    const wallets = await provisionWalletsForAccount(accountId);

    return NextResponse.json({
      success: true,
      wallets,
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

    if (error instanceof WalletValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof WalletBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to provision wallets.",
      },
      { status: 500 }
    );
  }
}
