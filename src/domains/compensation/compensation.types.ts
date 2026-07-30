export type CompensationStrategyType = "COMMISSION" | "REBATE";
export type CompensationCalculationBasis = "NET_LOSS";
export type CompensationFundingInstrument = "CREDIT" | "FREE_PLAY";

export type CompensationConfiguration = {
  id: string;
  hierarchyOwnerAccountId: string;
  beneficiaryAccountId: string;
  strategy: CompensationStrategyType;
  calculationBasis: CompensationCalculationBasis;
  rateBasisPoints: number;
  accountingPeriod: "WEEKLY";
  minimumThresholdMinor: number;
  maximumCompensationMinor: number | null;
  fundingInstrument: CompensationFundingInstrument;
  effectiveFrom: string;
  effectiveTo: string | null;
  enabled: boolean;
  sourceConfigurationReference: string | null;
  idempotencyKey: string;
  canonicalRequestHash: string;
  contentHash: string;
  auditMetadata: Record<string, unknown>;
  createdAt: string;
};

export type CreateCompensationConfigurationInput = Omit<
  CompensationConfiguration,
  "id" | "canonicalRequestHash" | "contentHash" | "createdAt"
>;

export type CompensationPeriod = {
  id: string;
  brandId: string;
  marketId: string;
  startsAt: string;
  endsAt: string;
  status: "OPEN" | "CLOSED";
};

export type CompensationEntitlement = {
  id: string;
  executionId: string;
  configurationId: string;
  accountingPeriodId: string;
  tenantId: string;
  brandId: string;
  marketId: string;
  hierarchyOwnerAccountId: string;
  beneficiaryAccountId: string;
  strategy: CompensationStrategyType;
  reportingClassification: CompensationStrategyType;
  calculationBasis: CompensationCalculationBasis;
  basisAmountMinor: number;
  rateBasisPoints: number;
  compensationAmountMinor: number;
  currency: string;
  fundingInstrument: "CREDIT";
  walletId: string;
  ledgerTransactionType:
    | "AGENT_COMMISSION_ACCRUAL"
    | "PLAYER_REBATE_CREDIT";
  canonicalEntitlementHash: string;
  reversalOfEntitlementId: string | null;
  createdAt: string;
};

export type CompensationCalculation = Pick<
  CompensationEntitlement,
  | "strategy"
  | "reportingClassification"
  | "calculationBasis"
  | "basisAmountMinor"
  | "rateBasisPoints"
  | "compensationAmountMinor"
  | "ledgerTransactionType"
>;

export type CompensationExecutionResult = {
  executionId: string;
  accountingPeriodId: string;
  status: "COMPLETED";
  entitlements: CompensationEntitlement[];
};

export type CompensationLedgerPosting = {
  ledgerEntryId: string;
  canonicalRequestHash: string;
};
