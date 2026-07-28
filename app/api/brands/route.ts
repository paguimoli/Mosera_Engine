import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  listBrands,
} from "@/src/domains/brands/brand.service";
import { legacyPlatformMutationGone } from "@/src/domains/platform-management/platform-mutation-authority";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "settings.view");
    const brands = await listBrands();

    return NextResponse.json({
      success: true,
      brands,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load brands.",
      },
      { status: 500 }
    );
  }
}

export async function POST() {
  return legacyPlatformMutationGone("brand");
}
