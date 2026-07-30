import { Pool } from "pg";

export type LaunchFundingInstrument = "CREDIT" | "FREE_PLAY";
export type FundingReservationType =
  | "CREDIT_EXPOSURE"
  | "FREE_PLAY_STAKE";

export type FundingInstrumentResolution = {
  resolutionId: string;
  instrument: LaunchFundingInstrument;
  walletId: string;
  reservationType: FundingReservationType;
  currency: string;
  canonicalResolutionHash: string;
  reused: boolean;
};

type ResolveFundingInstrumentInput = {
  playerAccountId: string;
  requestedInstrument?: LaunchFundingInstrument | null;
  requestedWalletId?: string | null;
  currency?: string | null;
  operation: "TICKET_ACCEPTANCE" | "COMPENSATION";
  idempotencyKey: string;
  correlationId: string;
};

let pool: Pool | null = null;

function database() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new FundingInstrumentAuthorityError(
      "Funding Instrument Authority requires DATABASE_URL."
    );
  }
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

export class FundingInstrumentAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingInstrumentAuthorityError";
  }
}

export async function resolveFundingInstrument(
  input: ResolveFundingInstrumentInput
): Promise<FundingInstrumentResolution> {
  try {
    const result = await database().query<{
      resolution_id: string;
      funding_instrument: LaunchFundingInstrument;
      wallet_id: string;
      reservation_type: FundingReservationType;
      currency: string;
      canonical_resolution_hash: string;
      reused: boolean;
    }>(
      `select * from funding_authority.resolve_funding_instrument(
        $1::uuid, $2, $3::uuid, $4, $5, $6, $7
      )`,
      [
        input.playerAccountId,
        input.requestedInstrument ?? null,
        input.requestedWalletId ?? null,
        input.currency ?? null,
        input.operation,
        input.idempotencyKey,
        input.correlationId,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new FundingInstrumentAuthorityError(
        "Funding Instrument Authority returned no resolution."
      );
    }
    return {
      resolutionId: row.resolution_id,
      instrument: row.funding_instrument,
      walletId: row.wallet_id,
      reservationType: row.reservation_type,
      currency: row.currency,
      canonicalResolutionHash: row.canonical_resolution_hash,
      reused: row.reused,
    };
  } catch (error) {
    if (error instanceof FundingInstrumentAuthorityError) throw error;
    throw new FundingInstrumentAuthorityError(
      error instanceof Error
        ? error.message
        : "Funding Instrument resolution failed."
    );
  }
}

export function fundingInstrumentReadiness() {
  return {
    authority: "FundingInstrumentAuthority",
    launchInstruments: ["CREDIT", "FREE_PLAY"],
    exactResolutionRequired: true,
    directWalletSelectionAllowed: false,
    ticketSnapshotRequired: true,
    settlementConsumesSnapshot: true,
    additionalInstrumentsEnabled: false,
  } as const;
}
