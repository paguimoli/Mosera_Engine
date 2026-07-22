import { NextResponse } from "next/server";

import { logoutWithAuthService } from "@/src/domains/auth/auth-service.client";

export const runtime = "nodejs";

function logoutSuccessResponse() {
  return NextResponse.json({ success: true });
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return logoutSuccessResponse();
  }

  const sessionToken =
    typeof (body as { sessionToken?: unknown })?.sessionToken === "string"
      ? (body as { sessionToken: string }).sessionToken
      : null;
  await logoutWithAuthService(sessionToken);
  return logoutSuccessResponse();
}
