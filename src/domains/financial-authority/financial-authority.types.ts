import type {
  AccountFundingModel,
  AccountOperatingMode,
} from "../accounts/account.types";

export type CanonicalFinancialOperatingMode = "CREDIT" | "COMMISSION";
export type CanonicalFundingInstrument = "CREDIT" | "FREE_PLAY";

export type FinancialAccountPolicy = {
  id?: string;
  accountId?: string;
  fundingModel?: AccountFundingModel | null;
  operatingMode?: AccountOperatingMode | null;
};

export type FinancialAuthorityReadiness = {
  authority: "FinancialAuthority";
  ledgerAuthority: "CANONICAL";
  walletAuthority: "CANONICAL";
  reservationAuthority: "CANONICAL";
  settlementAuthority: "CANONICAL";
  operatingModeAuthority: "CANONICAL";
  fundingInstrumentAuthority: "CANONICAL";
  launchFundingInstruments: readonly ["CREDIT"];
  futureFundingInstruments: readonly ["FREE_PLAY"];
  compensationConsumerEnabled: true;
};
