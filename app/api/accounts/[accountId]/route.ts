import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { findAccountById } from "@/src/domains/accounts/account.repository";
import {
  AccountBusinessRuleError,
  AccountValidationError,
  disableAccount,
  DuplicateAccountCodeError,
  updateAccount,
} from "@/src/domains/accounts/account.service";
import type {
  AccountBalanceAuthority,
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  PersistedAccountStatus,
  PersistedAccountType,
  UpdateAccountInput,
} from "@/src/domains/accounts/account.types";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ accountId: string }>;
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

function getAccountType(value: unknown): PersistedAccountType | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as PersistedAccountType)
    : undefined;
}

function getAccountStatus(value: unknown): PersistedAccountStatus | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as PersistedAccountStatus)
    : undefined;
}

function getFundingModel(value: unknown): AccountFundingModel | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as AccountFundingModel)
    : undefined;
}

function getOperatingMode(value: unknown): AccountOperatingMode | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as AccountOperatingMode)
    : undefined;
}

function getBalanceAuthority(value: unknown): AccountBalanceAuthority | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as AccountBalanceAuthority)
    : undefined;
}

function getDefaultFundingSource(
  value: unknown
): AccountDefaultFundingSource | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as AccountDefaultFundingSource)
    : undefined;
}

function getWeeklyAccountingMode(
  value: unknown
): AccountWeeklyAccountingMode | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as AccountWeeklyAccountingMode)
    : undefined;
}

function getSettlementMode(value: unknown): AccountSettlementMode | undefined {
  return typeof value === "string"
    ? (value.toUpperCase() as AccountSettlementMode)
    : undefined;
}

function getUpdateAccountInput(
  body: Record<string, unknown>
): UpdateAccountInput {
  return {
    ...(body.accountType !== undefined || body.account_type !== undefined
      ? { accountType: getAccountType(body.accountType ?? body.account_type) }
      : {}),
    ...(body.accountCode !== undefined || body.account_code !== undefined
      ? { accountCode: getString(body.accountCode ?? body.account_code) ?? "" }
      : {}),
    ...(body.displayName !== undefined || body.display_name !== undefined
      ? { displayName: getString(body.displayName ?? body.display_name) ?? "" }
      : {}),
    ...(body.parentAccountId !== undefined || body.parent_account_id !== undefined
      ? {
          parentAccountId:
            getString(body.parentAccountId ?? body.parent_account_id) || null,
        }
      : {}),
    ...(body.marketId !== undefined || body.market_id !== undefined
      ? { marketId: getString(body.marketId ?? body.market_id) ?? "" }
      : {}),
    ...(body.brandId !== undefined || body.brand_id !== undefined
      ? { brandId: getString(body.brandId ?? body.brand_id) ?? "" }
      : {}),
    ...(body.status !== undefined
      ? { status: getAccountStatus(body.status) }
      : {}),
    ...(body.fundingModel !== undefined || body.funding_model !== undefined
      ? { fundingModel: getFundingModel(body.fundingModel ?? body.funding_model) }
      : {}),
    ...(body.operatingMode !== undefined || body.operating_mode !== undefined
      ? {
          operatingMode: getOperatingMode(
            body.operatingMode ?? body.operating_mode
          ),
        }
      : {}),
    ...(body.balanceAuthority !== undefined || body.balance_authority !== undefined
      ? {
          balanceAuthority: getBalanceAuthority(
            body.balanceAuthority ?? body.balance_authority
          ),
        }
      : {}),
    ...(body.defaultFundingSource !== undefined ||
    body.default_funding_source !== undefined
      ? {
          defaultFundingSource: getDefaultFundingSource(
            body.defaultFundingSource ?? body.default_funding_source
          ),
        }
      : {}),
    ...(body.weeklyAccountingMode !== undefined ||
    body.weekly_accounting_mode !== undefined
      ? {
          weeklyAccountingMode: getWeeklyAccountingMode(
            body.weeklyAccountingMode ?? body.weekly_accounting_mode
          ),
        }
      : {}),
    ...(body.settlementMode !== undefined || body.settlement_mode !== undefined
      ? {
          settlementMode: getSettlementMode(
            body.settlementMode ?? body.settlement_mode
          ),
        }
      : {}),
  };
}

export async function GET(request: Request, { params }: RouteParams) {
  const { accountId } = await params;

  try {
    await requirePermission(request, "accounts.view");
    const account = await findAccountById(accountId);

    if (!account) {
      return NextResponse.json(
        {
          success: false,
          error: "Account not found.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      account,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load account.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { accountId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid account payload."]);
  }

  const input = getUpdateAccountInput(body as Record<string, unknown>);

  try {
    await requirePermission(
      request,
      input.status === "DISABLED" ? "accounts.disable" : "accounts.edit"
    );
    const account =
      input.status === "DISABLED"
        ? await disableAccount(accountId)
        : await updateAccount(accountId, input);

    return NextResponse.json({
      success: true,
      account,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof AccountValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof DuplicateAccountCodeError) {
      return NextResponse.json(
        {
          success: false,
          error: "Duplicate account code.",
        },
        { status: 409 }
      );
    }

    if (error instanceof AccountBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to update account.",
      },
      { status: 500 }
    );
  }
}
