import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";

import type { CanonicalAccountScope } from "./account.repository";
import { findAccountById } from "./account.repository";
import type { Account, PersistedAccountType } from "./account.types";

type ScopeTarget = CanonicalAccountScope | Account;

function normalizedScopes(context: AuthContext) {
  return (context.platformScopes ?? []).map((scope) => ({
    type: scope.scopeType.trim().toUpperCase(),
    id: scope.scopeId.trim().toLowerCase(),
  }));
}

function includesScope(
  context: AuthContext,
  type: string,
  id: string
) {
  const normalizedType = type.toUpperCase();
  const normalizedId = id.toLowerCase();
  return normalizedScopes(context).some(
    (scope) =>
      scope.type === normalizedType &&
      (scope.id === normalizedId || scope.id === "*")
  );
}

export function canAccessAccountScope(
  context: AuthContext,
  scope: ScopeTarget
) {
  if (context.hasPermission("system.admin")) return true;
  if (
    includesScope(context, "GLOBAL", "platform") ||
    includesScope(context, "GLOBAL", "*")
  ) {
    return true;
  }

  return (
    includesScope(context, "MARKET", scope.marketId) ||
    includesScope(context, "BRAND", scope.brandId) ||
    includesScope(context, "TENANT", scope.tenantId) ||
    includesScope(context, "ORGANIZATION", scope.organizationId)
  );
}

export function assertAccountScope(
  context: AuthContext,
  scope: ScopeTarget
) {
  if (!canAccessAccountScope(context, scope)) {
    throw new AuthMiddlewareError(403, "Canonical account scope denied.");
  }
}

export function filterAccountsByScope(
  context: AuthContext,
  accounts: Account[]
) {
  return accounts.filter((account) => canAccessAccountScope(context, account));
}

export async function requireScopedAccount(
  request: Request,
  accountId: string,
  permission: string
) {
  const context = await requirePermission(request, permission);
  const account = await findAccountById(accountId);
  if (!account) {
    throw new AccountScopeNotFoundError();
  }
  assertAccountScope(context, account);
  return { context, account };
}

export class AccountScopeNotFoundError extends Error {
  constructor() {
    super("Account not found.");
    this.name = "AccountScopeNotFoundError";
  }
}

export function accountCreatePermission(accountType: PersistedAccountType) {
  if (accountType === "PLAYER") return "players.create";
  if (accountType === "MASTER_AGENT" || accountType === "AGENT") {
    return "agents.create";
  }
  return "accounts.create";
}

export function accountMutationPermission(
  account: Account,
  action: "edit" | "disable" | "reassign"
) {
  if (action === "reassign") return "accounts.reassign";
  if (account.accountType === "PLAYER") {
    return action === "disable" ? "players.disable" : "players.edit";
  }
  if (
    account.accountType === "MASTER_AGENT" ||
    account.accountType === "AGENT"
  ) {
    return action === "disable" ? "agents.disable" : "agents.edit";
  }
  return action === "disable" ? "accounts.disable" : "accounts.edit";
}
