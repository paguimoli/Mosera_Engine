export type WalletType = "cash" | "credit" | "freeplay";

export type WalletStatus = "active" | "frozen" | "suspended" | "closed";

export type Wallet = {
  id: string;
  accountId: string;
  walletType: WalletType;
  status: WalletStatus;
  currency?: string | null;
  creditLimit?: number | null;
  createdAt: string;
};

export type WalletBalanceSummary = {
  accountId: string;
  cashBalance: number;
  creditBalance: number;
  freeplayBalance: number;
  availableCredit: number;
};

export const WALLET_TYPES: WalletType[] = ["cash", "credit", "freeplay"];

export const WALLET_STATUSES: WalletStatus[] = [
  "active",
  "frozen",
  "suspended",
  "closed",
];
