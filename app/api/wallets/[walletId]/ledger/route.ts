import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  isManualAdjustmentTransactionType,
  validateCreateLedgerEntryInput,
} from "@/src/domains/ledger/ledger.validation";
import {
  LedgerBusinessRuleError,
  LedgerValidationError,
  listLedgerEntriesForWallet,
  postLedgerEntry,
} from "@/src/domains/ledger/ledger.entrypoints";
import type {
  LedgerDirection,
  LedgerTransactionType,
} from "@/src/domains/ledger/ledger.types";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ walletId: string }>;
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
  return typeof value === "string" ? value : "";
}

function getNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return Number.NaN;
}

function getMetadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function GET(request: Request, { params }: RouteParams) {
  const { walletId } = await params;

  try {
    await requirePermission(request, "ledger.view");
    const ledgerEntries = await listLedgerEntriesForWallet(walletId);

    return NextResponse.json({
      success: true,
      ledgerEntries,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load ledger entries.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const { walletId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid ledger payload."]);
  }

  const payload = body as Record<string, unknown>;
  const transactionType = getString(
    payload.transactionType ?? payload.transaction_type
  ).toUpperCase() as LedgerTransactionType;
  const direction = getString(payload.direction).toUpperCase() as LedgerDirection;
  const input = {
    walletId,
    transactionType,
    direction,
    amount: getNumber(payload.amount),
    reference: {
      referenceType:
        getString(payload.referenceType ?? payload.reference_type) || null,
      referenceId: getString(payload.referenceId ?? payload.reference_id) || null,
    },
    idempotencyKey:
      getString(payload.idempotencyKey ?? payload.idempotency_key) || null,
    metadata: getMetadata(payload.metadata),
  };
  const validation = validateCreateLedgerEntryInput(input);

  if (!validation.valid) {
    return validationErrorResponse(validation.errors);
  }

  if (!isManualAdjustmentTransactionType(input.transactionType)) {
    return validationErrorResponse([
      "Only manual adjustment transaction types are allowed.",
    ]);
  }

  try {
    await requirePermission(request, "ledger.post_adjustment");
    const ledgerEntry = await postLedgerEntry(input);

    return NextResponse.json({
      success: true,
      ledgerEntry,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof LedgerValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof LedgerBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to post ledger entry.",
      },
      { status: 500 }
    );
  }
}
