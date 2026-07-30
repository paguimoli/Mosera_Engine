import { createHash, randomUUID } from "node:crypto";

import {
  resolveAccountAncestors,
  resolveAccountDescendants,
  resolveCanonicalMarketScope,
} from "../hierarchy/canonical-hierarchy-authority";
import { LedgerServiceCompensationGateway } from "../financial-authority/compensation-ledger.gateway";
import { resolveFundingInstrument } from "../financial-authority/funding-instrument-authority";
import type { CompensationLedgerGateway } from "./compensation-ledger.gateway";
import {
  appendCalculatedEntitlement,
  appendCompensationEvent,
  appendCompensationReversalEntitlement,
  claimCompensationExecution,
  createCompensationConfigurationRecord,
  findCompensationEntitlementForReversal,
  findCompensationPeriod,
  getAuthoritativeSettledNetResult,
  hasPostedCompensationEntitlement,
  listCompensationEntitlements,
  listEligibleCompensationConfigurations,
} from "./compensation.repository";
import { resolveCompensationStrategy } from "./compensation-strategy";
import type {
  CompensationConfiguration,
  CompensationExecutionResult,
  CreateCompensationConfigurationInput,
} from "./compensation.types";

export class CompensationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompensationAuthorityError";
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(canonicalize(value))
    .digest("hex")}`;
}

function validateConfiguration(input: CreateCompensationConfigurationInput) {
  if (!["COMMISSION", "REBATE"].includes(input.strategy)) {
    throw new CompensationAuthorityError(
      "Only Commission and Rebate strategies are supported."
    );
  }
  if (input.calculationBasis !== "NET_LOSS") {
    throw new CompensationAuthorityError(
      "Launch compensation supports NET_LOSS only."
    );
  }
  if (
    !Number.isInteger(input.rateBasisPoints) ||
    input.rateBasisPoints < 0 ||
    input.rateBasisPoints > 10_000
  ) {
    throw new CompensationAuthorityError(
      "Compensation rate must be between 0 and 10000 basis points."
    );
  }
  if (
    !Number.isSafeInteger(input.minimumThresholdMinor) ||
    input.minimumThresholdMinor < 0 ||
    (input.maximumCompensationMinor !== null &&
      (!Number.isSafeInteger(input.maximumCompensationMinor) ||
        input.maximumCompensationMinor < 0))
  ) {
    throw new CompensationAuthorityError(
      "Compensation thresholds must be non-negative integer minor units."
    );
  }
  if (
    input.fundingInstrument !== "CREDIT" &&
    input.fundingInstrument !== "FREE_PLAY"
  ) {
    throw new CompensationAuthorityError(
      "Only CREDIT and FREE_PLAY compensation funding instruments are enabled."
    );
  }
}

export async function createCompensationConfiguration(
  input: CreateCompensationConfigurationInput
): Promise<CompensationConfiguration> {
  validateConfiguration(input);
  const [ancestors, descendants] = await Promise.all([
    resolveAccountAncestors(input.hierarchyOwnerAccountId),
    resolveAccountDescendants(
    input.hierarchyOwnerAccountId
    ),
  ]);
  if (ancestors.hierarchyAccountIds.length === 0) {
    throw new CompensationAuthorityError(
      "Compensation hierarchy owner was not found."
    );
  }
  const owner = ancestors.ancestors[0];
  const beneficiary =
    input.beneficiaryAccountId === input.hierarchyOwnerAccountId
      ? owner
      : descendants.find(
          (node) => node.accountId === input.beneficiaryAccountId
        );
  if (!beneficiary) {
    throw new CompensationAuthorityError(
      "Compensation beneficiary must belong to the hierarchy owner."
    );
  }
  if (
    input.strategy === "COMMISSION" &&
    (input.beneficiaryAccountId !== input.hierarchyOwnerAccountId ||
      !["MASTER_AGENT", "AGENT"].includes(owner.accountType))
  ) {
    throw new CompensationAuthorityError(
      "Launch Commission beneficiaries must be the configured Master Agent or Agent hierarchy owner."
    );
  }
  if (
    input.strategy === "REBATE" &&
    (input.beneficiaryAccountId !== input.hierarchyOwnerAccountId ||
      beneficiary.accountType !== "PLAYER")
  ) {
    throw new CompensationAuthorityError(
      "Launch Rebate beneficiaries must be the configured Player hierarchy owner."
    );
  }

  const canonicalInput = {
    ...input,
    effectiveFrom: new Date(input.effectiveFrom).toISOString(),
    effectiveTo: input.effectiveTo
      ? new Date(input.effectiveTo).toISOString()
      : null,
  };
  const canonicalRequestHash = hash(canonicalInput);
  return createCompensationConfigurationRecord({
    ...canonicalInput,
    canonicalRequestHash,
    contentHash: hash({
      ...canonicalInput,
      idempotencyKey: undefined,
      auditMetadata: undefined,
    }),
  });
}

export async function executeWeeklyCompensation(
  input: {
    accountingPeriodId: string;
    idempotencyKey?: string;
    correlationId?: string;
  },
  ledgerGateway: CompensationLedgerGateway =
    new LedgerServiceCompensationGateway()
): Promise<CompensationExecutionResult> {
  const period = await findCompensationPeriod(input.accountingPeriodId);
  if (!period) {
    throw new CompensationAuthorityError("Accounting period was not found.");
  }
  if (period.status !== "CLOSED") {
    throw new CompensationAuthorityError(
      "Compensation executes only after authoritative weekly close."
    );
  }
  const scope = await resolveCanonicalMarketScope(period.marketId);
  if (
    !scope ||
    scope.brandId !== period.brandId
  ) {
    throw new CompensationAuthorityError(
      "Accounting period hierarchy scope is invalid."
    );
  }

  const idempotencyKey =
    input.idempotencyKey ?? `weekly-compensation:${period.id}`;
  const canonicalRequestHash = hash({
    accountingPeriodId: period.id,
    periodEndsAt: period.endsAt,
    strategySet: ["COMMISSION", "REBATE"],
  });
  const executionId = await claimCompensationExecution({
    periodId: period.id,
    idempotencyKey,
    canonicalRequestHash,
    correlationId: input.correlationId ?? randomUUID(),
  });

  const configurations =
    await listEligibleCompensationConfigurations(period);
  for (const configuration of configurations) {
    const settledNetResultMinor = await getAuthoritativeSettledNetResult(
      configuration,
      period
    );
    const calculation = resolveCompensationStrategy(
      configuration.strategy
    ).calculate(configuration, settledNetResultMinor);
    if (calculation.compensationAmountMinor === 0) continue;

    const funding = await resolveFundingInstrument({
      playerAccountId: configuration.beneficiaryAccountId,
      requestedInstrument: configuration.fundingInstrument,
      operation: "COMPENSATION",
      idempotencyKey: `compensation-funding:${period.id}:${configuration.id}`,
      correlationId: input.correlationId ?? executionId,
    });
    const canonicalEntitlementHash = hash({
      accountingPeriodId: period.id,
      beneficiaryAccountId: configuration.beneficiaryAccountId,
      calculation,
      configurationHash: configuration.contentHash,
      currency: funding.currency,
      fundingInstrument: funding.instrument,
      fundingResolutionHash: funding.canonicalResolutionHash,
      hierarchyOwnerAccountId: configuration.hierarchyOwnerAccountId,
    });
    const entitlement = await appendCalculatedEntitlement({
      entitlement: {
        executionId,
        configurationId: configuration.id,
        accountingPeriodId: period.id,
        tenantId: scope.tenantId,
        brandId: scope.brandId,
        marketId: scope.marketId,
        hierarchyOwnerAccountId: configuration.hierarchyOwnerAccountId,
        beneficiaryAccountId: configuration.beneficiaryAccountId,
        currency: funding.currency,
        fundingInstrument: funding.instrument,
        walletId: funding.walletId,
        canonicalEntitlementHash,
        reversalOfEntitlementId: null,
        ...calculation,
      },
    });
    await appendCompensationEvent({
      executionId,
      entitlementId: entitlement.id,
      eventType: "CALCULATED",
      evidenceHash: hash({
        entitlementHash: entitlement.canonicalEntitlementHash,
        event: "CALCULATED",
      }),
    });

    if (!(await hasPostedCompensationEntitlement(entitlement.id))) {
      try {
        const posting = await ledgerGateway.postEntitlement(entitlement);
        await appendCompensationEvent({
          executionId,
          entitlementId: entitlement.id,
          eventType: "POSTED",
          ledgerEntryId: posting.ledgerEntryId,
          evidenceHash: hash({
            entitlementHash: entitlement.canonicalEntitlementHash,
            ledgerEntryId: posting.ledgerEntryId,
            ledgerRequestHash: posting.canonicalRequestHash,
          }),
        });
      } catch (error) {
        await appendCompensationEvent({
          executionId,
          entitlementId: entitlement.id,
          eventType: "FAILED",
          evidenceHash: hash({
            entitlementHash: entitlement.canonicalEntitlementHash,
            error: error instanceof Error ? error.message : String(error),
          }),
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }
  }

  await appendCompensationEvent({
    executionId,
    eventType: "COMPLETED",
    evidenceHash: hash({
      accountingPeriodId: period.id,
      event: "COMPLETED",
      executionId,
    }),
  });
  return {
    executionId,
    accountingPeriodId: period.id,
    status: "COMPLETED",
    entitlements: await listCompensationEntitlements(executionId),
  };
}

export async function reverseCompensationEntitlement(
  input: {
    entitlementId: string;
    reasonCode: "CORRECTION" | "OPERATOR_CORRECTION" | "VOID";
    idempotencyKey?: string;
    correlationId?: string;
  },
  ledgerGateway: CompensationLedgerGateway =
    new LedgerServiceCompensationGateway()
) {
  const original = await findCompensationEntitlementForReversal(
    input.entitlementId
  );
  if (!original) {
    throw new CompensationAuthorityError(
      "Posted compensation entitlement was not found."
    );
  }
  const executionId = await claimCompensationExecution({
    periodId: original.entitlement.accountingPeriodId,
    idempotencyKey:
      input.idempotencyKey ?? `compensation-reversal:${original.entitlement.id}`,
    canonicalRequestHash: hash({
      entitlementHash: original.entitlement.canonicalEntitlementHash,
      reasonCode: input.reasonCode,
    }),
    correlationId: input.correlationId ?? randomUUID(),
  });
  const reversal = await appendCompensationReversalEntitlement({
    original: original.entitlement,
    executionId,
    canonicalEntitlementHash: hash({
      originalEntitlementHash: original.entitlement.canonicalEntitlementHash,
      reasonCode: input.reasonCode,
      type: "REVERSAL",
    }),
  });
  if (!(await hasPostedCompensationEntitlement(reversal.id))) {
    const posting = await ledgerGateway.reverseEntitlement(
      reversal,
      original.ledgerEntryId,
      original.ledgerEntryHash,
      input.reasonCode
    );
    await appendCompensationEvent({
      executionId,
      entitlementId: reversal.id,
      eventType: "REVERSED",
      ledgerEntryId: posting.ledgerEntryId,
      evidenceHash: hash({
        ledgerEntryId: posting.ledgerEntryId,
        originalEntitlementHash:
          original.entitlement.canonicalEntitlementHash,
        reversalEntitlementHash: reversal.canonicalEntitlementHash,
      }),
      metadata: { reasonCode: input.reasonCode },
    });
  }
  return reversal;
}
