import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { simulateLedgerPromotion } from "@/src/domains/ledger-authority/ledger-authority.service";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json({ success: false, error: error.message }, { status: error.status });
}

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const body = await request.json().catch(() => ({}));
    const simulation = await simulateLedgerPromotion({
      actorUserId: authContext.user.id,
      correlationId: body?.correlationId,
    });

    return NextResponse.json({ success: true, simulation });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) return authErrorResponse(error);

    return NextResponse.json(
      { success: false, error: "Unable to simulate ledger promotion." },
      { status: 500 }
    );
  }
}
