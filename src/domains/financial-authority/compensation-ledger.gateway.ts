import { createHash } from "node:crypto";

import type { CompensationLedgerGateway } from "../compensation/compensation-ledger.gateway";
import type {
  CompensationEntitlement,
  CompensationLedgerPosting,
} from "../compensation/compensation.types";

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function ledgerServiceUrl() {
  return (
    process.env.LEDGER_SERVICE_URL?.trim() || "http://ledger-service:8080"
  ).replace(/\/$/, "");
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    )
  ).replaceAll("+", "\\u002B");
}

function dotNetTimestamp(value: string) {
  return new Date(value).toISOString().replace("Z", "0000+00:00");
}

export class LedgerServiceCompensationGateway
  implements CompensationLedgerGateway
{
  async postEntitlement(
    entitlement: CompensationEntitlement
  ): Promise<CompensationLedgerPosting> {
    const originatingAuthority =
      entitlement.strategy === "COMMISSION"
        ? "commission-authority"
        : "rebate-authority";
    const idempotencyKey = `compensation:${entitlement.id}`;
    const instructionId = entitlement.id;
    const instructionHash = sha256(
      canonicalJson({
        entitlementHash: entitlement.canonicalEntitlementHash,
        entitlementId: entitlement.id,
      })
    );
    const effectiveAt = entitlement.createdAt;
    const canonicalRequestHash = sha256(
      canonicalJson({
        amountMinor: entitlement.compensationAmountMinor,
        currency: entitlement.currency,
        direction: "CREDIT",
        effectiveAt: dotNetTimestamp(effectiveAt),
        idempotencyKey,
        instructionHash,
        instructionId,
        instructionType: entitlement.ledgerTransactionType,
        ledgerAccountId: entitlement.beneficiaryAccountId,
        ledgerWalletId: entitlement.walletId,
        minorUnitPrecision: 2,
        originatingAuthority,
        postingRuleId: entitlement.ledgerTransactionType,
        postingRuleVersion: "1.0.0",
        referenceId: entitlement.id,
        referenceType: "COMPENSATION_ENTITLEMENT",
        reversalOfLedgerEntryId: null,
        settlementRecordId: null,
        transactionType: entitlement.ledgerTransactionType,
      })
    );
    const response = await fetch(`${ledgerServiceUrl()}/v1/ledger/entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        walletId: entitlement.walletId,
        ledgerAccountId: entitlement.beneficiaryAccountId,
        instructionId,
        instructionType: entitlement.ledgerTransactionType,
        instructionHash,
        originatingAuthority,
        settlementRecordId: null,
        transactionType: entitlement.ledgerTransactionType,
        direction: "CREDIT",
        money: {
          amount: entitlement.compensationAmountMinor,
          currency: entitlement.currency,
        },
        minorUnitPrecision: 2,
        canonicalRequestHash,
        effectiveAt,
        reference: {
          type: "COMPENSATION_ENTITLEMENT",
          id: entitlement.id,
        },
        reversalOfLedgerEntryId: null,
        metadata: {
          accountingPeriodId: entitlement.accountingPeriodId,
          agentReference: entitlement.beneficiaryAccountId,
          tenantId: entitlement.tenantId,
          brandId: entitlement.brandId,
          marketId: entitlement.marketId,
          compensationStrategy: entitlement.strategy,
          reportingClassification: entitlement.reportingClassification,
        },
        postingRuleId: entitlement.ledgerTransactionType,
        postingRuleVersion: "1.0.0",
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      ledgerEntry?: { id?: string; canonicalRequestHash?: string };
      error?: unknown;
    } | null;
    if (!response.ok || !body?.ledgerEntry?.id) {
      throw new Error(
        `Compensation Ledger posting failed (${response.status}): ${JSON.stringify(
          body?.error ?? body
        )}`
      );
    }
    return {
      ledgerEntryId: body.ledgerEntry.id,
      canonicalRequestHash:
        body.ledgerEntry.canonicalRequestHash ?? canonicalRequestHash,
    };
  }

  async reverseEntitlement(
    entitlement: CompensationEntitlement,
    originalLedgerEntryId: string,
    originalLedgerEntryHash: string,
    reasonCode: "CORRECTION" | "OPERATOR_CORRECTION" | "VOID"
  ): Promise<CompensationLedgerPosting> {
    const originatingAuthority =
      entitlement.strategy === "COMMISSION"
        ? "commission-authority"
        : "rebate-authority";
    const idempotencyKey = `compensation-reversal:${entitlement.id}`;
    const instructionId = `reverse:${entitlement.id}`;
    const instructionType = "COMPENSATION_REVERSAL";
    const instructionHash = sha256(
      canonicalJson({
        entitlementHash: entitlement.canonicalEntitlementHash,
        originalLedgerEntryId,
        reasonCode,
      })
    );
    const effectiveAt = entitlement.createdAt;
    const reversalPolicyVersion = "ledger-reversal-v1";
    const material = {
      amountMinor: entitlement.compensationAmountMinor,
      currency: entitlement.currency,
      direction: "DEBIT",
      effectiveAt: dotNetTimestamp(effectiveAt),
      idempotencyKey,
      instructionHash,
      instructionId,
      instructionType,
      ledgerAccountId: entitlement.beneficiaryAccountId,
      ledgerWalletId: entitlement.walletId,
      minorUnitPrecision: 2,
      originalLedgerEntryHash,
      originalLedgerEntryId,
      originatingAuthority,
      reasonCode,
      referenceId: originalLedgerEntryId,
      referenceType: "ledger_entry",
      reversalOfLedgerEntryId: originalLedgerEntryId,
      reversalPolicyVersion,
      settlementRecordId: null,
      transactionType: "REVERSAL",
    };
    const canonicalReversalHash = sha256(canonicalJson(material));
    const response = await fetch(
      `${ledgerServiceUrl()}/v1/ledger/entries/${originalLedgerEntryId}/reverse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          originalLedgerEntryId,
          originalLedgerEntryHash,
          walletId: entitlement.walletId,
          ledgerAccountId: entitlement.beneficiaryAccountId,
          direction: "DEBIT",
          money: {
            amount: entitlement.compensationAmountMinor,
            currency: entitlement.currency,
          },
          instructionId,
          instructionType,
          instructionHash,
          originatingAuthority,
          reasonCode,
          reversalPolicyVersion,
          canonicalReversalHash,
          effectiveAt,
          minorUnitPrecision: 2,
          actorUserId: null,
          metadata: {
            compensationEntitlementId: entitlement.id,
            compensationStrategy: entitlement.strategy,
          },
        }),
      }
    );
    const body = (await response.json().catch(() => null)) as {
      ledgerEntry?: { id?: string; canonicalRequestHash?: string };
      error?: unknown;
    } | null;
    if (!response.ok || !body?.ledgerEntry?.id) {
      throw new Error(
        `Compensation Ledger reversal failed (${response.status}): ${JSON.stringify(
          body?.error ?? body
        )}`
      );
    }
    return {
      ledgerEntryId: body.ledgerEntry.id,
      canonicalRequestHash:
        body.ledgerEntry.canonicalRequestHash ?? canonicalReversalHash,
    };
  }
}
