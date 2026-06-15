import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  ensureOpenWeeklyPeriodForMarketBrand,
  listWeeklyAccountingPeriods,
  WeeklyAccountingBusinessRuleError,
} from "@/src/domains/weekly-accounting/weekly-accounting.service";

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

async function requirePeriodCreatePermission(request: Request) {
  try {
    return await requirePermission(request, "settings.edit");
  } catch (error) {
    if (error instanceof AuthMiddlewareError && error.status === 403) {
      return requirePermission(request, "ledger.post_adjustment");
    }

    throw error;
  }
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "reports.view");
    const periods = await listWeeklyAccountingPeriods();

    return NextResponse.json({
      success: true,
      periods,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load weekly accounting periods.",
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
    return validationErrorResponse(["Invalid weekly period payload."]);
  }

  const payload = body as Record<string, unknown>;
  const marketId = getString(payload.marketId ?? payload.market_id);
  const brandId = getString(payload.brandId ?? payload.brand_id);

  if (!marketId || !brandId) {
    return validationErrorResponse(["Market id and brand id are required."]);
  }

  try {
    await requirePeriodCreatePermission(request);
    const period = await ensureOpenWeeklyPeriodForMarketBrand(marketId, brandId);

    return NextResponse.json({
      success: true,
      period,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof WeeklyAccountingBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to create weekly accounting period.",
      },
      { status: 500 }
    );
  }
}
