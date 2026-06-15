import type { CreateMarketInput, Market, UpdateMarketInput } from "./market.types";
import {
  createMarket as createMarketRecord,
  disableMarket as disableMarketRecord,
  findMarketByCode,
  findMarketById,
  getDefaultMarket as getDefaultMarketRecord,
  listMarkets as listMarketRecords,
  setDefaultMarket as setDefaultMarketRecord,
  updateMarket as updateMarketRecord,
} from "./market.repository";
import {
  normalizeCreateMarketInput,
  normalizeUpdateMarketInput,
  validateCreateMarketInput,
  validateUpdateMarketInput,
} from "./market.validation";

export class DuplicateMarketCodeError extends Error {
  constructor(message = "Duplicate market code.") {
    super(message);
    this.name = "DuplicateMarketCodeError";
  }
}

export class MarketValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "MarketValidationError";
    this.errors = errors;
  }
}

export class MarketBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketBusinessRuleError";
  }
}

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

export async function createMarket(input: CreateMarketInput): Promise<Market> {
  const validation = validateCreateMarketInput(input);

  if (!validation.valid) {
    throw new MarketValidationError(validation.errors);
  }

  const normalized = normalizeCreateMarketInput(input);
  const existingMarket = await findMarketByCode(normalized.code);

  if (existingMarket) {
    throw new DuplicateMarketCodeError();
  }

  const market = await createMarketRecord(normalized);

  if (normalized.isDefault) {
    return setDefaultMarketRecord(market.id);
  }

  return market;
}

export async function updateMarket(
  id: string,
  input: UpdateMarketInput
): Promise<Market> {
  const validation = validateUpdateMarketInput(input);

  if (!validation.valid) {
    throw new MarketValidationError(validation.errors);
  }

  const normalized = normalizeUpdateMarketInput(input);

  if (normalized.code) {
    const existingMarket = await findMarketByCode(normalized.code);

    if (existingMarket && existingMarket.id !== id) {
      throw new DuplicateMarketCodeError();
    }
  }

  const market = await updateMarketRecord(id, normalized);

  if (normalized.isDefault) {
    return setDefaultMarketRecord(market.id);
  }

  return market;
}

export async function setDefaultMarket(id: string): Promise<Market> {
  const market = await findMarketById(id);

  if (!market) {
    throw new MarketBusinessRuleError("Market not found.");
  }

  return setDefaultMarketRecord(id);
}

export async function disableMarket(id: string): Promise<Market> {
  const market = await findMarketById(id);

  if (!market) {
    throw new MarketBusinessRuleError("Market not found.");
  }

  if (market.isDefault) {
    throw new MarketBusinessRuleError("Cannot disable the default market.");
  }

  return disableMarketRecord(id);
}

export async function listMarkets(): Promise<Market[]> {
  return listMarketRecords();
}

export async function getDefaultMarket(): Promise<Market | null> {
  return getDefaultMarketRecord();
}
