import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { listChildren } from "@/src/domains/accounts/account.service";

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
    const accounts = await listChildren(accountId);

    return NextResponse.json({
      success: true,
      accounts,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load child accounts.",
      },
      { status: 500 }
    );
  }
}
