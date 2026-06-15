import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  createMarket,
  DuplicateMarketCodeError,
  listMarkets,
  MarketValidationError,
} from "@/src/domains/markets/market.service";
import type { CreateMarketInput } from "@/src/domains/markets/market.types";

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

function getMarketStatus(value: unknown): CreateMarketInput["status"] {
  return typeof value === "string"
    ? (value as CreateMarketInput["status"])
    : undefined;
}

function getCreateMarketInput(body: Record<string, unknown>): CreateMarketInput {
  return {
    code: getString(body.code),
    name: getString(body.name),
    currencyCode: getString(body.currencyCode ?? body.currency_code),
    languageCode: getString(body.languageCode ?? body.language_code),
    timezone: getString(body.timezone),
    brandCode: getString(body.brandCode ?? body.brand_code),
    status: getMarketStatus(body.status) ?? "ACTIVE",
    isDefault: getBoolean(body.isDefault ?? body.is_default),
  };
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "markets.view");
    const markets = await listMarkets();

    return NextResponse.json({
      success: true,
      markets,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load markets.",
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
    return validationErrorResponse(["Invalid market payload."]);
  }

  try {
    await requirePermission(request, "markets.create");
    const market = await createMarket(
      getCreateMarketInput(body as Record<string, unknown>)
    );

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

    return NextResponse.json(
      {
        success: false,
        error: "Unable to create market.",
      },
      { status: 500 }
    );
  }
}
