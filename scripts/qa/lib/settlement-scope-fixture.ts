import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type SettlementScopeFixture = {
  tenantId: string;
  brandId: string;
  playerId: string;
  walletId: string;
  reservationId: string;
};

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function createSettlementScopeFixture(
  pool: Pool,
  ticketId: string,
  source: string
): Promise<SettlementScopeFixture> {
  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const playerId = randomUUID();
  const walletId = randomUUID();
  const operationId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

  await pool.query(
    `insert into platform.organizations
       (id, organization_code, name, status, version, content_hash, audit_metadata)
     values ($1, $2, $3, 'Active', '1.0.0', $4, $5::jsonb)`,
    [organizationId, `${source}-org-${suffix}`, `${source} Organization ${suffix}`,
      hash(`${source}:organization:${suffix}`), JSON.stringify({ source })]
  );
  await pool.query(
    `insert into platform.tenants
       (id, organization_id, tenant_code, name, status, default_language, default_currency,
        default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata)
     values ($1, $2, $3, $4, 'Active', 'en', 'USD', 'UTC', true, false,
       '1.0.0', $5, $6::jsonb)`,
    [tenantId, organizationId, `${source}-tenant-${suffix}`, `${source} Tenant ${suffix}`,
      hash(`${source}:tenant:${suffix}`), JSON.stringify({ source })]
  );
  await pool.query(
    `insert into platform.brands
       (id, tenant_id, brand_code, name, display_name, status, version, content_hash, audit_metadata)
     values ($1, $2, $3, $3, $3, 'Active', '1.0.0', $4, $5::jsonb)`,
    [brandId, tenantId, `${source}-brand-${suffix}`, hash(`${source}:brand:${suffix}`),
      JSON.stringify({ source })]
  );
  await pool.query(
    `insert into public.accounts (id, account_type, account_code, display_name, status)
     values ($1, 'PLAYER', $2, $3, 'ACTIVE')`,
    [playerId, `${source}-player-${suffix}`, `${source} Player ${suffix}`]
  );
  await pool.query(
    `insert into public.financial_wallets (
       id, account_id, wallet_type, currency_code, balance_authority, status,
       balance, credit_limit, funding_model
     )
     values ($1, $2, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', 100000, 100000, 'HYBRID')`,
    [walletId, playerId]
  );
  await pool.query(
    `insert into credit_wallet_service.wallet_scopes (
       wallet_id, tenant_id, brand_id, player_id, instrument_code, currency,
       authority, audit_metadata
     )
     values ($1, $2, $3, $4, 'CREDIT', 'USD', 'CREDIT_WALLET_SERVICE', $5::jsonb)`,
    [walletId, tenantId, brandId, playerId, JSON.stringify({ source })]
  );
  const reservation = await pool.query(
    `select credit_wallet_service.reserve_wallet(
       $1, $2, $3, $4, $5, 'CREDIT', $6, 100, 'USD', $7, $8, $9::jsonb
     ) as reservation`,
    [
      operationId,
      walletId,
      tenantId,
      brandId,
      playerId,
      ticketId,
      `${source}:reservation:${operationId}`,
      `${source}:correlation:${operationId}`,
      JSON.stringify({ source }),
    ]
  );
  const reservationId = reservation.rows[0]?.reservation?.id as string | undefined;
  if (!reservationId) {
    throw new Error("Canonical Credit Wallet reservation fixture was not created.");
  }

  return { tenantId, brandId, playerId, walletId, reservationId };
}
