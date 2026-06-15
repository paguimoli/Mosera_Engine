import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  provisionWalletsForAccount,
  WalletBusinessRuleError,
  WalletValidationError,
} from "@/src/domains/wallets/wallet.service";

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
    await requirePermission(request, "accounts.edit");
    const wallets = await provisionWalletsForAccount(accountId);

    return NextResponse.json({
      success: true,
      wallets,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
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
