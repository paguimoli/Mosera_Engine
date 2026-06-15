import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CreateMarketInput,
  Market,
  MarketStatus,
  UpdateMarketInput,
} from "./market.types";
import {
  normalizeCreateMarketInput,
  normalizeUpdateMarketInput,
} from "./market.validation";

type MarketRow = {
  id: string;
  code: string;
  name: string;
  currency_code: string;
  language_code: string;
  timezone: string;
  brand_code: string;
  status: MarketStatus;
  is_default: boolean;
  created_at: string;
  updated_at?: string | null;
};

export class MarketRepositoryError extends Error {
  constructor(message = "Market persistence operation failed.") {
    super(message);
    this.name = "MarketRepositoryError";
  }
}

function mapMarketRow(row: MarketRow | null): Market | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currencyCode: row.currency_code,
    languageCode: row.language_code,
    timezone: row.timezone,
    brandCode: row.brand_code,
    status: row.status,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,

    language: row.language_code,
    currency: row.currency_code,
    timeZone: row.timezone,
    dateFormat: row.language_code === "es" ? "DD/MM/YYYY" : "MM/DD/YYYY",
    numberFormat: row.language_code,
    defaultBrand: row.brand_code,
    active: row.status === "ACTIVE",
  };
}

const MARKET_SELECT =
  "id, code, name, currency_code, language_code, timezone, brand_code, status, is_default, created_at, updated_at";

export async function createMarket(input: CreateMarketInput): Promise<Market> {
  const normalized = normalizeCreateMarketInput(input);
  const { data, error } = await supabaseServerAdmin
    .from("markets")
    .insert({
      code: normalized.code,
      name: normalized.name,
      currency_code: normalized.currencyCode,
      language_code: normalized.languageCode,
      timezone: normalized.timezone,
      brand_code: normalized.brandCode,
      status: normalized.status ?? "ACTIVE",
      is_default: normalized.isDefault ?? false,
    })
    .select(MARKET_SELECT)
    .single();

  if (error) {
    throw new MarketRepositoryError();
  }

  const market = mapMarketRow(data as MarketRow | null);

  if (!market) {
    throw new MarketRepositoryError();
  }

  return market;
}

export function findMarketById(markets: Market[], marketId: string): Market | undefined;
export function findMarketById(id: string): Promise<Market | null>;
export function findMarketById(
  marketsOrId: Market[] | string,
  marketId?: string
): Market | undefined | Promise<Market | null> {
  if (Array.isArray(marketsOrId)) {
    return marketsOrId.find((market) => market.id === marketId);
  }

  return findPersistedMarketById(marketsOrId);
}

async function findPersistedMarketById(id: string): Promise<Market | null> {
  const { data, error } = await supabaseServerAdmin
    .from("markets")
    .select(MARKET_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new MarketRepositoryError();
  }

  return mapMarketRow(data as MarketRow | null);
}

export async function findMarketByCode(code: string): Promise<Market | null> {
  const { data, error } = await supabaseServerAdmin
    .from("markets")
    .select(MARKET_SELECT)
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();

  if (error) {
    throw new MarketRepositoryError();
  }

  return mapMarketRow(data as MarketRow | null);
}

export async function listMarkets(): Promise<Market[]> {
  const { data, error } = await supabaseServerAdmin
    .from("markets")
    .select(MARKET_SELECT)
    .order("is_default", { ascending: false })
    .order("code", { ascending: true });

  if (error) {
    throw new MarketRepositoryError();
  }

  return ((data ?? []) as MarketRow[])
    .map(mapMarketRow)
    .filter((market): market is Market => Boolean(market));
}

export async function getDefaultMarket(): Promise<Market | null> {
  const { data, error } = await supabaseServerAdmin
    .from("markets")
    .select(MARKET_SELECT)
    .eq("is_default", true)
    .maybeSingle();

  if (error) {
    throw new MarketRepositoryError();
  }

  return mapMarketRow(data as MarketRow | null);
}

export function updateMarket(markets: Market[], market: Market): Market[];
export function updateMarket(
  id: string,
  input: UpdateMarketInput
): Promise<Market>;
export function updateMarket(
  marketsOrId: Market[] | string,
  marketOrInput: Market | UpdateMarketInput
): Market[] | Promise<Market> {
  if (Array.isArray(marketsOrId)) {
    const market = marketOrInput as Market;

    return marketsOrId.map((createdMarket) =>
      createdMarket.id === market.id ? market : createdMarket
    );
  }

  return updatePersistedMarket(marketsOrId, marketOrInput as UpdateMarketInput);
}

async function updatePersistedMarket(
  id: string,
  input: UpdateMarketInput
): Promise<Market> {
  const normalized = normalizeUpdateMarketInput(input);
  const updatePayload: Record<string, string | boolean> = {};

  if (normalized.code !== undefined) updatePayload.code = normalized.code;
  if (normalized.name !== undefined) updatePayload.name = normalized.name;
  if (normalized.currencyCode !== undefined) {
    updatePayload.currency_code = normalized.currencyCode;
  }
  if (normalized.languageCode !== undefined) {
    updatePayload.language_code = normalized.languageCode;
  }
  if (normalized.timezone !== undefined) updatePayload.timezone = normalized.timezone;
  if (normalized.brandCode !== undefined) updatePayload.brand_code = normalized.brandCode;
  if (normalized.status !== undefined) updatePayload.status = normalized.status;
  if (normalized.isDefault !== undefined) updatePayload.is_default = normalized.isDefault;

  const { data, error } = await supabaseServerAdmin
    .from("markets")
    .update(updatePayload)
    .eq("id", id)
    .select(MARKET_SELECT)
    .single();

  if (error) {
    throw new MarketRepositoryError();
  }

  const market = mapMarketRow(data as MarketRow | null);

  if (!market) {
    throw new MarketRepositoryError();
  }

  return market;
}

export async function setDefaultMarket(id: string): Promise<Market> {
  const { error: clearError } = await supabaseServerAdmin
    .from("markets")
    .update({ is_default: false })
    .eq("is_default", true);

  if (clearError) {
    console.error("Supabase clear default markets error:", clearError);
    throw new MarketRepositoryError();
  }

  return updatePersistedMarket(id, { isDefault: true, status: "ACTIVE" });
}

export async function disableMarket(id: string): Promise<Market> {
  return updatePersistedMarket(id, { status: "DISABLED" });
}

export function saveMarket(markets: Market[], market: Market) {
  return [...markets, market];
}

export function deleteMarket(markets: Market[], marketId: string) {
  return markets.filter((market) => market.id !== marketId);
}
