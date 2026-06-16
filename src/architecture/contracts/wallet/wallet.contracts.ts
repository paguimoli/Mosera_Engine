export type GetWalletBalanceQuery = {
  walletId: string;
  correlationId?: string | null;
};

export type WalletBalanceResult = {
  walletId: string;
  accountId: string;
  walletType: "CASH" | "CREDIT" | "FREE_PLAY";
  balance: number;
  currencyCode: string;
  asOf: string;
};

export type WalletDebitedEvent = {
  eventType: "wallet.debited";
  walletId: string;
  accountId: string;
  amount: number;
  currencyCode: string;
  ledgerEntryId: string;
  correlationId?: string | null;
  occurredAt: string;
};

export type WalletCreditedEvent = {
  eventType: "wallet.credited";
  walletId: string;
  accountId: string;
  amount: number;
  currencyCode: string;
  ledgerEntryId: string;
  correlationId?: string | null;
  occurredAt: string;
};
