import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { AccountType, PlayerAccount } from "./account.types";
import { wouldCreateHierarchyCycle } from "./account.service";

export function validatePlayerAccountForm({
  form,
  accounts,
  editingPlayerAccountId,
}: {
  form: {
    accountType: AccountType;
    parentId: string;
    username: string;
    displayName: string;
    status: string;
    cashBalance: string;
    creditLimit: string;
    currentExposure: string;
    maxBet: string;
    maxPayout: string;
  };
  accounts: PlayerAccount[];
  editingPlayerAccountId?: string | null;
}) {
  const username = form.username.trim();
  const displayName = form.displayName.trim();
  const cashBalance = Number(form.cashBalance || 0);
  const creditLimit = Number(form.creditLimit || 0);
  const currentExposure = Number(form.currentExposure || 0);
  const maxBet = form.maxBet === "" ? undefined : Number(form.maxBet);
  const maxPayout = form.maxPayout === "" ? undefined : Number(form.maxPayout);

  if (!form.accountType || !username || !displayName || !form.status) {
    return invalid("Please enter account type, username, display name, and status.");
  }

  if (
    accounts.some(
      (account) =>
        account.id !== editingPlayerAccountId &&
        account.username.trim().toLowerCase() === username.toLowerCase()
    )
  ) {
    return invalid("An account with this username already exists.");
  }

  if (
    Number.isNaN(cashBalance) ||
    Number.isNaN(creditLimit) ||
    Number.isNaN(currentExposure) ||
    Number.isNaN(maxBet ?? 0) ||
    Number.isNaN(maxPayout ?? 0)
  ) {
    return invalid(
      "Cash, credit, exposure, max bet, and max payout values must be numeric."
    );
  }

  if (form.accountType === "super_master" && form.parentId) {
    return invalid("Super master accounts cannot have a parent account.");
  }

  if (editingPlayerAccountId && form.parentId === editingPlayerAccountId) {
    return invalid("An account cannot be assigned as its own parent.");
  }

  if (
    editingPlayerAccountId &&
    wouldCreateHierarchyCycle(accounts, editingPlayerAccountId, form.parentId || null)
  ) {
    return invalid("This parent assignment would create a hierarchy cycle.");
  }

  const existingAccount = accounts.find(
    (account) => account.id === editingPlayerAccountId
  );
  const hasChildAccounts =
    !!existingAccount &&
    accounts.some((account) => account.parentId === existingAccount.id);

  if (
    hasChildAccounts &&
    existingAccount?.accountType === "super_master" &&
    form.accountType !== "super_master"
  ) {
    return invalid("Cannot change a super master type while it has downline accounts.");
  }

  if (
    hasChildAccounts &&
    existingAccount?.accountType === "master_agent" &&
    form.accountType !== "master_agent"
  ) {
    return invalid("Cannot change a master agent type while it has downline accounts.");
  }

  if (
    hasChildAccounts &&
    existingAccount?.accountType === "agent" &&
    form.accountType !== "agent"
  ) {
    return invalid("Cannot change an agent type while it has players.");
  }

  if (form.accountType === "master_agent") {
    const parentAccount = accounts.find((account) => account.id === form.parentId);

    if (
      !parentAccount ||
      !["super_master", "master_agent"].includes(parentAccount.accountType)
    ) {
      return invalid("Master agents must be assigned to a super master or master agent.");
    }
  }

  if (form.accountType === "agent") {
    const parentAccount = accounts.find((account) => account.id === form.parentId);

    if (!parentAccount || parentAccount.accountType !== "master_agent") {
      return invalid("Agents must be assigned to a master agent.");
    }
  }

  if (form.accountType === "player") {
    const parentAccount = accounts.find((account) => account.id === form.parentId);

    if (!parentAccount || parentAccount.accountType !== "agent") {
      return invalid("Players must be assigned to an agent.");
    }
  }

  return valid();
}

export function validateAccountDelete(account: PlayerAccount | undefined, childCount: number) {
  if (!account) {
    return invalid("Account not found.");
  }

  if (childCount > 0) {
    return invalid("Cannot delete an account that has child accounts.");
  }

  return valid();
}
