import { NextResponse } from "next/server";

import { getApiClientAuthContext } from "@/src/domains/auth/api-client.service";
import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rateLimit = checkAuthRateLimit({
    area: "OAUTH_INTROSPECTION",
    request,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid access token.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      }
    );
  }

  let context: Awaited<ReturnType<typeof getApiClientAuthContext>>;

  try {
    context = await getApiClientAuthContext(request);
  } catch {
    context = null;
  }

  if (!context) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid access token.",
      },
      { status: 401 }
    );
  }

  return NextResponse.json({
    clientId: context.clientId,
    clientName: context.clientName,
    scopes: context.scopes,
  });
}
