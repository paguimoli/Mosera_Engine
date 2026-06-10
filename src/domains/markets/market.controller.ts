import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import {
  deleteMarket,
  findMarketById,
  saveMarket,
  updateMarket,
} from "./market.repository";
import type { Market } from "./market.types";
import { validateMarketForm } from "./market.validation";

export function saveMarketController({
  form,
  markets,
  editingMarketId,
}: {
  form: Omit<Market, "id" | "createdAt">;
  markets: Market[];
  editingMarketId?: string | null;
}) {
  const validation = validateMarketForm({ form, markets, editingMarketId });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const existingMarket = editingMarketId
    ? findMarketById(markets, editingMarketId)
    : undefined;
  const market: Market = {
    id: existingMarket?.id || `MARKET-${Date.now()}`,
    name: form.name.trim(),
    code: form.code.trim().toUpperCase(),
    language: form.language.trim(),
    currency: form.currency.trim().toUpperCase(),
    timeZone: form.timeZone.trim(),
    dateFormat: form.dateFormat.trim(),
    numberFormat: form.numberFormat.trim(),
    defaultBrand: form.defaultBrand.trim() || "Default",
    active: form.active,
    createdAt: existingMarket?.createdAt || new Date().toISOString(),
  };

  return controllerSuccess({
    market,
    markets: editingMarketId
      ? updateMarket(markets, market)
      : saveMarket(markets, market),
  });
}

export function deleteMarketController({
  marketId,
  markets,
}: {
  marketId: string;
  markets: Market[];
}) {
  return controllerSuccess({
    markets: deleteMarket(markets, marketId),
  });
}

export function addDefaultMarketsController(markets: Market[]) {
  const defaults: Array<Omit<Market, "id" | "active" | "createdAt">> = [
    {
      name: "Costa Rica",
      code: "CR",
      language: "es",
      currency: "USD",
      timeZone: "America/Costa_Rica",
      dateFormat: "DD/MM/YYYY",
      numberFormat: "es-CR",
      defaultBrand: "Default",
    },
    {
      name: "English International",
      code: "EN-INT",
      language: "en",
      currency: "USD",
      timeZone: "America/New_York",
      dateFormat: "MM/DD/YYYY",
      numberFormat: "en-US",
      defaultBrand: "Default",
    },
    {
      name: "Spanish International",
      code: "ES-INT",
      language: "es",
      currency: "USD",
      timeZone: "America/Panama",
      dateFormat: "DD/MM/YYYY",
      numberFormat: "es-419",
      defaultBrand: "Default",
    },
    {
      name: "Vietnam",
      code: "VN",
      language: "vi",
      currency: "VND",
      timeZone: "Asia/Ho_Chi_Minh",
      dateFormat: "DD/MM/YYYY",
      numberFormat: "vi-VN",
      defaultBrand: "Default",
    },
  ];
  const existingCodes = new Set(
    markets.map((market) => market.code.trim().toUpperCase())
  );
  const createdAt = new Date().toISOString();
  const idSeed = Date.now();
  const newMarkets = defaults
    .filter((market) => !existingCodes.has(market.code))
    .map((market, index) => ({
      id: `MARKET-${idSeed}-${index}`,
      active: true,
      createdAt,
      ...market,
    }));

  if (newMarkets.length === 0) {
    return controllerFailure("Default markets already exist.");
  }

  return controllerSuccess({
    newMarkets,
    markets: newMarkets.reduce(
      (nextMarkets, market) => saveMarket(nextMarkets, market),
      markets
    ),
  });
}
