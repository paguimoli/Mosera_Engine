import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountingValidationError,
  getWeeklyAccountingSnapshots,
} from "@/src/domains/accounting/accounting.service";
import { resolveScopedAccount } from "@/src/domains/accounts/account-scope-governance";
import {
  hasCanonicalGlobalScope,
  resolveCanonicalScope,
} from "@/src/domains/scope/canonical-scope-resolver";

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

export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const context = await requirePermission(request, "reports.view");
    const accountId = url.searchParams.get("accountId");
    if (accountId) {
      await resolveScopedAccount(context, accountId);
    } else if (!hasCanonicalGlobalScope(resolveCanonicalScope(context))) {
      throw new AuthMiddlewareError(
        403,
        "An authoritative account scope is required."
      );
    }
    const snapshots = await getWeeklyAccountingSnapshots({
      weekStart: url.searchParams.get("weekStart"),
      weekEnd: url.searchParams.get("weekEnd"),
      accountId,
      currency: url.searchParams.get("currency"),
    });

    return NextResponse.json({
      success: true,
      snapshots,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof AccountingValidationError) {
      return validationErrorResponse(error.errors);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load weekly accounting snapshots.",
      },
      { status: 500 }
    );
  }
}
