import type { AccountType, PlayerAccount } from "./account.types";

export function getAccountTypeLabel(accountType: AccountType) {
  if (accountType === "SUPER_MASTER" || accountType === "super_master") {
    return "House / Super Master";
  }

  if (accountType === "MASTER_AGENT" || accountType === "master_agent") {
    return "Master Agent";
  }

  if (accountType === "AGENT" || accountType === "agent") return "Agent";

  return "Player";
}

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

export function findAccountById(
  accounts: PlayerAccount[],
  accountId: string
) {
  return accounts.find((account) => account.id === accountId);
}

export function listAccountsByParentId(
  accounts: PlayerAccount[],
  parentId: string | null
) {
  return accounts.filter((account) => account.parentId === parentId);
}

export function saveAccount(accounts: PlayerAccount[], account: PlayerAccount) {
  return [...accounts, account];
}

export function updateAccount(
  accounts: PlayerAccount[],
  account: PlayerAccount
) {
  return accounts.map((createdAccount) =>
    createdAccount.id === account.id ? account : createdAccount
  );
}

export function deleteAccount(accounts: PlayerAccount[], accountId: string) {
  return accounts.filter((account) => account.id !== accountId);
}
