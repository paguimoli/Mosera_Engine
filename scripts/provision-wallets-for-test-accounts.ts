import { findAccountByCode } from "../src/domains/accounts/account.repository";
import { updateAccount } from "../src/domains/accounts/account.service";
import type {
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
} from "../src/domains/accounts/account.types";
import { provisionWalletsForAccount } from "../src/domains/wallets/wallet.service";

type TestAccountConfig = {
  accountCode: string;
  fundingModel: AccountFundingModel;
  defaultFundingSource: AccountDefaultFundingSource;
  operatingMode?: AccountOperatingMode | null;
};

const TEST_ACCOUNT_CONFIGS: TestAccountConfig[] = [
  {
    accountCode: "PLATFORM",
    fundingModel: "CASH",
    defaultFundingSource: "CASH",
  },
  {
    accountCode: "MASTER1",
    fundingModel: "CREDIT",
    defaultFundingSource: "CREDIT",
    operatingMode: "CREDIT_EXPOSURE",
  },
  {
    accountCode: "AGENT1",
    fundingModel: "CREDIT",
    defaultFundingSource: "CREDIT",
    operatingMode: "CREDIT_EXPOSURE",
  },
  {
    accountCode: "PLAYER1",
    fundingModel: "CREDIT",
    defaultFundingSource: "CREDIT",
  },
];

async function provisionTestAccount(config: TestAccountConfig) {
  const account = await findAccountByCode(config.accountCode);

  if (!account) {
    console.log(`Skipped ${config.accountCode}: account not found.`);
    return;
  }

  const configuredAccount = await updateAccount(account.id, {
    fundingModel: account.fundingModel ?? config.fundingModel,
    defaultFundingSource:
      account.defaultFundingSource ?? config.defaultFundingSource,
    operatingMode: account.operatingMode ?? config.operatingMode ?? null,
    balanceAuthority: account.balanceAuthority ?? "INTERNAL",
    weeklyAccountingMode: account.weeklyAccountingMode ?? "ZERO_BALANCE",
    settlementMode: account.settlementMode ?? "AUTO_SETTLEMENT",
  });
  const wallets = await provisionWalletsForAccount(configuredAccount.id);

  console.log(
    `Provisioned ${wallets.length} wallet(s) for ${configuredAccount.accountCode}.`
  );
}

async function main() {
  for (const config of TEST_ACCOUNT_CONFIGS) {
    await provisionTestAccount(config);
  }
}

main().catch((error: unknown) => {
  console.error("Supabase wallet provisioning error:", error);
  console.error(
    error instanceof Error ? error.message : "Wallet provisioning failed."
  );
  process.exit(1);
});
