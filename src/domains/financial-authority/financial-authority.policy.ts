import type {
  CanonicalFinancialOperatingMode,
  CanonicalFundingInstrument,
  FinancialAccountPolicy,
} from "./financial-authority.types";

export class FinancialAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialAuthorityError";
  }
}

export function resolveFinancialOperatingMode(
  policy: FinancialAccountPolicy
): CanonicalFinancialOperatingMode {
  const accountId = policy.accountId ?? policy.id ?? "unknown";
  if (policy.operatingMode === "COMMISSION") return "COMMISSION";
  if (
    policy.operatingMode === "CREDIT_EXPOSURE" ||
    policy.fundingModel === "CREDIT" ||
    policy.fundingModel === "HYBRID"
  ) {
    return "CREDIT";
  }
  throw new FinancialAuthorityError(
    `Account ${accountId} has no supported financial operating mode.`
  );
}

export function assertFinancialOperatingMode(
  policy: FinancialAccountPolicy,
  requiredMode: CanonicalFinancialOperatingMode
) {
  const accountId = policy.accountId ?? policy.id ?? "unknown";
  const actualMode = resolveFinancialOperatingMode(policy);
  if (actualMode !== requiredMode) {
    throw new FinancialAuthorityError(
      `Financial operation requires ${requiredMode} mode; account ${accountId} is ${actualMode}.`
    );
  }
  return actualMode;
}

export function assertFundingInstrument(
  instrument: CanonicalFundingInstrument
) {
  if (instrument !== "CREDIT") {
    throw new FinancialAuthorityError(
      `${instrument} is architecture-supported but not enabled for launch.`
    );
  }
  return instrument;
}
