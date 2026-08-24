import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "Legacy Quick Pick generation is retired. Use canonical ticket acceptance.",
      code: "LEGACY_QUICK_PICK_AUTHORITY_RETIRED",
    },
    { status: 410 },
  );
}
