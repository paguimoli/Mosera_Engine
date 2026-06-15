import { findAccountByCode } from "../src/domains/accounts/account.repository";
import { updateAccount } from "../src/domains/accounts/account.service";
import { findCommissionPlanByCode } from "../src/domains/commissions/commission.repository";
import { assignCommissionPlanToAccount } from "../src/domains/commissions/commission.service";

const AGENT_ACCOUNT_CODE = "AGENT1";
const COMMISSION_PLAN_CODE = "PPH_NET_LOSS_30";

async function main() {
  const account = await findAccountByCode(AGENT_ACCOUNT_CODE);

  if (!account) {
    throw new Error("AGENT1 account is required before assigning commission plan.");
  }

  const plan = await findCommissionPlanByCode(COMMISSION_PLAN_CODE);

  if (!plan) {
    throw new Error(
      "PPH_NET_LOSS_30 commission plan is required before assignment."
    );
  }

  const commissionAccount =
    account.operatingMode === "COMMISSION"
      ? account
      : await updateAccount(account.id, { operatingMode: "COMMISSION" });
  const assignment = await assignCommissionPlanToAccount({
    accountId: commissionAccount.id,
    commissionPlanId: plan.id,
  });

  console.log("Commission plan assigned successfully.");
  console.log(`Account: ${commissionAccount.accountCode}`);
  console.log(`Plan: ${plan.code}`);
  console.log(`Assignment: ${assignment.id}`);
}

main().catch((error: unknown) => {
  console.error("Supabase commission assignment script error:", error);
  console.error(
    error instanceof Error
      ? error.message
      : "Commission assignment script failed."
  );
  process.exit(1);
});
