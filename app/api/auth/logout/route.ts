import { NextResponse } from "next/server";

import { logoutController } from "@/src/domains/auth/auth.controller";
import { isAuthServiceProviderEnabled } from "@/src/domains/auth/auth-provider";
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

  if (isAuthServiceProviderEnabled()) {
    const sessionToken =
      typeof (body as { sessionToken?: unknown })?.sessionToken === "string"
        ? (body as { sessionToken: string }).sessionToken
        : null;

    await logoutWithAuthService(sessionToken);
    return logoutSuccessResponse();
  }

  const result = await logoutController({
    body,
  });

  if (!result.success) {
    return logoutSuccessResponse();
  }

  return logoutSuccessResponse();
}
