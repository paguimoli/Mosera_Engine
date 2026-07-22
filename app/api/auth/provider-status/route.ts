import { NextResponse } from "next/server";

import { getAuthAuthority, getAuthProvider, getAuthServiceUrl } from "@/src/domains/auth/auth-provider";

export const runtime = "nodejs";

async function checkAuthService() {
  try {
    const response = await fetch(`${getAuthServiceUrl()}/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });

    return {
      configured: true,
      reachable: true,
      ready: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET() {
  const provider = getAuthProvider();

  return NextResponse.json({
    success: true,
    provider,
    authority: getAuthAuthority(),
    legacyFallbackAvailable: false,
    authService: await checkAuthService(),
    tokenIssuanceEnabled: provider === "auth-service",
    oauthRuntimeEnabled: false,
  });
}
