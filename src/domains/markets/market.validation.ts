import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { Market } from "./market.types";
import { hasDuplicateMarketCode } from "./market.service";

export function validateMarketForm({
  form,
  markets,
  editingMarketId,
}: {
  form: {
    name: string;
    code: string;
    language: string;
    currency: string;
    timeZone: string;
  };
  markets: Market[];
  editingMarketId?: string | null;
}) {
  const name = form.name.trim();
  const code = form.code.trim().toUpperCase();
  const language = form.language.trim();
  const currency = form.currency.trim().toUpperCase();
  const timeZone = form.timeZone.trim();

  if (!name || !code || !language || !currency || !timeZone) {
    return invalid("Please enter market name, code, language, currency, and time zone.");
  }

  if (hasDuplicateMarketCode(markets, code, editingMarketId)) {
    return invalid("A market with this code already exists.");
  }

  return valid();
}
