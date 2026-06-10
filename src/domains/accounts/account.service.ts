import type { PlayerAccount } from "./account.types";

export function getChildAccounts(accounts: PlayerAccount[], accountId: string) {
  return accounts.filter((account) => account.parentId === accountId);
}

export function getDescendantAccountIds(
  accounts: PlayerAccount[],
  accountId: string
) {
  const descendantIds: string[] = [];
  const collectDescendants = (parentId: string) => {
    getChildAccounts(accounts, parentId).forEach((childAccount) => {
      descendantIds.push(childAccount.id);
      collectDescendants(childAccount.id);
    });
  };

  collectDescendants(accountId);
  return descendantIds;
}

export function wouldCreateHierarchyCycle(
  accounts: PlayerAccount[],
  accountId: string,
  newParentId: string | null
) {
  if (!accountId || !newParentId) {
    return false;
  }

  if (accountId === newParentId) {
    return true;
  }

  return getDescendantAccountIds(accounts, accountId).includes(newParentId);
}
