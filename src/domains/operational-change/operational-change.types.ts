export type OperationalChangeType =
  | "CONFIGURATION_PUBLICATION"
  | "PRODUCT_PUBLICATION"
  | "PROVIDER_ACTIVATION"
  | "PROVIDER_DEACTIVATION"
  | "DRAW_SCHEDULE_PUBLICATION"
  | "PLATFORM_MAINTENANCE"
  | "RECOVERY_EXECUTION"
  | "PRODUCTION_RELEASE";

export type OperationalChangeRecord = {
  changeId: string;
  commandId: string;
  changeType: OperationalChangeType;
  idempotencyKey: string;
  canonicalChangeHash: string;
  correlationId: string;
};

export type OperationalChangeVerification = {
  expectedStateReached: boolean;
  authorityAccepted: boolean;
  readinessMaintained: boolean;
  auditRecorded: boolean;
  observedState: Record<string, unknown>;
};
