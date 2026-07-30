import type {
  CompensationEntitlement,
  CompensationLedgerPosting,
} from "./compensation.types";

export interface CompensationLedgerGateway {
  postEntitlement(
    entitlement: CompensationEntitlement
  ): Promise<CompensationLedgerPosting>;
  reverseEntitlement(
    entitlement: CompensationEntitlement,
    originalLedgerEntryId: string,
    originalLedgerEntryHash: string,
    reasonCode: "CORRECTION" | "OPERATOR_CORRECTION" | "VOID"
  ): Promise<CompensationLedgerPosting>;
}
export { LedgerServiceCompensationGateway } from "../financial-authority/compensation-ledger.gateway";
