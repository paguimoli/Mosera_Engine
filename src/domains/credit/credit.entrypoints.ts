// Preferred internal Credit Wallet boundary for future service extraction.
// Keep routes, workers, and other domains on this surface instead of repositories.

export {
  applyCreditSettlement,
  cancelCreditReservation,
  CreditReservationValidationError,
  getPlayerCreditSummary,
  releaseCreditExposure,
  reserveCreditExposure,
} from "./credit-reservation.service";

export type {
  ApplyCreditSettlementInput,
  CancelCreditReservationInput,
  CreditReservation,
  CreditSettlementApplicationResult,
  CreditSummary,
  ReleaseCreditExposureInput,
  ReserveCreditExposureInput,
} from "./credit-reservation.types";
