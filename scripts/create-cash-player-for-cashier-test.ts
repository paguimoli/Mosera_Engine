import { findAccountByCode } from "../src/domains/accounts/account.repository";
import {
  createAccount,
  updateAccount,
} from "../src/domains/accounts/account.service";
import { findPlayerProfileByAccountId } from "../src/domains/players/player-profile.repository";
import {
  createPlayerProfile,
  updatePlayerProfile,
} from "../src/domains/players/player-profile.service";
import { provisionWalletsForAccount } from "../src/domains/wallets/wallet.service";

const CASH_PLAYER_CODE = "CASHPLAYER1";

async function main() {
  const agent = await findAccountByCode("AGENT1");

  if (!agent) {
    throw new Error("AGENT1 account is required before creating cash player.");
  }

  const accountInput = {
    accountType: "PLAYER" as const,
    accountCode: CASH_PLAYER_CODE,
    displayName: "Cash Player 1",
    parentAccountId: agent.id,
    marketId: agent.marketId,
    brandId: agent.brandId,
    fundingModel: "CASH" as const,
    defaultFundingSource: "CASH" as const,
    balanceAuthority: "INTERNAL" as const,
    settlementMode: "AUTO_SETTLEMENT" as const,
    status: "ACTIVE" as const,
  };
  const existingAccount = await findAccountByCode(CASH_PLAYER_CODE);
  const account = existingAccount
    ? await updateAccount(existingAccount.id, accountInput)
    : await createAccount(accountInput);
  const profileInput = {
    displayName: "Cash Player 1",
    email: "cashplayer1@example.test",
    status: "ACTIVE" as const,
  };
  const existingProfile = await findPlayerProfileByAccountId(account.id);
  const profile = existingProfile
    ? await updatePlayerProfile(existingProfile.id, profileInput)
    : await createPlayerProfile({
        accountId: account.id,
        ...profileInput,
      });
  const wallets = await provisionWalletsForAccount(account.id);

  console.log("Cashier test cash player ready.");
  console.log(`Account: ${account.accountCode}`);
  console.log(`Profile: ${profile.displayName}`);
  console.log(`Wallets: ${wallets.map((wallet) => wallet.walletType).join(", ")}`);
}

main().catch((error: unknown) => {
  console.error("Supabase cashier cash player script error:", error);
  console.error(
    error instanceof Error
      ? error.message
      : "Cashier cash player script failed."
  );
  process.exit(1);
});
