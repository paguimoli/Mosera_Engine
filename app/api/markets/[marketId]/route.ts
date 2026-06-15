import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  disableMarket,
  DuplicateMarketCodeError,
  MarketBusinessRuleError,
  MarketValidationError,
  updateMarket,
} from "@/src/domains/markets/market.service";
import type { UpdateMarketInput } from "@/src/domains/markets/market.types";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ marketId: string }>;
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

function getMarketStatus(value: unknown): UpdateMarketInput["status"] {
  return typeof value === "string"
    ? (value as UpdateMarketInput["status"])
    : undefined;
}

function getUpdateMarketInput(body: Record<string, unknown>): UpdateMarketInput {
  return {
    ...(body.code !== undefined ? { code: getString(body.code) ?? "" } : {}),
    ...(body.name !== undefined ? { name: getString(body.name) ?? "" } : {}),
    ...(body.currencyCode !== undefined || body.currency_code !== undefined
      ? { currencyCode: getString(body.currencyCode ?? body.currency_code) ?? "" }
      : {}),
    ...(body.languageCode !== undefined || body.language_code !== undefined
      ? { languageCode: getString(body.languageCode ?? body.language_code) ?? "" }
      : {}),
    ...(body.timezone !== undefined
      ? { timezone: getString(body.timezone) ?? "" }
      : {}),
    ...(body.brandCode !== undefined || body.brand_code !== undefined
      ? { brandCode: getString(body.brandCode ?? body.brand_code) ?? "" }
      : {}),
    ...(body.status !== undefined
      ? { status: getMarketStatus(body.status) }
      : {}),
    ...(body.isDefault !== undefined || body.is_default !== undefined
      ? { isDefault: getBoolean(body.isDefault ?? body.is_default) ?? false }
      : {}),
  };
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { marketId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid market payload."]);
  }

  const input = getUpdateMarketInput(body as Record<string, unknown>);
  const permission =
    input.status === "DISABLED" ? "markets.disable" : "markets.edit";

  try {
    await requirePermission(request, permission);
    const market =
      input.status === "DISABLED"
        ? await disableMarket(marketId)
        : await updateMarket(marketId, input);

    return NextResponse.json({
      success: true,
      market,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof MarketValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof DuplicateMarketCodeError) {
      return NextResponse.json(
        {
          success: false,
          error: "Duplicate market code.",
        },
        { status: 409 }
      );
    }

    if (error instanceof MarketBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to update market.",
      },
      { status: 500 }
    );
  }
}
