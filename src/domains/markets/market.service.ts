import type { Market } from "./market.types";

export function hasDuplicateMarketCode(
  markets: Market[],
  code: string,
  editingMarketId?: string | null
) {
  return markets.some(
    (market) =>
      market.id !== editingMarketId &&
      market.code.trim().toLowerCase() === code.trim().toLowerCase()
  );
}
