import { findAccountByCode } from "../src/domains/accounts/account.repository";
import { requestDeposit } from "../src/domains/cashier/cashier.service";
import { findPersistedWalletByAccountAndType } from "../src/domains/wallets/wallet.repository";

const TEST_DEPOSIT_AMOUNT = 100;

async function main() {
  const account = await findAccountByCode("PLAYER1");

  if (!account) {
    throw new Error("PLAYER1 account is required before creating test deposit.");
  }

  const cashWallet = await findPersistedWalletByAccountAndType(
    account.id,
    "CASH"
  );

  if (!cashWallet) {
    console.log(
      "PLAYER1 has no CASH wallet; cashier deposit test requires CASH or HYBRID funding model."
    );
    return;
  }

  const transaction = await requestDeposit({
    accountId: account.id,
    walletId: cashWallet.id,
    transactionType: "DEPOSIT",
    amount: TEST_DEPOSIT_AMOUNT,
    currencyCode: cashWallet.currencyCode ?? cashWallet.currency ?? "",
    paymentMethod: "manual_test",
    provider: "internal",
    providerReference: `TEST-DEPOSIT-${Date.now()}`,
    metadata: {
      source: "create-test-cashier-deposit",
    },
  });

  console.log("Test cashier deposit created.");
  console.log(`Account: ${account.accountCode}`);
  console.log(`Transaction: ${transaction.id}`);
  console.log(`Status: ${transaction.status}`);
}

main().catch((error: unknown) => {
  console.error("Supabase cashier deposit script error:", error);
  console.error(
    error instanceof Error ? error.message : "Cashier deposit script failed."
  );
  process.exit(1);
});
