import { Pool } from "pg";

import type {
  AcceptCanonicalTicketInput,
  CanonicalTicket,
  TicketReadinessCheck,
} from "./canonical-ticket.types";

let pool: Pool | null = null;

function database() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new CanonicalTicketRepositoryError(
      "Canonical Ticket persistence requires DATABASE_URL."
    );
  }
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

export class CanonicalTicketRepositoryError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "CanonicalTicketRepositoryError";
  }
}

type TicketRow = Record<string, unknown> & {
  ticket_id: string;
  platform_id: string;
  organization_id: string;
  tenant_id: string;
  brand_id: string;
  market_id: string;
};

function stringValue(row: TicketRow, key: string) {
  return String(row[key] ?? "");
}

function optionalString(row: TicketRow, key: string) {
  return row[key] == null ? null : String(row[key]);
}

function mapTicket(row: TicketRow): CanonicalTicket {
  return {
    ticketId: row.ticket_id,
    externalTicketId: optionalString(row, "external_ticket_id"),
    platformId: row.platform_id,
    organizationId: row.organization_id,
    tenantId: row.tenant_id,
    brandId: row.brand_id,
    marketId: row.market_id,
    websiteId: optionalString(row, "website_id"),
    domainId: optionalString(row, "domain_id"),
    playerAccountId: stringValue(row, "player_account_id"),
    playerProfileId: stringValue(row, "player_profile_id"),
    agentAccountId: optionalString(row, "agent_account_id"),
    masterAgentAccountId: optionalString(row, "master_agent_account_id"),
    fundingInstrument: stringValue(
      row,
      "funding_instrument"
    ) as CanonicalTicket["fundingInstrument"],
    walletId: stringValue(row, "wallet_id"),
    reservationType: stringValue(
      row,
      "reservation_type"
    ) as CanonicalTicket["reservationType"],
    reservationId: stringValue(row, "reservation_id"),
    fundingResolutionId: stringValue(row, "funding_resolution_id"),
    fundingSnapshotHash: stringValue(row, "funding_snapshot_hash"),
    productId: stringValue(row, "product_id"),
    productVersionId: stringValue(row, "product_version_id"),
    productVersion: Number(row.product_version),
    gameCode: stringValue(row, "game_code"),
    gameConfigurationHash: stringValue(row, "game_configuration_hash"),
    manifestId: stringValue(row, "manifest_id"),
    manifestVersion: stringValue(row, "manifest_version"),
    manifestHash: stringValue(row, "manifest_hash"),
    paytableDefinitionId: stringValue(row, "paytable_definition_id"),
    paytableId: stringValue(row, "paytable_id"),
    paytableVersion: stringValue(row, "paytable_version"),
    paytableHash: stringValue(row, "paytable_hash"),
    gameAvailabilityId: stringValue(row, "game_availability_id"),
    gameAvailabilityVersion: stringValue(row, "game_availability_version"),
    gameAvailabilityHash: stringValue(row, "game_availability_hash"),
    drawId: stringValue(row, "draw_id"),
    drawBindingHash: stringValue(row, "draw_binding_hash"),
    executionManifestId: optionalString(row, "execution_manifest_id"),
    executionManifestHash: optionalString(row, "execution_manifest_hash"),
    lineageModel: stringValue(row, "lineage_model") as CanonicalTicket["lineageModel"],
    status: row.status as CanonicalTicket["status"],
    currency: stringValue(row, "currency"),
    totalStakeMinor: Number(row.total_stake_minor),
    acceptanceSnapshot: row.acceptance_snapshot as Record<string, unknown>,
    canonicalRequestHash: stringValue(row, "canonical_request_hash"),
    acceptanceHash: stringValue(row, "acceptance_hash"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    correlationId: stringValue(row, "correlation_id"),
    causationId: optionalString(row, "causation_id"),
    actorReference: stringValue(row, "actor_reference"),
    salesChannel: stringValue(row, "sales_channel"),
    acceptedAt: new Date(String(row.accepted_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function translateError(error: unknown): never {
  const value = error as { message?: string; code?: string };
  throw new CanonicalTicketRepositoryError(
    value.message ?? "Canonical Ticket persistence failed.",
    value.code
  );
}

export async function acceptCanonicalTicket(input: AcceptCanonicalTicketInput): Promise<{
  accepted: boolean;
  duplicate: boolean;
  [key: string]: unknown;
}> {
  try {
    const result = await database().query<{
      result: { accepted: boolean; duplicate: boolean; [key: string]: unknown };
    }>(
      `select ticket_authority.accept_ticket(
        $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
        $7::uuid, $8::uuid, $9, $10, $11, $12::jsonb,
        $13, $14, $15, $16, $17
      ) as result`,
      [
        input.playerAccountId,
        input.playerProfileId,
        input.fundingInstrument ?? null,
        input.walletId ?? null,
        input.productId,
        input.manifestId,
        input.paytableDefinitionId,
        input.drawId,
        input.hostname ?? null,
        input.externalTicketId ?? null,
        input.currency,
        JSON.stringify(input.items),
        input.idempotencyKey,
        input.correlationId,
        input.causationId ?? null,
        input.actorReference,
        input.salesChannel,
      ]
    );
    return result.rows[0].result;
  } catch (error) {
    translateError(error);
  }
}

export async function findCanonicalTicket(ticketId: string) {
  try {
    const result = await database().query<TicketRow>(
      `select * from ticket_authority.tickets where ticket_id = $1::uuid`,
      [ticketId]
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  } catch (error) {
    translateError(error);
  }
}

export async function listCanonicalTickets(limit = 100) {
  try {
    const result = await database().query<TicketRow>(
      `select * from ticket_authority.tickets
       order by accepted_at desc, ticket_id
       limit $1`,
      [Math.min(Math.max(limit, 1), 250)]
    );
    return result.rows.map(mapTicket);
  } catch (error) {
    translateError(error);
  }
}

export async function getCanonicalTicketHistory(ticketId: string) {
  try {
    const result = await database().query(
      `select event_id as "eventId", previous_status as "previousStatus",
        status, reason_code as "reasonCode", actor_reference as "actorReference",
        correlation_id as "correlationId", causation_id as "causationId",
        evidence, canonical_event_hash as "canonicalEventHash",
        created_at as "createdAt"
       from ticket_authority.ticket_lifecycle_events
       where ticket_id = $1::uuid
       order by created_at, event_id`,
      [ticketId]
    );
    return result.rows;
  } catch (error) {
    translateError(error);
  }
}

export async function getCanonicalTicketCorrelations(ticketId: string) {
  try {
    const result = await database().query(
      `select correlation_event_id as "correlationEventId",
        ticket_item_id as "ticketItemId", correlation_type as "correlationType",
        source_id as "sourceId", source_hash as "sourceHash",
        operation_kind as "operationKind", evidence,
        correlation_id as "correlationId",
        canonical_correlation_hash as "canonicalCorrelationHash",
        created_at as "createdAt"
       from ticket_authority.ticket_correlations
       where ticket_id = $1::uuid
       order by created_at, correlation_event_id`,
      [ticketId]
    );
    return result.rows;
  } catch (error) {
    translateError(error);
  }
}

export async function cancelCanonicalTicket(input: {
  ticketId: string;
  idempotencyKey: string;
  reasonCode: string;
  requestedBy: string;
  correlationId: string;
}) {
  try {
    const result = await database().query<{ result: Record<string, unknown> }>(
      `select ticket_authority.cancel_ticket($1::uuid, $2, $3, $4, $5) as result`,
      [
        input.ticketId,
        input.idempotencyKey,
        input.reasonCode,
        input.requestedBy,
        input.correlationId,
      ]
    );
    return result.rows[0].result;
  } catch (error) {
    translateError(error);
  }
}

export async function getTicketReadiness(): Promise<TicketReadinessCheck[]> {
  try {
    const result = await database().query<{
      check_name: string;
      ready: boolean;
      issue_count: string;
    }>("select * from ticket_authority.ticket_platform_readiness()");
    return result.rows.map((row) => ({
      checkName: row.check_name,
      ready: row.ready,
      issueCount: Number(row.issue_count),
    }));
  } catch (error) {
    translateError(error);
  }
}
