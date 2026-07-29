import type { PlayerAccount } from "../accounts/account.types";
import {
  getChildAccounts,
  getDescendantAccountIds,
} from "../accounts/account.helpers";
import type {
  AuthorizationAction,
  AuthorizationActor,
} from "./authorization.types";
import {
  AUTHORIZATION_ERRORS,
  PLATFORM_ONLY_ACTIONS,
} from "./authorization.types";

export function isPlatformOnlyAction(action: AuthorizationAction) {
  return PLATFORM_ONLY_ACTIONS.includes(action);
}

export function isPermissionAssignableToActorCategory({
  actorCategory,
  permission,
}: {
  actorCategory: AuthorizationActor["actorCategory"];
  permission: AuthorizationAction;
}) {
  if (actorCategory === "hierarchy_participant" && isPlatformOnlyAction(permission)) {
    return {
      assignable: false,
      errors: [
        AUTHORIZATION_ERRORS.PERMISSION_NOT_ASSIGNABLE_TO_HIERARCHY_PARTICIPANT,
      ],
    };
  }

  return {
    assignable: true,
    errors: [],
  };
}

function getActorAccount(accounts: PlayerAccount[], actor: AuthorizationActor) {
  return accounts.find((account) => account.id === actor.accountId);
}

export function getVisibleAccountIdsForActor({
  actor,
  accounts,
}: {
  actor: AuthorizationActor;
  accounts: PlayerAccount[];
}) {
  if (actor.actorCategory === "platform_operator") {
    return accounts.map((account) => account.id);
  }

  const actorAccount = getActorAccount(accounts, actor);

  if (!actorAccount) {
    return [];
  }

  if (actorAccount.accountType === "super_master") {
    return accounts.map((account) => account.id);
  }

  if (actorAccount.accountType === "master_agent") {
    return getDescendantAccountIds(accounts, actorAccount.id);
  }

  if (actorAccount.accountType === "agent") {
    return getChildAccounts(accounts, actorAccount.id)
      .filter((account) => account.accountType === "player")
      .map((account) => account.id);
  }

  return [actorAccount.id];
}

export function isAccountInActorScope({
  actor,
  accounts,
  targetAccountId,
}: {
  actor: AuthorizationActor;
  accounts: PlayerAccount[];
  targetAccountId?: string | null;
}) {
  if (!targetAccountId) {
    return true;
  }

  return getVisibleAccountIdsForActor({ actor, accounts }).includes(
    targetAccountId
  );
}

export function actorHasPermission({
  actor,
  action,
}: {
  actor: AuthorizationActor;
  action: AuthorizationAction;
}) {
  return actor.permissions.includes(action) || actor.permissions.includes("*");
}
