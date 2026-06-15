import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  BrandBusinessRuleError,
  setDefaultBrand,
} from "@/src/domains/brands/brand.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ brandId: string }>;
};

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export async function POST(request: Request, { params }: RouteParams) {
  const { brandId } = await params;

  try {
    await requirePermission(request, "settings.edit");
    const brand = await setDefaultBrand(brandId);

    return NextResponse.json({
      success: true,
      brand,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof BrandBusinessRuleError) {
      return NextResponse.json(
        {
          success: false,
          errors: [error.message],
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to set default brand.",
      },
      { status: 500 }
    );
  }
}
