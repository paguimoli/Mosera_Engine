import { NextResponse } from "next/server";

import { delegateMfaMutationToAuthService } from "@/src/domains/auth/auth-service.client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  try {
    const result = await delegateMfaMutationToAuthService("challenge-verify", body);
    return NextResponse.json(result.body ?? { success: false }, { status: result.status });
  } catch {
    return NextResponse.json({ success: false, error: "MFA authority unavailable." }, { status: 503 });
  }
}
