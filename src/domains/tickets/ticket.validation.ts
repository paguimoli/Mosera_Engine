import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { DraftTicketLine } from "./ticket.service";

export function validateTicketLineForm(form: {
  wagerTypeId: string;
  stake: string;
  potentialPayout: string;
}) {
  const stake = Number(form.stake || 0);
  const potentialPayout = Number(form.potentialPayout || 0);

  if (!form.wagerTypeId) {
    return invalid("Please select a wager type.");
  }

  if (Number.isNaN(stake) || stake <= 0) {
    return invalid("Ticket line stake must be greater than 0.");
  }

  if (Number.isNaN(potentialPayout)) {
    return invalid("Potential payout must be numeric.");
  }

  return valid();
}

export function validateTicketForm({
  form,
  draftLines,
}: {
  form: {
    accountId: string;
    gameId: string;
    drawingId: string;
    fundingType: string;
  };
  draftLines: DraftTicketLine[];
}) {
  if (!form.accountId || !form.gameId || !form.drawingId || !form.fundingType) {
    return invalid("Please select account, game, drawing, and funding type.");
  }

  if (draftLines.length === 0) {
    return invalid("Please add at least one ticket line.");
  }

  return valid();
}
