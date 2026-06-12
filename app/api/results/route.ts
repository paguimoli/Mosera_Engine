import { NextResponse } from "next/server";

import { supabase } from "@/app/lib/supabaseClient";

type ResultRequestBody = {
  organizationExternalId?: string;
  drawingExternalId?: string;
  winningNumbers?: string;
  winningBonus?: string | null;
  resultSource?: string;
  sourceReference?: string;
};

function isMissingString(value: unknown) {
  return typeof value !== "string" || value.trim() === "";
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ accepted: false, error: message }, { status });
}

export async function POST(request: Request) {
  let body: ResultRequestBody;

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (isMissingString(body.organizationExternalId)) {
    return jsonError("organizationExternalId is required.", 400);
  }

  if (isMissingString(body.drawingExternalId)) {
    return jsonError("drawingExternalId is required.", 400);
  }

  if (isMissingString(body.winningNumbers)) {
    return jsonError("winningNumbers is required.", 400);
  }

  const organizationExternalId = body.organizationExternalId.trim();
  const drawingExternalId = body.drawingExternalId.trim();
  const winningNumbers = body.winningNumbers.trim();

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id")
    .eq("external_organization_id", organizationExternalId)
    .maybeSingle();

  if (organizationError) {
    console.error("Result post organization lookup failed:", organizationError);
    return jsonError("Organization lookup failed.", 500);
  }

  if (!organization) {
    return jsonError("Organization not found.", 404);
  }

  const { data: drawing, error: drawingError } = await supabase
    .from("normalized_drawings")
    .select("id, game_id")
    .eq("external_id", drawingExternalId)
    .maybeSingle();

  if (drawingError) {
    console.error("Result post drawing lookup failed:", drawingError);
    return jsonError("Drawing lookup failed.", 500);
  }

  if (!drawing) {
    return jsonError("Drawing not found.", 404);
  }

  let gameFamily: string | null = null;

  if (drawing.game_id) {
    const { data: game, error: gameError } = await supabase
      .from("normalized_games")
      .select("game_family")
      .eq("id", drawing.game_id)
      .maybeSingle();

    if (gameError) {
      console.error("Result post game lookup failed:", gameError);
    } else {
      gameFamily = game?.game_family || null;
    }
  }

  const { data: existingResult, error: existingResultError } = await supabase
    .from("drawing_results")
    .select("id")
    .eq("drawing_id", drawing.id)
    .eq("status", "posted")
    .maybeSingle();

  if (existingResultError) {
    console.error("Result post duplicate lookup failed:", existingResultError);
    return jsonError("Drawing result lookup failed.", 500);
  }

  if (existingResult) {
    return NextResponse.json(
      {
        accepted: false,
        error: "Official result already posted for drawing.",
      },
      { status: 400 }
    );
  }

  const { data: insertedResult, error: insertError } = await supabase
    .from("drawing_results")
    .insert({
      organization_id: organization.id,
      drawing_id: drawing.id,
	      winning_numbers: winningNumbers,
	      winning_bonus: body.winningBonus ?? null,
	      bullseye_number: body.winningBonus ?? null,
	      result_source: body.resultSource || null,
      source_reference: body.sourceReference || null,
      status: "posted",
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Result post insert failed:", insertError);
    return jsonError("Drawing result insert failed.", 500);
  }

  // TODO Phase 5.7 integration: persist RESULT_POSTED audit event through
  // the audit repository/service once backend audit storage is available.

  if (gameFamily === "keno_style") {
    const { error: metricsError } = await supabase.rpc(
      "generate_keno_draw_metrics",
      {
        p_drawing_id: drawing.id,
        p_winning_numbers: winningNumbers,
      }
    );

    if (metricsError) {
      console.error("Keno draw metrics generation failed:", metricsError);
    }
  }

  const { error: updateError } = await supabase
    .from("normalized_drawings")
    .update({ status: "results_posted" })
    .eq("id", drawing.id);

  if (updateError) {
    console.error("Result post drawing status update failed:", updateError);
    return jsonError("Drawing status update failed.", 500);
  }

  return NextResponse.json({
    accepted: true,
    message: "Official result posted",
    drawingId: drawing.id,
    resultId: insertedResult.id,
  });
}
