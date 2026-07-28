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

  { owner: "PLATFORM_SERVICE", name: "platform.organizations", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.tenants", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.brands", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.markets", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.websites", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.website_domains", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.brand_themes", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.brand_assets", kind: "table" },
  { owner: "PLATFORM_SERVICE", name: "platform.game_availability", kind: "table" },
  { owner: "ACCOUNT_SERVICE", name: "accounts", kind: "table" },
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

  { owner: "GAME_ENGINE_SERVICE", name: "game_engine.game_manifests", kind: "table" },
  { owner: "GAME_ENGINE_SERVICE", name: "game_engine.draw_authorities", kind: "table" },
  { owner: "GAME_ENGINE_SERVICE", name: "game_engine.draw_schedules", kind: "table" },
  { owner: "GAME_ENGINE_SERVICE", name: "game_engine.canonical_outcome_versions", kind: "table" },
  { owner: "GAME_ENGINE_SERVICE", name: "game_engine.outcome_settlement_requests", kind: "table" },

  { owner: "TICKET_SERVICE", name: "ticket_authority.tickets", kind: "table" },
  { owner: "TICKET_SERVICE", name: "ticket_authority.ticket_items", kind: "table" },
  { owner: "TICKET_SERVICE", name: "ticket_authority.ticket_lifecycle_events", kind: "table" },
  { owner: "TICKET_SERVICE", name: "ticket_authority.accept_ticket", kind: "rpc" },
  { owner: "TICKET_SERVICE", name: "ticket_authority.cancel_ticket", kind: "rpc" },

  { owner: "SETTLEMENT_SERVICE", name: "settlement_service.settlement_requests", kind: "table" },
  { owner: "SETTLEMENT_SERVICE", name: "settlement_service.settlement_runs", kind: "table" },
  { owner: "SETTLEMENT_SERVICE", name: "settlement_service.settlement_records", kind: "table" },
  { owner: "SETTLEMENT_SERVICE", name: "settlement_service.financial_instructions", kind: "table" },
  { owner: "SETTLEMENT_SERVICE", name: "settlement_service.resettlement_requests", kind: "table" },

  { owner: "OPERATIONAL_SERVICE", name: "authority_approval_records", kind: "table" },

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
  "PLATFORM_SERVICE",
  "ACCOUNT_SERVICE",
  "MARKET_SERVICE",
  "BRAND_SERVICE",
  "PLAYER_SERVICE",
  "WALLET_SERVICE",
  "LEDGER_SERVICE",
  "CASHIER_SERVICE",
  "ACCOUNTING_SERVICE",
  "COMMISSION_SERVICE",
  "GAME_ENGINE_SERVICE",
  "TICKET_SERVICE",
  "SETTLEMENT_SERVICE",
  "OPERATIONAL_SERVICE",
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
