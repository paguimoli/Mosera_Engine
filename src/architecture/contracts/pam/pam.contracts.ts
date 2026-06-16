export type PamDebitCommand = {
  playerId: string;
  amount: number;
  currencyCode: string;
  externalTransactionId: string;
  idempotencyKey: string;
  correlationId?: string | null;
};

export type PamCreditCommand = PamDebitCommand;

export type PamRollbackCommand = {
  playerId: string;
  originalExternalTransactionId: string;
  rollbackExternalTransactionId: string;
  reason: string;
  idempotencyKey: string;
  correlationId?: string | null;
};

export type PamBalanceQuery = {
  playerId: string;
  currencyCode?: string | null;
  correlationId?: string | null;
};

export type PamBalanceResult = {
  playerId: string;
  balance: number;
  currencyCode: string;
  provider: string;
  asOf: string;
};
