import { NextResponse } from "next/server";

import { verifyMfaChallenge } from "@/src/domains/auth/mfa.service";
import type { AuthRequestMetadata } from "@/src/domains/auth/auth.types";

export const runtime = "nodejs";

const INVALID_MFA_CHALLENGE_ERROR = "Invalid MFA challenge.";

type VerifyMfaChallengeRequestBody = {
  challengeToken?: unknown;
  code?: unknown;
};

function getRequestMetadata(request: Request): AuthRequestMetadata {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress =
    forwardedFor?.split(",").at(0)?.trim() ||
    request.headers.get("x-real-ip") ||
    null;

  return {
    ipAddress,
    userAgent: request.headers.get("user-agent"),
  };
}

function getChallengeInput(body: VerifyMfaChallengeRequestBody) {
  if (
    typeof body.challengeToken !== "string" ||
    body.challengeToken.trim() === "" ||
    typeof body.code !== "string" ||
    body.code.trim() === ""
  ) {
    return null;
  }

  return {
    challengeToken: body.challengeToken,
    code: body.code.trim(),
  };
}

function invalidMfaChallengeResponse() {
  return NextResponse.json(
    {
      success: false,
      error: INVALID_MFA_CHALLENGE_ERROR,
    },
    { status: 401 }
  );
}

export async function POST(request: Request) {
  let body: VerifyMfaChallengeRequestBody;

  try {
    body = await request.json();
  } catch {
    return invalidMfaChallengeResponse();
  }

  const input = getChallengeInput(body);

  if (!input) {
    return invalidMfaChallengeResponse();
  }

  try {
    const result = await verifyMfaChallenge({
      input,
      metadata: getRequestMetadata(request),
    });

    if (!result.success) {
      return invalidMfaChallengeResponse();
    }

    return NextResponse.json(result);
  } catch {
    return invalidMfaChallengeResponse();
  }
}
