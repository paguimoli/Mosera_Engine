import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  BrandBusinessRuleError,
  BrandValidationError,
  disableBrand,
  DuplicateBrandCodeError,
  updateBrand,
} from "@/src/domains/brands/brand.service";
import type { UpdateBrandInput } from "@/src/domains/brands/brand.types";

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

function validationErrorResponse(errors: string[]) {
  return NextResponse.json(
    {
      success: false,
      errors,
    },
    { status: 400 }
  );
}

function getString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function getBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function getBrandStatus(value: unknown): UpdateBrandInput["status"] {
  return typeof value === "string"
    ? (value as UpdateBrandInput["status"])
    : undefined;
}

function getUpdateBrandInput(body: Record<string, unknown>): UpdateBrandInput {
  return {
    ...(body.code !== undefined ? { code: getString(body.code) ?? "" } : {}),
    ...(body.name !== undefined ? { name: getString(body.name) ?? "" } : {}),
    ...(body.displayName !== undefined || body.display_name !== undefined
      ? { displayName: getString(body.displayName ?? body.display_name) ?? "" }
      : {}),
    ...(body.status !== undefined ? { status: getBrandStatus(body.status) } : {}),
    ...(body.isDefault !== undefined || body.is_default !== undefined
      ? { isDefault: getBoolean(body.isDefault ?? body.is_default) ?? false }
      : {}),
  };
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { brandId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid brand payload."]);
  }

  const input = getUpdateBrandInput(body as Record<string, unknown>);

  try {
    await requirePermission(request, "settings.edit");
    const brand =
      input.status === "DISABLED"
        ? await disableBrand(brandId)
        : await updateBrand(brandId, input);

    return NextResponse.json({
      success: true,
      brand,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof BrandValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof DuplicateBrandCodeError) {
      return NextResponse.json(
        {
          success: false,
          error: "Duplicate brand code.",
        },
        { status: 409 }
      );
    }

    if (error instanceof BrandBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to update brand.",
      },
      { status: 500 }
    );
  }
}
