export type ServiceName =
  | "AUTH_SERVICE"
  | "PLATFORM_SERVICE"
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
  | "GAME_ENGINE_SERVICE"
  | "TICKET_SERVICE"
  | "SETTLEMENT_SERVICE"
  | "OPERATIONAL_SERVICE"
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
  contractVersion: string;
  service: ServiceName;
  commandType: string;
  payload: TPayload;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
};

export type ServiceEvent<TPayload = unknown> = {
  contractVersion: string;
  eventId: string;
  service: ServiceName;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
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
