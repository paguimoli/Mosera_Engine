import type { ServiceDependency, ServiceName } from "./service-boundary.types";

export const allowedServiceDependencies: ServiceDependency[] = [
  { fromService: "CASHIER_SERVICE", toService: "LEDGER_SERVICE" },
  { fromService: "CASHIER_SERVICE", toService: "WALLET_SERVICE" },
  { fromService: "CASHIER_SERVICE", toService: "ACCOUNT_SERVICE" },
  { fromService: "LEDGER_SERVICE", toService: "WALLET_SERVICE" },
  { fromService: "WALLET_SERVICE", toService: "ACCOUNT_SERVICE" },
  { fromService: "SETTLEMENT_SERVICE", toService: "LEDGER_SERVICE" },
  { fromService: "SETTLEMENT_SERVICE", toService: "WALLET_SERVICE" },
  { fromService: "SETTLEMENT_SERVICE", toService: "DRAW_SERVICE" },
  { fromService: "ACCOUNTING_SERVICE", toService: "LEDGER_SERVICE" },
  { fromService: "ACCOUNTING_SERVICE", toService: "WALLET_SERVICE" },
  { fromService: "ACCOUNTING_SERVICE", toService: "ACCOUNT_SERVICE" },
  { fromService: "COMMISSION_SERVICE", toService: "ACCOUNTING_SERVICE" },
  { fromService: "COMMISSION_SERVICE", toService: "ACCOUNT_SERVICE" },
  { fromService: "PAM_SERVICE", toService: "LEDGER_SERVICE" },
  { fromService: "PAM_SERVICE", toService: "WALLET_SERVICE" },
  { fromService: "PLAYER_SERVICE", toService: "ACCOUNT_SERVICE" },
  {
    fromService: "REPORTING_SERVICE",
    toService: "AUTH_SERVICE",
    reason: "Read-only operational reporting.",
  },
  {
    fromService: "REPORTING_SERVICE",
    toService: "ACCOUNT_SERVICE",
    reason: "Read-only operational reporting.",
  },
  {
    fromService: "REPORTING_SERVICE",
    toService: "WALLET_SERVICE",
    reason: "Read-only operational reporting.",
  },
  {
    fromService: "REPORTING_SERVICE",
    toService: "LEDGER_SERVICE",
    reason: "Read-only operational reporting.",
  },
  {
    fromService: "REPORTING_SERVICE",
    toService: "CASHIER_SERVICE",
    reason: "Read-only operational reporting.",
  },
  { fromService: "WORKER_SERVICE", toService: "LEDGER_SERVICE" },
  { fromService: "WORKER_SERVICE", toService: "CASHIER_SERVICE" },
  { fromService: "WORKER_SERVICE", toService: "SETTLEMENT_SERVICE" },
  { fromService: "WORKER_SERVICE", toService: "NOTIFICATION_SERVICE" },
];

export const architecturalDependencyRules = [
  "UI must not call repositories directly.",
  "Services must not write tables owned by another service.",
  "Cross-service writes must happen through commands/contracts.",
  "Cross-service notifications should happen through events/outbox.",
  "Reporting may read but should not mutate operational tables.",
] as const;

export function assertServiceDependencyAllowed(
  fromService: ServiceName,
  toService: ServiceName
): void {
  if (fromService === toService) {
    return;
  }

  const allowed = allowedServiceDependencies.some(
    (dependency) =>
      dependency.fromService === fromService && dependency.toService === toService
  );

  if (!allowed) {
    throw new Error(
      `Service dependency ${fromService} -> ${toService} is not allowed.`
    );
  }
}
