import type { Wallet, WalletType } from "./wallet.types";

export function saveWallet(wallets: Wallet[], wallet: Wallet) {
  return [...wallets, wallet];
}

export function saveWallets(wallets: Wallet[], newWallets: Wallet[]) {
  return [...wallets, ...newWallets];
}

export function updateWallet(wallets: Wallet[], wallet: Wallet) {
  return wallets.map((createdWallet) =>
    createdWallet.id === wallet.id ? wallet : createdWallet
  );
}

export function findWalletById(wallets: Wallet[], walletId: string) {
  return wallets.find((wallet) => wallet.id === walletId);
}

export function listWalletsByAccountId(wallets: Wallet[], accountId: string) {
  return wallets.filter((wallet) => wallet.accountId === accountId);
}

export function findWalletByAccountAndType({
  wallets,
  accountId,
  walletType,
}: {
  wallets: Wallet[];
  accountId: string;
  walletType: WalletType;
}) {
  return wallets.find(
    (wallet) =>
      wallet.accountId === accountId && wallet.walletType === walletType
  );
}
