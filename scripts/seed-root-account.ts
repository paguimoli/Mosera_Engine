import {
  createAccount,
  updateAccount,
} from "../src/domains/accounts/account.service";
import { findAccountByCode } from "../src/domains/accounts/account.repository";
import { getDefaultBrand } from "../src/domains/brands/brand.repository";
import { getDefaultMarket } from "../src/domains/markets/market.repository";

const ROOT_ACCOUNT = {
  accountType: "SUPER_MASTER" as const,
  accountCode: "PLATFORM",
  displayName: "Platform Super Master",
  parentAccountId: null,
  status: "ACTIVE" as const,
};

async function main() {
  const defaultMarket = await getDefaultMarket();
  const defaultBrand = await getDefaultBrand();

  if (!defaultMarket) {
    throw new Error("Default market is required before seeding root account.");
  }

  if (!defaultBrand) {
    throw new Error("Default brand is required before seeding root account.");
  }

  const accountInput = {
    ...ROOT_ACCOUNT,
    marketId: defaultMarket.id,
    brandId: defaultBrand.id,
  };
  const existingAccount = await findAccountByCode(ROOT_ACCOUNT.accountCode);
  const account = existingAccount
    ? await updateAccount(existingAccount.id, accountInput)
    : await createAccount(accountInput);

  console.log("Root account seeded successfully.");
  console.log(`Code: ${account.accountCode}`);
  console.log(`Name: ${account.displayName}`);
}

main().catch((error: unknown) => {
  console.error("Supabase root account seed error:", error);
  console.error(
    error instanceof Error ? error.message : "Root account seed failed."
  );
  process.exit(1);
});
