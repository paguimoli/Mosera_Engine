import type { Market } from "./market.types";
import {
  getDefaultMarket as getDefaultMarketRecord,
  listMarkets as listMarketRecords,
} from "./market.repository";

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

export async function listMarkets(): Promise<Market[]> {
  return listMarketRecords();
}

export async function getDefaultMarket(): Promise<Market | null> {
  return getDefaultMarketRecord();
}
