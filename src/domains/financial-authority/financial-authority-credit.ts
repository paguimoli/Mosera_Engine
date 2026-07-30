import {
  applyCreditSettlement as applyCreditSettlementInternal,
  cancelCreditReservation as cancelCreditReservationInternal,
  getCreditReservationById as getCreditReservationByIdInternal,
  getPlayerCreditSummary as getPlayerCreditSummaryInternal,
  releaseCreditExposure as releaseCreditExposureInternal,
  reserveCreditExposure as reserveCreditExposureInternal,
} from "../credit/credit.entrypoints";
import type {
  ApplyCreditSettlementInput,
  ReserveCreditExposureInput,
} from "../credit/credit-reservation.types";
import { assertFundingInstrument } from "./financial-authority.policy";

export async function reserveCreditExposure(
  input: ReserveCreditExposureInput
) {
  assertFundingInstrument("CREDIT");
  return reserveCreditExposureInternal(input);
}

export const getCreditReservationById = getCreditReservationByIdInternal;
export const releaseCreditExposure = releaseCreditExposureInternal;
export const cancelCreditReservation = cancelCreditReservationInternal;
export const getPlayerCreditSummary = getPlayerCreditSummaryInternal;

export async function applyCreditSettlement(
  input: ApplyCreditSettlementInput
) {
  assertFundingInstrument("CREDIT");
  return applyCreditSettlementInternal(input);
}
