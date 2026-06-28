import { NextResponse } from "next/server";

import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";
import { requestPasswordResetController } from "@/src/domains/auth/auth.controller";

export const runtime = "nodejs";

const PASSWORD_RESET_MESSAGE =
  "If the account exists, password reset instructions have been generated.";

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      success: true,
      message: PASSWORD_RESET_MESSAGE,
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
    body = null;
  }

  const identifierBody = body as { username?: unknown; email?: unknown };
  const rateLimit = checkAuthRateLimit({
    area: "PASSWORD_RESET_REQUEST",
    request,
    identifiers: [
      typeof identifierBody?.username === "string" ? identifierBody.username : null,
      typeof identifierBody?.email === "string" ? identifierBody.email : null,
    ],
  });

  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const result = await requestPasswordResetController({ body });

  if (!result.success || !result.data) {
    return NextResponse.json({
      success: true,
      message: PASSWORD_RESET_MESSAGE,
    });
  }

  return NextResponse.json(result.data);
}
