import type {
  CompensationCalculation,
  CompensationConfiguration,
  CompensationStrategyType,
} from "./compensation.types";

export class CompensationStrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompensationStrategyError";
  }
}

export interface CompensationStrategy {
  readonly type: CompensationStrategyType;
  calculate(
    configuration: CompensationConfiguration,
    settledNetResultMinor: number
  ): CompensationCalculation;
}

function calculateNetLossCompensation(
  configuration: CompensationConfiguration,
  settledNetResultMinor: number
) {
  if (configuration.calculationBasis !== "NET_LOSS") {
    throw new CompensationStrategyError(
      "Launch compensation strategies support NET_LOSS only."
    );
  }
  if (!Number.isSafeInteger(settledNetResultMinor)) {
    throw new CompensationStrategyError(
      "Settled activity must be expressed as safe integer minor units."
    );
  }

  const basisAmountMinor = Math.max(0, -settledNetResultMinor);
  const rawAmount = Math.floor(
    (basisAmountMinor * configuration.rateBasisPoints) / 10_000
  );
  const thresholdedAmount =
    rawAmount < configuration.minimumThresholdMinor ? 0 : rawAmount;
  const compensationAmountMinor =
    configuration.maximumCompensationMinor === null
      ? thresholdedAmount
      : Math.min(thresholdedAmount, configuration.maximumCompensationMinor);

  return { basisAmountMinor, compensationAmountMinor };
}

export class CommissionCompensationStrategy implements CompensationStrategy {
  readonly type = "COMMISSION" as const;

  calculate(
    configuration: CompensationConfiguration,
    settledNetResultMinor: number
  ): CompensationCalculation {
    const amounts = calculateNetLossCompensation(
      configuration,
      settledNetResultMinor
    );
    return {
      strategy: this.type,
      reportingClassification: "COMMISSION",
      calculationBasis: "NET_LOSS",
      rateBasisPoints: configuration.rateBasisPoints,
      ledgerTransactionType: "AGENT_COMMISSION_ACCRUAL",
      ...amounts,
    };
  }
}

export class RebateCompensationStrategy implements CompensationStrategy {
  readonly type = "REBATE" as const;

  calculate(
    configuration: CompensationConfiguration,
    settledNetResultMinor: number
  ): CompensationCalculation {
    const amounts = calculateNetLossCompensation(
      configuration,
      settledNetResultMinor
    );
    return {
      strategy: this.type,
      reportingClassification: "REBATE",
      calculationBasis: "NET_LOSS",
      rateBasisPoints: configuration.rateBasisPoints,
      ledgerTransactionType: "PLAYER_REBATE_CREDIT",
      ...amounts,
    };
  }
}

const strategies = new Map<CompensationStrategyType, CompensationStrategy>([
  ["COMMISSION", new CommissionCompensationStrategy()],
  ["REBATE", new RebateCompensationStrategy()],
]);

export function resolveCompensationStrategy(
  type: CompensationStrategyType
): CompensationStrategy {
  const strategy = strategies.get(type);
  if (!strategy) {
    throw new CompensationStrategyError(
      `Unsupported compensation strategy: ${String(type)}.`
    );
  }
  return strategy;
}

export function compensationStrategyReadiness() {
  return {
    authority: "CompensationAuthority",
    strategyTypes: [...strategies.keys()],
    exactStrategyResolution: strategies.size === 2,
    commissionReady: strategies.has("COMMISSION"),
    rebateReady: strategies.has("REBATE"),
    additionalStrategiesEnabled: false,
    fundingInstrument: "CREDIT",
    futureFundingInstrument: "FREE_PLAY",
    accountingPeriod: "WEEKLY",
  } as const;
}

