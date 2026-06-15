import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  createPlayerProfile,
  DuplicatePlayerProfileError,
  listPlayerProfiles,
  PlayerProfileBusinessRuleError,
  PlayerProfileValidationError,
} from "@/src/domains/players/player-profile.service";
import type {
  CreatePlayerProfileInput,
  PlayerProfileStatus,
} from "@/src/domains/players/player-profile.types";

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

function getProfileStatus(value: unknown): PlayerProfileStatus {
  return typeof value === "string"
    ? (value.toUpperCase() as PlayerProfileStatus)
    : ("" as PlayerProfileStatus);
}

function getCreatePlayerProfileInput(
  body: Record<string, unknown>
): CreatePlayerProfileInput {
  return {
    accountId: getString(body.accountId ?? body.account_id),
    firstName: getString(body.firstName ?? body.first_name) || null,
    lastName: getString(body.lastName ?? body.last_name) || null,
    displayName: getString(body.displayName ?? body.display_name),
    email: getString(body.email) || null,
    phone: getString(body.phone) || null,
    dateOfBirth: getString(body.dateOfBirth ?? body.date_of_birth) || null,
    externalPlayerId:
      getString(body.externalPlayerId ?? body.external_player_id) || null,
    externalPlatform:
      getString(body.externalPlatform ?? body.external_platform) || null,
    status: body.status === undefined ? "ACTIVE" : getProfileStatus(body.status),
  };
}

export async function GET(request: Request) {
  try {
    await requirePermission(request, "players.view");
    const playerProfiles = await listPlayerProfiles();

    return NextResponse.json({
      success: true,
      playerProfiles,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load player profiles.",
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
    return validationErrorResponse(["Invalid player profile payload."]);
  }

  try {
    await requirePermission(request, "players.create");
    const playerProfile = await createPlayerProfile(
      getCreatePlayerProfileInput(body as Record<string, unknown>)
    );

    return NextResponse.json({
      success: true,
      playerProfile,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    if (error instanceof PlayerProfileValidationError) {
      return validationErrorResponse(error.errors);
    }

    if (error instanceof DuplicatePlayerProfileError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 409 }
      );
    }

    if (error instanceof PlayerProfileBusinessRuleError) {
      return validationErrorResponse([error.message]);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to create player profile.",
      },
      { status: 500 }
    );
  }
}
