import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      error: "temporarily_unavailable",
      error_description: "OAuth provider functionality is disabled during Authentication Authority consolidation.",
    },
    { status: 503 }
  );
}
