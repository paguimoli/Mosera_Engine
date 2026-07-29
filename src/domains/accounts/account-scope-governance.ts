import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import {
  AuthMiddlewareError,
  requirePermission,
} from "@/src/domains/auth/auth-middleware";

import { findAccountById } from "./account.repository";
import type { Account, PersistedAccountType } from "./account.types";
import { resolveCanonicalScope } from "@/src/domains/scope/canonical-scope-resolver";
import {
  resolveAccountAncestors,
  type CanonicalAccountScope,
} from "@/src/domains/hierarchy/canonical-hierarchy-authority";

type ScopeTarget = CanonicalAccountScope | Account;

export function canAccessAccountScope(
  context: AuthContext,
  scope: ScopeTarget
) {
  return resolveCanonicalScope(context, scope).authorized;
}

export function assertAccountScope(
  context: AuthContext,
  scope: ScopeTarget
) {
  if (!canAccessAccountScope(context, scope)) {
    throw new AuthMiddlewareError(403, "Canonical account scope denied.");
  }
}

export async function canAccessResolvedAccountScope(
  context: AuthContext,
  account: Account
) {
  const hierarchy = await resolveAccountAncestors(account.id);
  return resolveCanonicalScope(context, {
    ...account,
    ...hierarchy,
  }).authorized;
}

export async function filterAccountsByScope(
  context: AuthContext,
  accounts: Account[]
) {
  const decisions = await Promise.all(
    accounts.map(async (account) => ({
      account,
      authorized: await canAccessResolvedAccountScope(context, account),
    }))
  );
  return decisions
    .filter((decision) => decision.authorized)
    .map((decision) => decision.account);
}

export async function requireScopedAccount(
  request: Request,
  accountId: string,
  permission: string
) {
  const context = await requirePermission(request, permission);
  const account = await resolveScopedAccount(context, accountId);
  return { context, account };
}

export async function resolveScopedAccount(
  context: AuthContext,
  accountId: string
) {
  const account = await findAccountById(accountId);
  if (!account) {
    throw new AccountScopeNotFoundError();
  }
  if (!(await canAccessResolvedAccountScope(context, account))) {
    throw new AuthMiddlewareError(403, "Canonical account scope denied.");
  }
  return account;
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
