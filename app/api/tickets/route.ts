import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";
import {
  assertAccountScope,
} from "@/src/domains/accounts/account-scope-governance";
import { findAccountById } from "@/src/domains/accounts/account.repository";
import {
  acceptCanonicalTicket,
  CanonicalTicketRepositoryError,
  listCanonicalTickets,
} from "@/src/domains/tickets/canonical-ticket.repository";
import {
  canAccessTicketScope,
} from "@/src/domains/tickets/canonical-ticket.authorization";
import type {
  AcceptCanonicalTicketInput,
  CanonicalTicketItemInput,
} from "@/src/domains/tickets/canonical-ticket.types";
import { getOrCreateCorrelationId } from "@/src/lib/observability/correlation";

export const runtime = "nodejs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(error: unknown) {
  if (error instanceof AuthMiddlewareError) {
    return NextResponse.json({ accepted: false, error: error.message }, { status: error.status });
  }
  if (error instanceof CanonicalTicketRepositoryError) {
    const message = error.message;
    const status =
      error.code === "22P02" ||
      message.includes("required") ||
      message.includes("invalid") ||
      message.includes("unavailable") ||
      message.includes("does not") ||
      message.includes("cutoff") ||
      message.includes("mismatch")
        ? 400
        : message.includes("conflict")
          ? 409
          : 500;
    return NextResponse.json({ accepted: false, error: message }, { status });
  }
  return NextResponse.json(
    { accepted: false, error: "Canonical Ticket operation failed." },
    { status: 500 }
  );
}

function requiredUuid(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CanonicalTicketRepositoryError(`${name} is required and must be a UUID.`);
  }
  return value;
}

function optionalUuid(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CanonicalTicketRepositoryError(`${name} must be a UUID when provided.`);
  }
  return value;
}

function parseItems(value: unknown): CanonicalTicketItemInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CanonicalTicketRepositoryError("items must contain at least one wager.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CanonicalTicketRepositoryError(`items[${index}] is invalid.`);
    }
    const input = item as Record<string, unknown>;
    if (
      typeof input.wagerType !== "string" ||
      input.wagerType.trim() === "" ||
      typeof input.wagerVersion !== "string" ||
      input.wagerVersion.trim() === "" ||
      !Number.isSafeInteger(input.stakeMinor) ||
      Number(input.stakeMinor) <= 0 ||
      (!Array.isArray(input.selections) &&
        (!input.selections ||
          typeof input.selections !== "object"))
    ) {
      throw new CanonicalTicketRepositoryError(`items[${index}] is invalid.`);
    }
    return {
      wagerType: input.wagerType.trim(),
      wagerVersion: input.wagerVersion.trim(),
      selections: input.selections as unknown[] | Record<string, unknown>,
      stakeMinor: Number(input.stakeMinor),
    };
  });
}

export async function GET(request: Request) {
  try {
    const context = await requirePermission(request, "tickets.read");
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
    const tickets = await listCanonicalTickets(
      Number.isSafeInteger(requestedLimit) ? requestedLimit : 100
    );
    return NextResponse.json({
      tickets: tickets.filter((ticket) => canAccessTicketScope(context, ticket)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission(request, "tickets.create");
    const body = (await request.json()) as Record<string, unknown>;

    if (
      "organizationExternalId" in body ||
      "playerExternalId" in body ||
      "drawingExternalId" in body ||
      "legs" in body
    ) {
      return NextResponse.json(
        {
          accepted: false,
          error: "Legacy external-ID ticket intake is retired.",
          canonicalContract: "playerAccountId/playerProfileId/gameAvailabilityId/productId/manifestId/paytableDefinitionId/drawId/items",
        },
        { status: 410 }
      );
    }

    const playerAccountId = requiredUuid(body, "playerAccountId");
    const playerAccount = await findAccountById(playerAccountId);
    if (!playerAccount || playerAccount.accountType !== "PLAYER") {
      return NextResponse.json(
        { accepted: false, error: "Governed player account not found." },
        { status: 404 }
      );
    }
    assertAccountScope(context, playerAccount);

    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      throw new CanonicalTicketRepositoryError("Idempotency-Key header is required.");
    }
    const currency =
      typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new CanonicalTicketRepositoryError("currency must be a three-letter code.");
    }

    const input: AcceptCanonicalTicketInput = {
      playerAccountId,
      playerProfileId: requiredUuid(body, "playerProfileId"),
      walletId: requiredUuid(body, "walletId"),
      gameAvailabilityId: requiredUuid(body, "gameAvailabilityId"),
      productId: requiredUuid(body, "productId"),
      manifestId: requiredUuid(body, "manifestId"),
      paytableDefinitionId: requiredUuid(body, "paytableDefinitionId"),
      drawId: requiredUuid(body, "drawId"),
      websiteId: optionalUuid(body, "websiteId"),
      domainId: optionalUuid(body, "domainId"),
      externalTicketId:
        typeof body.externalTicketId === "string"
          ? body.externalTicketId.trim() || null
          : null,
      currency,
      items: parseItems(body.items),
      idempotencyKey,
      correlationId: getOrCreateCorrelationId(request),
      causationId:
        typeof body.causationId === "string" ? body.causationId.trim() || null : null,
      actorReference: context.user.id,
      salesChannel:
        typeof body.salesChannel === "string"
          ? body.salesChannel.trim() || "API"
          : "API",
    };

    const result = await acceptCanonicalTicket(input);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
