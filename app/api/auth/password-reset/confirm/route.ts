import { NextResponse } from "next/server";

import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";
import { confirmPasswordResetWithAuthService } from "@/src/domains/auth/auth-service.client";

export const runtime = "nodejs";

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      success: false,
      errors: ["Password reset request is invalid."],
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    }
  );
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        errors: ["Password reset request is invalid."],
      },
      { status: 400 }
    );
  }

  const token =
    typeof (body as { token?: unknown })?.token === "string"
      ? (body as { token: string }).token
      : null;
  const rateLimit = checkAuthRateLimit({
    area: "PASSWORD_RESET_CONFIRM",
    request,
    identifiers: [token],
  });

  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const newPassword =
    typeof (body as { newPassword?: unknown })?.newPassword === "string"
      ? (body as { newPassword: string }).newPassword
      : "";
  try {
    const result = await confirmPasswordResetWithAuthService({
      resetToken: token ?? "",
      newPassword,
    });
    if (result.status === 200 && result.body?.success) {
      return NextResponse.json({ success: true });
    }
    return NextResponse.json(
      {
        success: false,
        errors: result.body?.errors ?? ["Password reset request is invalid."],
      },
      { status: 400 }
    );
  } catch {
    return NextResponse.json(
      { success: false, errors: ["Password reset request is invalid."] },
      { status: 503 }
    );
  }
}
