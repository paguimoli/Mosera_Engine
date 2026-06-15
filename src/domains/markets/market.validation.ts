import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import { isValidIanaTimezone } from "@/src/lib/timezones/timezone.validation";
import type {
  CreateMarketInput,
  Market,
  MarketStatus,
  UpdateMarketInput,
} from "./market.types";

const MARKET_STATUSES: MarketStatus[] = ["ACTIVE", "DISABLED"];

function hasDuplicateMarketCode(
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

function isMarketStatus(value: string): value is MarketStatus {
  return MARKET_STATUSES.includes(value as MarketStatus);
}

export function normalizeMarketCode(code: string): string {
  return code.trim().toUpperCase();
}

export function normalizeCurrencyCode(currencyCode: string): string {
  return currencyCode.trim().toUpperCase();
}

export function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

export function normalizeBrandCode(brandCode: string): string {
  return brandCode.trim().toUpperCase();
}

export function validateCreateMarketInput(input: CreateMarketInput): ValidationResult {
  const errors: string[] = [];
  const code = normalizeMarketCode(input.code);
  const name = input.name.trim();
  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  const languageCode = normalizeLanguageCode(input.languageCode);
  const timezone = input.timezone.trim();
  const brandCode = normalizeBrandCode(input.brandCode);
  const status = input.status ?? "ACTIVE";

  if (!code) {
    errors.push("Market code is required.");
  }

  if (!name) {
    errors.push("Market name is required.");
  }

  if (!currencyCode || currencyCode.length !== 3) {
    errors.push("Currency code must be 3 characters.");
  }

  if (
    !languageCode ||
    languageCode.length < 2 ||
    languageCode.length > 5
  ) {
    errors.push("Language code must be between 2 and 5 characters.");
  }

  if (!timezone) {
    errors.push("Timezone is required.");
  } else if (!isValidIanaTimezone(timezone)) {
    errors.push("Timezone must be a valid IANA timezone.");
  }

  if (!brandCode) {
    errors.push("Brand code is required.");
  }

  if (!isMarketStatus(status)) {
    errors.push("Market status is invalid.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function validateUpdateMarketInput(input: UpdateMarketInput): ValidationResult {
  const createValidation = validateCreateMarketInput({
    code: input.code ?? "PATCH",
    name: input.name ?? "Patch",
    currencyCode: input.currencyCode ?? "USD",
    languageCode: input.languageCode ?? "en",
    timezone: input.timezone ?? "America/New_York",
    brandCode: input.brandCode ?? "MAIN",
    status: input.status ?? "ACTIVE",
    isDefault: input.isDefault,
  });

  return createValidation;
}

export function normalizeCreateMarketInput(
  input: CreateMarketInput
): CreateMarketInput {
  return {
    code: normalizeMarketCode(input.code),
    name: input.name.trim(),
    currencyCode: normalizeCurrencyCode(input.currencyCode),
    languageCode: normalizeLanguageCode(input.languageCode),
    timezone: input.timezone.trim(),
    brandCode: normalizeBrandCode(input.brandCode),
    status: input.status ?? "ACTIVE",
    isDefault: input.isDefault ?? false,
  };
}

export function normalizeUpdateMarketInput(
  input: UpdateMarketInput
): UpdateMarketInput {
  return {
    ...(input.code !== undefined ? { code: normalizeMarketCode(input.code) } : {}),
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.currencyCode !== undefined
      ? { currencyCode: normalizeCurrencyCode(input.currencyCode) }
      : {}),
    ...(input.languageCode !== undefined
      ? { languageCode: normalizeLanguageCode(input.languageCode) }
      : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone.trim() } : {}),
    ...(input.brandCode !== undefined
      ? { brandCode: normalizeBrandCode(input.brandCode) }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
  };
}
