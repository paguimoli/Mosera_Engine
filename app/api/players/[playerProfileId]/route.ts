import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import { findPlayerProfileById } from "@/src/domains/players/player-profile.repository";
import {
  disablePlayerProfile,
  DuplicatePlayerProfileError,
  PlayerProfileBusinessRuleError,
  PlayerProfileValidationError,
  suspendPlayerProfile,
  updatePlayerProfile,
} from "@/src/domains/players/player-profile.service";
import type {
  PlayerProfileStatus,
  UpdatePlayerProfileInput,
} from "@/src/domains/players/player-profile.types";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ playerProfileId: string }>;
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

function getProfileStatus(value: unknown): PlayerProfileStatus {
  return typeof value === "string"
    ? (value.toUpperCase() as PlayerProfileStatus)
    : ("" as PlayerProfileStatus);
}

function getUpdatePlayerProfileInput(
  body: Record<string, unknown>
): UpdatePlayerProfileInput {
  return {
    ...(body.accountId !== undefined || body.account_id !== undefined
      ? { accountId: getString(body.accountId ?? body.account_id) ?? "" }
      : {}),
    ...(body.firstName !== undefined || body.first_name !== undefined
      ? { firstName: getString(body.firstName ?? body.first_name) ?? null }
      : {}),
    ...(body.lastName !== undefined || body.last_name !== undefined
      ? { lastName: getString(body.lastName ?? body.last_name) ?? null }
      : {}),
    ...(body.displayName !== undefined || body.display_name !== undefined
      ? { displayName: getString(body.displayName ?? body.display_name) ?? "" }
      : {}),
    ...(body.email !== undefined
      ? { email: getString(body.email) ?? null }
      : {}),
    ...(body.phone !== undefined
      ? { phone: getString(body.phone) ?? null }
      : {}),
    ...(body.dateOfBirth !== undefined || body.date_of_birth !== undefined
      ? {
          dateOfBirth:
            getString(body.dateOfBirth ?? body.date_of_birth) ?? null,
        }
      : {}),
    ...(body.externalPlayerId !== undefined ||
    body.external_player_id !== undefined
      ? {
          externalPlayerId:
            getString(body.externalPlayerId ?? body.external_player_id) ?? null,
        }
      : {}),
    ...(body.externalPlatform !== undefined ||
    body.external_platform !== undefined
      ? {
          externalPlatform:
            getString(body.externalPlatform ?? body.external_platform) ?? null,
        }
      : {}),
    ...(body.status !== undefined
      ? { status: getProfileStatus(body.status) }
      : {}),
  };
}

export async function GET(request: Request, { params }: RouteParams) {
  const { playerProfileId } = await params;

  try {
    await requirePermission(request, "players.view");
    const playerProfile = await findPlayerProfileById(playerProfileId);

    if (!playerProfile) {
      return NextResponse.json(
        {
          success: false,
          error: "Player profile not found.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      playerProfile,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Unable to load player profile.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { playerProfileId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return validationErrorResponse(["Invalid JSON body."]);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationErrorResponse(["Invalid player profile payload."]);
  }

  const input = getUpdatePlayerProfileInput(body as Record<string, unknown>);

  try {
    await requirePermission(
      request,
      input.status === "DISABLED" ? "players.disable" : "players.edit"
    );
    const playerProfile =
      input.status === "DISABLED"
        ? await disablePlayerProfile(playerProfileId)
        : input.status === "SUSPENDED"
          ? await suspendPlayerProfile(playerProfileId)
          : await updatePlayerProfile(playerProfileId, input);

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
        error: "Unable to update player profile.",
      },
      { status: 500 }
    );
  }
}
