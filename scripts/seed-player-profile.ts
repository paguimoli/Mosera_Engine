import { findAccountByCode } from "../src/domains/accounts/account.repository";
import {
  createPlayerProfile,
  updatePlayerProfile,
} from "../src/domains/players/player-profile.service";
import { findPlayerProfileByAccountId } from "../src/domains/players/player-profile.repository";

const PLAYER_PROFILE = {
  displayName: "Player 1",
  firstName: "Player",
  lastName: "One",
  email: "player1@example.test",
  status: "ACTIVE" as const,
};

async function main() {
  const account = await findAccountByCode("PLAYER1");

  if (!account) {
    throw new Error("PLAYER1 account is required before seeding player profile.");
  }

  const existingProfile = await findPlayerProfileByAccountId(account.id);
  const playerProfile = existingProfile
    ? await updatePlayerProfile(existingProfile.id, PLAYER_PROFILE)
    : await createPlayerProfile({
        accountId: account.id,
        ...PLAYER_PROFILE,
      });

  console.log("Player profile seeded successfully.");
  console.log(`Account: ${account.accountCode}`);
  console.log(`Display Name: ${playerProfile.displayName}`);
}

main().catch((error: unknown) => {
  console.error("Supabase player profile seed error:", error);
  console.error(
    error instanceof Error ? error.message : "Player profile seed failed."
  );
  process.exit(1);
});
