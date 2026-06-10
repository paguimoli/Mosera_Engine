import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import type { Market } from "../markets/market.types";
import { findMarketById } from "../markets/market.repository";
import {
  deleteAccount,
  findAccountById,
  listAccountsByParentId,
  saveAccount,
  updateAccount,
} from "./account.repository";
import type { PlayerAccount } from "./account.types";
import {
  validateAccountDelete,
  validatePlayerAccountForm,
} from "./account.validation";

export function saveAccountController({
  form,
  accounts,
  markets,
  editingAccountId,
}: {
  form: {
    accountType: PlayerAccount["accountType"];
    parentId: string;
    username: string;
    displayName: string;
    email: string;
    phone: string;
    marketId: string;
    language: string;
    currency: string;
    status: PlayerAccount["status"];
    cashBalance: string;
    creditLimit: string;
    currentExposure: string;
    maxBet: string;
    maxPayout: string;
    notes: string;
  };
  accounts: PlayerAccount[];
  markets: Market[];
  editingAccountId?: string | null;
}) {
  const validation = validatePlayerAccountForm({
    form,
    accounts,
    editingPlayerAccountId: editingAccountId,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const existingAccount = editingAccountId
    ? findAccountById(accounts, editingAccountId)
    : undefined;
  const selectedMarket = form.marketId
    ? findMarketById(markets, form.marketId)
    : undefined;
  const creditLimit = Number(form.creditLimit || 0);
  const currentExposure = Number(form.currentExposure || 0);
  const account: PlayerAccount = {
    id: existingAccount?.id || `ACCOUNT-${Date.now()}`,
    accountType: form.accountType,
    parentId: form.accountType === "super_master" ? null : form.parentId,
    username: form.username.trim(),
    displayName: form.displayName.trim(),
    email: form.email.trim(),
    phone: form.phone.trim(),
    marketId: form.marketId || null,
    language: form.language.trim() || selectedMarket?.language || "",
    currency: form.currency.trim() || selectedMarket?.currency || "USD",
    status: form.status,
    cashBalance: Number(form.cashBalance || 0),
    creditLimit,
    currentExposure,
    availableCredit: creditLimit - currentExposure,
    maxBet: form.maxBet === "" ? undefined : Number(form.maxBet),
    maxPayout: form.maxPayout === "" ? undefined : Number(form.maxPayout),
    notes: form.notes.trim(),
    createdAt: existingAccount?.createdAt || new Date().toISOString(),
  };

  return controllerSuccess({
    account,
    accounts: editingAccountId
      ? updateAccount(accounts, account)
      : saveAccount(accounts, account),
  });
}

export function deleteAccountController({
  accountId,
  accounts,
}: {
  accountId: string;
  accounts: PlayerAccount[];
}) {
  const account = findAccountById(accounts, accountId);
  const validation = validateAccountDelete(
    account,
    account ? listAccountsByParentId(accounts, account.id).length : 0
  );

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  return controllerSuccess({
    accounts: deleteAccount(accounts, accountId),
  });
}

export const createAccountController = saveAccountController;
export const updateAccountController = saveAccountController;
export const moveAccountController = saveAccountController;
