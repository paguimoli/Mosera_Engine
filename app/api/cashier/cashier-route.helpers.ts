import { NextResponse } from "next/server";

import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";

export function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export function validationErrorResponse(errors: string[]) {
  return NextResponse.json(
    {
      success: false,
      errors,
    },
    { status: 400 }
  );
}

export async function readJsonObject(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return {
      payload: null,
      response: validationErrorResponse(["Invalid JSON body."]),
    };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      payload: null,
      response: validationErrorResponse(["Invalid cashier payload."]),
    };
  }

  return {
    payload: body as Record<string, unknown>,
    response: null,
  };
}

export async function readOptionalJsonObject(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return {
      payload: {},
      response: null,
    };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      payload: null,
      response: validationErrorResponse(["Invalid cashier payload."]),
    };
  }

  return {
    payload: body as Record<string, unknown>,
    response: null,
  };
}

export function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function getNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return Number.NaN;
}

export function getMetadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
