export type MarketStatus = "ACTIVE" | "DISABLED";

export type Market = {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  languageCode: string;
  timezone: string;
  brandCode: string;
  status: MarketStatus;
  isDefault: boolean;
  createdAt: string;
  updatedAt?: string | null;

  // Legacy UI aliases retained until the market admin UI moves to persisted data.
  language: string;
  currency: string;
  timeZone: string;
  dateFormat: string;
  numberFormat: string;
  defaultBrand: string;
  active: boolean;
};

export type CreateMarketInput = {
  code: string;
  name: string;
  currencyCode: string;
  languageCode: string;
  timezone: string;
  brandCode: string;
  status?: MarketStatus;
  isDefault?: boolean;
};

export type UpdateMarketInput = Partial<
  Omit<CreateMarketInput, "code" | "isDefault">
> & {
  code?: string;
  isDefault?: boolean;
};
