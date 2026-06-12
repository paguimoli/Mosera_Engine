import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import type { LedgerTransaction } from "../ledger/ledger.types";
import {
  saveWallet,
  saveWallets,
} from "./wallet.repository";
import {
  calculateAccountWalletSummary,
  createDefaultWalletsForAccount,
  createWalletPayload,
} from "./wallet.service";
import type { Wallet } from "./wallet.types";
import { validateWallet } from "./wallet.validation";

export function createWalletController({
  form,
  wallets,
}: {
  form: Parameters<typeof createWalletPayload>[0];
  wallets: Wallet[];
}) {
  const wallet = createWalletPayload(form);
  const validation = validateWallet(wallet);

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  return controllerSuccess({
    wallet,
    wallets: saveWallet(wallets, wallet),
  });
}

export function createDefaultWalletsForAccountController({
  accountId,
  currency,
  wallets,
}: {
  accountId: string;
  currency?: string | null;
  wallets: Wallet[];
}) {
  const newWallets = createDefaultWalletsForAccount({ accountId, currency });
  const validationErrors = newWallets.flatMap((wallet) => {
    const validation = validateWallet(wallet);

    return validation.valid ? [] : validation.errors;
  });

  if (validationErrors.length > 0) {
    return controllerFailure(validationErrors);
  }

  return controllerSuccess({
    wallets: saveWallets(wallets, newWallets),
    createdWallets: newWallets,
  });
}

export function getWalletSummaryController({
  accountId,
  wallets,
  transactions,
}: {
  accountId: string;
  wallets: Wallet[];
  transactions: LedgerTransaction[];
}) {
  if (!accountId) {
    return controllerFailure("Account id is required.");
  }

  return controllerSuccess({
    summary: calculateAccountWalletSummary({
      accountId,
      wallets,
      transactions,
    }),
  });
}
