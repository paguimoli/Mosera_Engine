import { NextResponse } from "next/server";

import { supabase } from "@/app/lib/supabaseClient";

type TicketLeg = {
  betType?: string;
  numbers?: string;
  amount?: number;
  stakeMode?: string;
};

type TicketRequestBody = {
  organizationExternalId?: string;
  playerExternalId?: string;
  drawingExternalId?: string;
  externalTicketId?: string;
  sourceType?: string;
  currency?: string;
  legs?: TicketLeg[];
};

function isMissingString(value: unknown) {
  return typeof value !== "string" || value.trim() === "";
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ accepted: false, error: message }, { status });
}

export async function POST(request: Request) {
  let body: TicketRequestBody;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (isMissingString(body.organizationExternalId)) {
    return jsonError("organizationExternalId is required.", 400);
  }

  if (isMissingString(body.playerExternalId)) {
    return jsonError("playerExternalId is required.", 400);
  }

  if (isMissingString(body.drawingExternalId)) {
    return jsonError("drawingExternalId is required.", 400);
  }

  if (isMissingString(body.externalTicketId)) {
    return jsonError("externalTicketId is required.", 400);
  }

  if (!Array.isArray(body.legs) || body.legs.length === 0) {
    return jsonError("legs array is required.", 400);
  }

  const organizationExternalId = body.organizationExternalId.trim();
  const playerExternalId = body.playerExternalId.trim();
  const drawingExternalId = body.drawingExternalId.trim();
  const externalTicketId = body.externalTicketId.trim();

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id")
    .eq("external_organization_id", organizationExternalId)
    .maybeSingle();

  if (organizationError) {
    console.error("Ticket intake organization lookup failed:", organizationError);
    return jsonError("Organization lookup failed.", 500);
  }

  if (!organization) {
    return jsonError("Organization not found.", 404);
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("id")
    .eq("organization_id", organization.id)
    .eq("external_player_id", playerExternalId)
    .maybeSingle();

  if (playerError) {
    console.error("Ticket intake player lookup failed:", playerError);
    return jsonError("Player lookup failed.", 500);
  }

  if (!player) {
    return jsonError("Player not found.", 404);
  }

  const { data: drawing, error: drawingError } = await supabase
    .from("normalized_drawings")
    .select("id")
    .eq("external_id", drawingExternalId)
    .maybeSingle();

  if (drawingError) {
    console.error("Ticket intake drawing lookup failed:", drawingError);
    return jsonError("Drawing lookup failed.", 500);
  }

  if (!drawing) {
    return NextResponse.json(
      {
        accepted: false,
        error: "Drawing not found.",
        drawingExternalId,
        supabaseErrorMessage: drawingError?.message || null,
        debugMessage: "Check normalized_drawings.external_id",
      },
      { status: 404 }
    );
  }

  const { data: existingTicket, error: existingTicketError } = await supabase
    .from("tickets")
    .select("id")
    .eq("organization_id", organization.id)
    .eq("external_ticket_id", externalTicketId)
    .maybeSingle();

  if (existingTicketError) {
    console.error(
      "Ticket intake idempotency lookup failed:",
      existingTicketError
    );
    return jsonError("Ticket idempotency lookup failed.", 500);
  }

  if (existingTicket) {
    return NextResponse.json({
      accepted: true,
      duplicate: true,
      ticketId: existingTicket.id,
      externalTicketId,
    });
  }

  const legs = body.legs;
  const totalAmount = legs.reduce(
    (sum, leg) => sum + Number(leg.amount || 0),
    0
  );
  const sourceType = body.sourceType || "api";
  const currency = body.currency || "USD";

  const { data: rpcPayload, error: rpcError } = await supabase.rpc(
    "place_ticket_with_wallet_debit",
    {
      p_organization_id: organization.id,
      p_player_id: player.id,
      p_drawing_id: drawing.id,
      p_external_ticket_id: externalTicketId,
      p_source_type: sourceType || "api",
      p_currency: currency || "USD",
      p_total_amount: totalAmount,
      p_legs: legs,
    }
  );

  if (rpcError) {
    console.error("Ticket intake RPC failed:", rpcError);
    return jsonError("Ticket RPC failed.", 500);
  }

  if (rpcPayload?.accepted === false) {
    return NextResponse.json(rpcPayload, { status: 400 });
  }

  return NextResponse.json(rpcPayload);
}
