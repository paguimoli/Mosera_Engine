import type {
  ServiceBoundary,
  ServiceName,
  ServiceOwnedTable,
} from "./service-boundary.types";

const ownedResources = [
  { owner: "AUTH_SERVICE", name: "platform_users", kind: "table" },
  { owner: "AUTH_SERVICE", name: "user_sessions", kind: "table" },
  { owner: "AUTH_SERVICE", name: "platform_sessions", kind: "future", notes: "Alias boundary for session records during service extraction." },
  { owner: "AUTH_SERVICE", name: "user_groups", kind: "table" },
  { owner: "AUTH_SERVICE", name: "user_group_memberships", kind: "table" },
  { owner: "AUTH_SERVICE", name: "group_permissions", kind: "table" },
  { owner: "AUTH_SERVICE", name: "permissions", kind: "table" },
  { owner: "AUTH_SERVICE", name: "user_group_permissions", kind: "table" },
  { owner: "AUTH_SERVICE", name: "user_mfa_factors", kind: "table" },
  { owner: "AUTH_SERVICE", name: "auth_mfa_challenges", kind: "table" },
  { owner: "AUTH_SERVICE", name: "mfa_recovery_codes", kind: "table" },
  { owner: "AUTH_SERVICE", name: "password_reset_tokens", kind: "table" },
  { owner: "AUTH_SERVICE", name: "oauth_clients", kind: "table" },
  { owner: "AUTH_SERVICE", name: "oauth_access_tokens", kind: "table" },
  { owner: "AUTH_SERVICE", name: "auth_audit_log", kind: "table" },
  { owner: "AUTH_SERVICE", name: "break_glass_accounts", kind: "table" },

  { owner: "ACCOUNT_SERVICE", name: "accounts", kind: "table" },
  { owner: "MARKET_SERVICE", name: "markets", kind: "table" },
  { owner: "BRAND_SERVICE", name: "brands", kind: "table" },
  { owner: "PLAYER_SERVICE", name: "player_profiles", kind: "table" },

  { owner: "WALLET_SERVICE", name: "financial_wallets", kind: "table" },
  { owner: "LEDGER_SERVICE", name: "financial_ledger_entries", kind: "table" },
  { owner: "LEDGER_SERVICE", name: "post_financial_ledger_entry", kind: "rpc" },
  { owner: "LEDGER_SERVICE", name: "reverse_financial_ledger_entry", kind: "rpc" },

  { owner: "CASHIER_SERVICE", name: "cashier_transactions", kind: "table" },

  { owner: "ACCOUNTING_SERVICE", name: "weekly_accounting_periods", kind: "table" },
  { owner: "ACCOUNTING_SERVICE", name: "weekly_account_summaries", kind: "table" },

  { owner: "COMMISSION_SERVICE", name: "commission_plans", kind: "table" },
  { owner: "COMMISSION_SERVICE", name: "commission_plan_rules", kind: "table" },
  { owner: "COMMISSION_SERVICE", name: "account_commission_assignments", kind: "table" },
  { owner: "COMMISSION_SERVICE", name: "weekly_commission_records", kind: "table" },

  { owner: "WORKER_SERVICE", name: "outbox_events", kind: "table" },
  { owner: "WORKER_SERVICE", name: "job_runs", kind: "table" },
  { owner: "WORKER_SERVICE", name: "idempotency_keys", kind: "table" },

  { owner: "DRAW_SERVICE", name: "games", kind: "future", notes: "Game/draw configuration currently lives in code until persisted draw tables exist." },
  { owner: "DRAW_SERVICE", name: "draws", kind: "future" },
  { owner: "DRAW_SERVICE", name: "draw_results", kind: "future" },

  { owner: "SETTLEMENT_SERVICE", name: "tickets", kind: "future" },
  { owner: "SETTLEMENT_SERVICE", name: "wagers", kind: "future" },
  { owner: "SETTLEMENT_SERVICE", name: "results", kind: "future" },
  { owner: "SETTLEMENT_SERVICE", name: "settlement_runs", kind: "future" },
  { owner: "SETTLEMENT_SERVICE", name: "resettlement_runs", kind: "future" },

  { owner: "PAM_SERVICE", name: "pam_transactions", kind: "future" },
  { owner: "PAM_SERVICE", name: "pam_balance_snapshots", kind: "future" },

  { owner: "REPORTING_SERVICE", name: "reporting_read_models", kind: "future" },
  { owner: "REPORTING_SERVICE", name: "reporting_exports", kind: "future" },

  { owner: "NOTIFICATION_SERVICE", name: "notification_outbox", kind: "future" },
  { owner: "NOTIFICATION_SERVICE", name: "webhook_deliveries", kind: "future" },
] satisfies ServiceOwnedTable[];

export const serviceOwnedResources: ServiceOwnedTable[] = ownedResources;

export function getOwnedResourcesForService(
  serviceName: ServiceName
): ServiceOwnedTable[] {
  return serviceOwnedResources.filter((resource) => resource.owner === serviceName);
}

const serviceNames: ServiceName[] = [
  "AUTH_SERVICE",
  "ACCOUNT_SERVICE",
  "MARKET_SERVICE",
  "BRAND_SERVICE",
  "PLAYER_SERVICE",
  "WALLET_SERVICE",
  "LEDGER_SERVICE",
  "CASHIER_SERVICE",
  "ACCOUNTING_SERVICE",
  "COMMISSION_SERVICE",
  "DRAW_SERVICE",
  "SETTLEMENT_SERVICE",
  "PAM_SERVICE",
  "REPORTING_SERVICE",
  "NOTIFICATION_SERVICE",
  "WORKER_SERVICE",
];

export const serviceBoundaries: ServiceBoundary[] = serviceNames.map(
  (serviceName) => ({
    serviceName,
    owns: getOwnedResourcesForService(serviceName),
    allowedDependencies: [],
  })
);
