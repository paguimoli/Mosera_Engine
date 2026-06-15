import { NextResponse } from "next/server";

import { getApiClientAuthContext } from "@/src/domains/auth/api-client.service";

export const runtime = "nodejs";

export async function GET(request: Request) {
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
