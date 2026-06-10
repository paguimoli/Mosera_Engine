import type { PlayerAccount } from "./account.types";

export function findAccountById(accounts: PlayerAccount[], accountId: string) {
  return accounts.find((account) => account.id === accountId);
}

export function findAccountByUsername(accounts: PlayerAccount[], username: string) {
  return accounts.find(
    (account) =>
      account.username.trim().toLowerCase() === username.trim().toLowerCase()
  );
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

export function updateAccount(accounts: PlayerAccount[], account: PlayerAccount) {
  return accounts.map((createdAccount) =>
    createdAccount.id === account.id ? account : createdAccount
  );
}

export function deleteAccount(accounts: PlayerAccount[], accountId: string) {
  return accounts.filter((account) => account.id !== accountId);
}
