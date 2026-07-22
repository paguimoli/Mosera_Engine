import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: "OAuth introspection is disabled during Authentication Authority consolidation.",
    },
    { status: 503 }
  );
}
