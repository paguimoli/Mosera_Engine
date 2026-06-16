export type ServiceName =
  | "AUTH_SERVICE"
  | "ACCOUNT_SERVICE"
  | "MARKET_SERVICE"
  | "BRAND_SERVICE"
  | "PLAYER_SERVICE"
  | "WALLET_SERVICE"
  | "LEDGER_SERVICE"
  | "CASHIER_SERVICE"
  | "ACCOUNTING_SERVICE"
  | "COMMISSION_SERVICE"
  | "DRAW_SERVICE"
  | "SETTLEMENT_SERVICE"
  | "PAM_SERVICE"
  | "REPORTING_SERVICE"
  | "NOTIFICATION_SERVICE"
  | "WORKER_SERVICE";

export type ServiceOwnedTable = {
  name: string;
  owner: ServiceName;
  kind: "table" | "rpc" | "future";
  notes?: string;
};

export type ServiceCommand<TPayload = unknown> = {
  service: ServiceName;
  commandType: string;
  payload: TPayload;
  correlationId?: string | null;
  idempotencyKey?: string | null;
};

export type ServiceEvent<TPayload = unknown> = {
  service: ServiceName;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  correlationId?: string | null;
  occurredAt: string;
};

export type ServiceDependency = {
  fromService: ServiceName;
  toService: ServiceName;
  reason?: string;
};

export type ServiceBoundary = {
  serviceName: ServiceName;
  owns: ServiceOwnedTable[];
  allowedDependencies: ServiceName[];
  publishedEvents?: string[];
  acceptedCommands?: string[];
};
