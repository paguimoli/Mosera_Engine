import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  Market,
  MarketStatus,
} from "./market.types";

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
  markets: Market[],
  market: Market
): Market[] {
  return markets.map((createdMarket) =>
    createdMarket.id === market.id ? market : createdMarket
  );
}

export function saveMarket(markets: Market[], market: Market) {
  return [...markets, market];
}

export function deleteMarket(markets: Market[], marketId: string) {
  return markets.filter((market) => market.id !== marketId);
}
