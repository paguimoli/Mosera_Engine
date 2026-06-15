import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  BrandValidationError,
  createBrand,
  DuplicateBrandCodeError,
  listBrands,
} from "@/src/domains/brands/brand.service";
import type { CreateBrandInput } from "@/src/domains/brands/brand.types";

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
  return typeof value === "string" ? value : "";
}

function getBoolean(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function getBrandStatus(value: unknown): CreateBrandInput["status"] {
  return typeof value === "string"
    ? (value as CreateBrandInput["status"])
    : undefined;
}

function getCreateBrandInput(body: Record<string, unknown>): CreateBrandInput {
  return {
    code: getString(body.code),
    name: getString(body.name),
    displayName: getString(body.displayName ?? body.display_name),
    status: getBrandStatus(body.status) ?? "ACTIVE",
    isDefault: getBoolean(body.isDefault ?? body.is_default),
  };
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

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid brand payload."]);
  }

  try {
    await requirePermission(request, "settings.edit");
    const brand = await createBrand(
      getCreateBrandInput(body as Record<string, unknown>)
    );

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

    return NextResponse.json(
      {
        success: false,
        error: "Unable to create brand.",
      },
      { status: 500 }
    );
  }
}
