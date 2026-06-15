import { NextResponse } from "next/server";

import { confirmPasswordResetController } from "@/src/domains/auth/auth.controller";

export const runtime = "nodejs";

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

  const result = await confirmPasswordResetController({ body });

  if (!result.success || !result.data) {
    return NextResponse.json(
      {
        success: false,
        errors: result.errors ?? ["Password reset request is invalid."],
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
  });
}
