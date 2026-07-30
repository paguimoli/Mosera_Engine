import {
  CommissionCompensationStrategy,
  RebateCompensationStrategy,
  compensationStrategyReadiness,
  resolveCompensationStrategy,
} from "../../src/domains/compensation/compensation-strategy";
import type { CompensationConfiguration } from "../../src/domains/compensation/compensation.types";

const checks: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(message);
}

const base: CompensationConfiguration = {
  id: "configuration",
  hierarchyOwnerAccountId: "owner",
  beneficiaryAccountId: "beneficiary",
  strategy: "COMMISSION",
  calculationBasis: "NET_LOSS",
  rateBasisPoints: 1_000,
  accountingPeriod: "WEEKLY",
  minimumThresholdMinor: 100,
  maximumCompensationMinor: 2_000,
  fundingInstrument: "CREDIT",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  enabled: true,
  sourceConfigurationReference: "commission-plan:launch",
  idempotencyKey: "configuration",
  canonicalRequestHash: "sha256:test",
  contentHash: "sha256:test",
  auditMetadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

const commission = new CommissionCompensationStrategy().calculate(base, -15_000);
assert(commission.compensationAmountMinor === 1_500, "Commission NET_LOSS calculation is deterministic.");
assert(commission.ledgerTransactionType === "AGENT_COMMISSION_ACCRUAL", "Commission uses its own ledger classification.");
assert(commission.reportingClassification === "COMMISSION", "Commission reporting remains separate.");

const rebate = new RebateCompensationStrategy().calculate(
  { ...base, strategy: "REBATE", sourceConfigurationReference: null },
  -30_000
);
assert(rebate.compensationAmountMinor === 2_000, "Rebate NET_LOSS calculation honors the configured cap.");
assert(rebate.ledgerTransactionType === "PLAYER_REBATE_CREDIT", "Rebate uses its own ledger classification.");
assert(rebate.reportingClassification === "REBATE", "Rebate reporting remains separate.");

const freePlayCommission = new CommissionCompensationStrategy().calculate(
  { ...base, fundingInstrument: "FREE_PLAY" },
  -15_000
);
assert(
  freePlayCommission.ledgerTransactionType === "FREE_PLAY_CREDIT",
  "FREE_PLAY Commission uses the shared compensation strategy with a distinct Ledger classification."
);
const freePlayRebate = new RebateCompensationStrategy().calculate(
  { ...base, strategy: "REBATE", fundingInstrument: "FREE_PLAY" },
  -15_000
);
assert(
  freePlayRebate.ledgerTransactionType === "FREE_PLAY_CREDIT" &&
    freePlayRebate.reportingClassification === "REBATE",
  "FREE_PLAY Rebate preserves independent Rebate reporting."
);

const noLoss = resolveCompensationStrategy("REBATE").calculate(
  { ...base, strategy: "REBATE" },
  5_000
);
assert(noLoss.compensationAmountMinor === 0, "Positive settled results do not generate NET_LOSS compensation.");
assert(compensationStrategyReadiness().strategyTypes.length === 2, "Exactly two launch strategies are registered.");
assert(
  compensationStrategyReadiness().fundingInstruments.join(",") ===
    "CREDIT,FREE_PLAY",
  "CREDIT and FREE_PLAY are the exact enabled launch funding instruments."
);

console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
