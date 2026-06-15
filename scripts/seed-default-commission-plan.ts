import {
  addCommissionPlanRule,
  createPersistedCommissionPlan,
  listRulesForCommissionPlan,
} from "../src/domains/commissions/commission.service";
import { findCommissionPlanByCode } from "../src/domains/commissions/commission.repository";

const DEFAULT_COMMISSION_PLAN = {
  code: "PPH_NET_LOSS_30",
  name: "PPH Net Loss 30%",
  description: "30% commission on net player loss.",
  calculationBasis: "NET_LOSS" as const,
  status: "ACTIVE" as const,
};

const DEFAULT_COMMISSION_RULE = {
  ruleType: "NET_LOSS_PERCENT" as const,
  rate: 30,
  appliesToAccountType: "AGENT" as const,
};

async function main() {
  const existingPlan = await findCommissionPlanByCode(
    DEFAULT_COMMISSION_PLAN.code
  );
  const plan =
    existingPlan ?? (await createPersistedCommissionPlan(DEFAULT_COMMISSION_PLAN));
  const existingRules = await listRulesForCommissionPlan(plan.id);
  const matchingRule = existingRules.find(
    (rule) =>
      rule.ruleType === DEFAULT_COMMISSION_RULE.ruleType &&
      rule.appliesToAccountType ===
        DEFAULT_COMMISSION_RULE.appliesToAccountType &&
      rule.rate === DEFAULT_COMMISSION_RULE.rate
  );

  if (!matchingRule) {
    await addCommissionPlanRule({
      commissionPlanId: plan.id,
      ...DEFAULT_COMMISSION_RULE,
    });
  }

  console.log("Default commission plan seeded successfully.");
  console.log(`Code: ${plan.code}`);
  console.log(`Name: ${plan.name}`);
}

main().catch((error: unknown) => {
  console.error("Supabase commission plan seed error:", error);
  console.error(
    error instanceof Error ? error.message : "Commission plan seed failed."
  );
  process.exit(1);
});
