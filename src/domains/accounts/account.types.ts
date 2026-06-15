export type PersistedAccountType =
  | "SUPER_MASTER"
  | "MASTER_AGENT"
  | "AGENT"
  | "PLAYER";

export type LegacyAccountType =
  | "super_master"
  | "master_agent"
  | "agent"
  | "player";

export type AccountType = PersistedAccountType | LegacyAccountType;

export type PersistedAccountStatus = "ACTIVE" | "DISABLED";

export type LegacyAccountStatus = "active" | "suspended" | "inactive";

export type AccountStatus = PersistedAccountStatus | LegacyAccountStatus;

export type AccountFundingModel = "CASH" | "CREDIT" | "HYBRID";

export type AccountOperatingMode = "CREDIT_EXPOSURE" | "COMMISSION";

export type AccountBalanceAuthority = "INTERNAL" | "EXTERNAL";

export type AccountDefaultFundingSource = "CASH" | "CREDIT" | "FREE_PLAY";

export type AccountWeeklyAccountingMode = "ZERO_BALANCE" | "CARRY_BALANCE";

export type AccountSettlementMode = "AUTO_SETTLEMENT" | "MANUAL_SETTLEMENT";

export type Account = {
  id: string;
  accountType: PersistedAccountType;
  accountCode: string;
  displayName: string;
  parentAccountId?: string | null;
  marketId: string;
  brandId: string;
  status: PersistedAccountStatus;
  fundingModel?: AccountFundingModel | null;
  operatingMode?: AccountOperatingMode | null;
  balanceAuthority?: AccountBalanceAuthority | null;
  defaultFundingSource?: AccountDefaultFundingSource | null;
  weeklyAccountingMode?: AccountWeeklyAccountingMode | null;
  settlementMode?: AccountSettlementMode | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type CreateAccountInput = {
  accountType: PersistedAccountType;
  accountCode: string;
  displayName: string;
  parentAccountId?: string | null;
  marketId: string;
  brandId: string;
  status?: PersistedAccountStatus;
  fundingModel?: AccountFundingModel | null;
  operatingMode?: AccountOperatingMode | null;
  balanceAuthority?: AccountBalanceAuthority | null;
  defaultFundingSource?: AccountDefaultFundingSource | null;
  weeklyAccountingMode?: AccountWeeklyAccountingMode | null;
  settlementMode?: AccountSettlementMode | null;
};

export type UpdateAccountInput = Partial<CreateAccountInput>;

export type PlayerAccount = {
  id: string;
  accountType: AccountType;
  parentId: string | null;
  username: string;
  displayName: string;
  email?: string;
  phone?: string;
  marketId?: string | null;
  language?: string;
  currency?: string;
  status: AccountStatus;
  cashBalance: number;
  creditLimit: number;
  currentExposure: number;
  availableCredit: number;
  maxBet?: number;
  maxPayout?: number;
  notes?: string;
  createdAt: string;
};
