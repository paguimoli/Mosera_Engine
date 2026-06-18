// Preferred internal Ledger boundary for future service extraction.
// Keep routes, workers, and other domains on this surface instead of repositories.

import { getAuditTrailByLedgerTransactionId } from "../audit/audit.service";

export {
  LedgerBusinessRuleError,
  LedgerValidationError,
  getLedgerTransaction,
  listLedgerEntriesForAccount,
  listLedgerEntriesForWallet,
  postLedgerEntry,
  reverseLedgerEntry,
} from "./ledger.service";

export async function getLedgerAuditTrail(ledgerEntryId: string) {
  return getAuditTrailByLedgerTransactionId(ledgerEntryId);
}
