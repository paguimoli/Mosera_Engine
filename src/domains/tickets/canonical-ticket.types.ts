export type CanonicalTicketStatus =
  | "ACCEPTED"
  | "AWAITING_DRAW"
  | "CLOSED"
  | "SETTLEMENT_PENDING"
  | "SETTLED"
  | "CANCELLED"
  | "VOIDED";

export type CanonicalTicketScope = {
  platformId: string;
  organizationId: string;
  tenantId: string;
  brandId: string;
  marketId: string;
};

export type CanonicalTicketItemInput = {
  wagerType: string;
  wagerVersion: string;
  selections: unknown[] | Record<string, unknown>;
  stakeMinor: number;
};

export type AcceptCanonicalTicketInput = {
  playerAccountId: string;
  playerProfileId: string;
  fundingInstrument?: "CREDIT" | "FREE_PLAY" | null;
  walletId?: string | null;
  gameAvailabilityId: string;
  productId: string;
  manifestId: string;
  paytableDefinitionId: string;
  drawId: string;
  websiteId?: string | null;
  domainId?: string | null;
  externalTicketId?: string | null;
  currency: string;
  items: CanonicalTicketItemInput[];
  idempotencyKey: string;
  correlationId: string;
  causationId?: string | null;
  actorReference: string;
  salesChannel: string;
};

export type CanonicalTicket = CanonicalTicketScope & {
  ticketId: string;
  externalTicketId?: string | null;
  websiteId?: string | null;
  domainId?: string | null;
  playerAccountId: string;
  playerProfileId: string;
  agentAccountId?: string | null;
  masterAgentAccountId?: string | null;
  fundingInstrument: "CREDIT" | "FREE_PLAY";
  walletId: string;
  reservationType: "CREDIT_EXPOSURE" | "FREE_PLAY_STAKE";
  reservationId: string;
  fundingResolutionId: string;
  fundingSnapshotHash: string;
  productId: string;
  productVersionId: string;
  productVersion: number;
  gameCode: string;
  gameConfigurationHash: string;
  manifestId: string;
  manifestVersion: string;
  manifestHash: string;
  paytableDefinitionId: string;
  paytableId: string;
  paytableVersion: string;
  paytableHash: string;
  gameAvailabilityId: string;
  gameAvailabilityVersion: string;
  gameAvailabilityHash: string;
  drawId: string;
  drawBindingHash: string;
  status: CanonicalTicketStatus;
  currency: string;
  totalStakeMinor: number;
  acceptanceSnapshot: Record<string, unknown>;
  canonicalRequestHash: string;
  acceptanceHash: string;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string | null;
  actorReference: string;
  salesChannel: string;
  acceptedAt: string;
  updatedAt: string;
};

export type TicketReadinessCheck = {
  checkName: string;
  ready: boolean;
  issueCount: number;
};
