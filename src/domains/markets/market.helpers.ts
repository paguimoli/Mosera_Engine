import type { Market } from "./market.types";

export function findMarketById(markets: Market[], marketId: string) {
  return markets.find((market) => market.id === marketId);
}

export function saveMarket(markets: Market[], market: Market) {
  return [...markets, market];
}

export function updateMarket(markets: Market[], market: Market) {
  return markets.map((createdMarket) =>
    createdMarket.id === market.id ? market : createdMarket
  );
}

export function deleteMarket(markets: Market[], marketId: string) {
  return markets.filter((market) => market.id !== marketId);
}
