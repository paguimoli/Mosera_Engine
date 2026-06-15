export type PersistedWalletType = "CASH" | "CREDIT" | "FREE_PLAY";

export type LegacyWalletType = "cash" | "credit" | "freeplay";

export type WalletType = PersistedWalletType | LegacyWalletType;

export type PersistedWalletStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";

export type LegacyWalletStatus = "active" | "frozen" | "suspended" | "closed";

export type WalletStatus = PersistedWalletStatus | LegacyWalletStatus;

export type BalanceAuthority = "INTERNAL" | "EXTERNAL";

export type FundingModel = "CASH" | "CREDIT" | "HYBRID";

export type OperatingMode = "CREDIT_EXPOSURE" | "COMMISSION";

export type DefaultFundingSource = PersistedWalletType;

export type WeeklyAccountingMode = "ZERO_BALANCE" | "CARRY_BALANCE";

export type SettlementMode = "AUTO_SETTLEMENT" | "MANUAL_SETTLEMENT";

export type Wallet = {
  id: string;
  accountId: string;
  walletType: WalletType;
  status: WalletStatus;
  currency?: string | null;
  currencyCode?: string | null;
  balanceAuthority?: BalanceAuthority | null;
  balance?: number;
  creditLimit?: number | null;
  fundingModel?: FundingModel | null;
  operatingMode?: OperatingMode | null;
  defaultFundingSource?: DefaultFundingSource | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type CreateWalletInput = {
  accountId: string;
  walletType: PersistedWalletType;
  currencyCode: string;
  balanceAuthority?: BalanceAuthority;
  status?: PersistedWalletStatus;
  balance?: number;
  creditLimit?: number | null;
  fundingModel: FundingModel;
  operatingMode?: OperatingMode | null;
  defaultFundingSource?: DefaultFundingSource | null;
};

export type UpdateWalletInput = Partial<
  Omit<CreateWalletInput, "accountId" | "walletType">
>;

export type AccountWalletConfiguration = {
  fundingModel?: FundingModel | null;
  operatingMode?: OperatingMode | null;
  balanceAuthority?: BalanceAuthority | null;
  defaultFundingSource?: DefaultFundingSource | null;
  weeklyAccountingMode?: WeeklyAccountingMode | null;
  settlementMode?: SettlementMode | null;
};

export type WalletBalanceSummary = {
  accountId: string;
  cashBalance: number;
  creditBalance: number;
  freeplayBalance: number;
  availableCredit: number;
};

export const WALLET_TYPES: WalletType[] = [
  "CASH",
  "CREDIT",
  "FREE_PLAY",
  "cash",
  "credit",
  "freeplay",
];

export const WALLET_STATUSES: WalletStatus[] = [
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
  "active",
  "frozen",
  "suspended",
  "closed",
];

export const PERSISTED_WALLET_TYPES: PersistedWalletType[] = [
  "CASH",
  "CREDIT",
  "FREE_PLAY",
];

export const PERSISTED_WALLET_STATUSES: PersistedWalletStatus[] = [
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
];
