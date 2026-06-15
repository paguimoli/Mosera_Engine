import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  AccountValidationError,
  createAccount,
  DuplicateAccountCodeError,
  AccountBusinessRuleError,
  listAccounts,
} from "@/src/domains/accounts/account.service";
import type {
  AccountBalanceAuthority,
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  CreateAccountInput,
  PersistedAccountStatus,
  PersistedAccountType,
} from "@/src/domains/accounts/account.types";

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

function getAccountType(value: unknown): PersistedAccountType {
  return getString(value).toUpperCase() as PersistedAccountType;
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

function getCreateAccountInput(
  body: Record<string, unknown>
): CreateAccountInput {
  return {
    accountType: getAccountType(body.accountType ?? body.account_type),
    accountCode: getString(body.accountCode ?? body.account_code),
    displayName: getString(body.displayName ?? body.display_name),
    parentAccountId:
      getString(body.parentAccountId ?? body.parent_account_id) || null,
    marketId: getString(body.marketId ?? body.market_id),
    brandId: getString(body.brandId ?? body.brand_id),
    status: getAccountStatus(body.status) ?? "ACTIVE",
    fundingModel: getFundingModel(body.fundingModel ?? body.funding_model),
    operatingMode: getOperatingMode(body.operatingMode ?? body.operating_mode),
    balanceAuthority: getBalanceAuthority(
      body.balanceAuthority ?? body.balance_authority
    ),
    defaultFundingSource: getDefaultFundingSource(
      body.defaultFundingSource ?? body.default_funding_source
    ),
    weeklyAccountingMode: getWeeklyAccountingMode(
      body.weeklyAccountingMode ?? body.weekly_accounting_mode
    ),
    settlementMode: getSettlementMode(
      body.settlementMode ?? body.settlement_mode
    ),
  };
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "accounts.view");
    const accounts = await listAccounts();

    return NextResponse.json({
      success: true,
      accounts,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load accounts.",
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
    return validationErrorResponse(["Invalid account payload."]);
  }

  try {
    await requirePermission(request, "accounts.create");
    const account = await createAccount(
      getCreateAccountInput(body as Record<string, unknown>)
    );

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
        error: "Unable to create account.",
      },
      { status: 500 }
    );
  }
}
