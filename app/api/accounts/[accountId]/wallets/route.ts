import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { listWalletsForAccount } from "@/src/domains/wallets/wallet.service";

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
    await requirePermission(request, "accounts.view");
    const wallets = await listWalletsForAccount(accountId);

    return NextResponse.json({
      success: true,
      wallets,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load wallets.",
      },
      { status: 500 }
    );
  }
}
