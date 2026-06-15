import { NextResponse } from "next/server";

import { requestPasswordResetController } from "@/src/domains/auth/auth.controller";

export const runtime = "nodejs";

const PASSWORD_RESET_MESSAGE =
  "If the account exists, password reset instructions have been generated.";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const result = await requestPasswordResetController({ body });

  if (!result.success || !result.data) {
    return NextResponse.json({
      success: true,
      message: PASSWORD_RESET_MESSAGE,
    });
  }

  return NextResponse.json(result.data);
}
