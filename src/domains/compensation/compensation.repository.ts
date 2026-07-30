import { Pool, type QueryResultRow } from "pg";

import type {
  CompensationConfiguration,
  CompensationEntitlement,
  CompensationPeriod,
  CreateCompensationConfigurationInput,
} from "./compensation.types";

type Row = QueryResultRow & Record<string, unknown>;

let pool: Pool | null = null;

export class CompensationRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompensationRepositoryError";
  }
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new CompensationRepositoryError(
      "Compensation Authority requires DATABASE_URL."
    );
  }
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 6,
    idleTimeoutMillis: 5_000,
  });
  return pool;
}

function text(row: Row, key: string) {
  return String(row[key]);
}

function optionalText(row: Row, key: string) {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function number(row: Row, key: string) {
  return Number(row[key]);
}

function mapConfiguration(row: Row): CompensationConfiguration {
  return {
    id: text(row, "id"),
    hierarchyOwnerAccountId: text(row, "hierarchy_owner_account_id"),
    beneficiaryAccountId: text(row, "beneficiary_account_id"),
    strategy: text(row, "strategy") as CompensationConfiguration["strategy"],
    calculationBasis: text(
      row,
      "calculation_basis"
    ) as CompensationConfiguration["calculationBasis"],
    rateBasisPoints: number(row, "rate_basis_points"),
    accountingPeriod: "WEEKLY",
    minimumThresholdMinor: number(row, "minimum_threshold_minor"),
    maximumCompensationMinor:
      row.maximum_compensation_minor === null
        ? null
        : number(row, "maximum_compensation_minor"),
    fundingInstrument: text(
      row,
      "funding_instrument"
    ) as CompensationConfiguration["fundingInstrument"],
    effectiveFrom: text(row, "effective_from"),
    effectiveTo: optionalText(row, "effective_to"),
    enabled: row.enabled === true,
    sourceConfigurationReference: optionalText(
      row,
      "source_configuration_reference"
    ),
    idempotencyKey: text(row, "idempotency_key"),
    canonicalRequestHash: text(row, "canonical_request_hash"),
    contentHash: text(row, "content_hash"),
    auditMetadata: (row.audit_metadata ?? {}) as Record<string, unknown>,
    createdAt: text(row, "created_at"),
  };
}

function mapEntitlement(row: Row): CompensationEntitlement {
  return {
    id: text(row, "id"),
    executionId: text(row, "execution_id"),
    configurationId: text(row, "configuration_id"),
    accountingPeriodId: text(row, "accounting_period_id"),
    tenantId: text(row, "tenant_id"),
    brandId: text(row, "brand_id"),
    marketId: text(row, "market_id"),
    hierarchyOwnerAccountId: text(row, "hierarchy_owner_account_id"),
    beneficiaryAccountId: text(row, "beneficiary_account_id"),
    strategy: text(row, "strategy") as CompensationEntitlement["strategy"],
    reportingClassification: text(
      row,
      "reporting_classification"
    ) as CompensationEntitlement["reportingClassification"],
    calculationBasis: "NET_LOSS",
    basisAmountMinor: number(row, "basis_amount_minor"),
    rateBasisPoints: number(row, "rate_basis_points"),
    compensationAmountMinor: number(row, "compensation_amount_minor"),
    currency: text(row, "currency"),
    fundingInstrument: "CREDIT",
    walletId: text(row, "wallet_id"),
    ledgerTransactionType: text(
      row,
      "ledger_transaction_type"
    ) as CompensationEntitlement["ledgerTransactionType"],
    canonicalEntitlementHash: text(row, "canonical_entitlement_hash"),
    reversalOfEntitlementId: optionalText(row, "reversal_of_entitlement_id"),
    createdAt: text(row, "created_at"),
  };
}

export async function createCompensationConfigurationRecord(
  input: CreateCompensationConfigurationInput & {
    canonicalRequestHash: string;
    contentHash: string;
  }
) {
  const result = await databasePool().query<Row>(
    `insert into compensation.configurations (
       hierarchy_owner_account_id, beneficiary_account_id, strategy,
       calculation_basis, rate_basis_points, accounting_period,
       minimum_threshold_minor, maximum_compensation_minor, funding_instrument,
       effective_from, effective_to, enabled, source_configuration_reference,
       idempotency_key, canonical_request_hash, content_hash, audit_metadata
     ) values (
       $1, $2, $3, $4, $5, 'WEEKLY', $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16::jsonb
     )
     on conflict (idempotency_key) do nothing
     returning *`,
    [
      input.hierarchyOwnerAccountId,
      input.beneficiaryAccountId,
      input.strategy,
      input.calculationBasis,
      input.rateBasisPoints,
      input.minimumThresholdMinor,
      input.maximumCompensationMinor,
      input.fundingInstrument,
      input.effectiveFrom,
      input.effectiveTo,
      input.enabled,
      input.sourceConfigurationReference,
      input.idempotencyKey,
      input.canonicalRequestHash,
      input.contentHash,
      JSON.stringify(input.auditMetadata),
    ]
  );
  if (result.rows[0]) return mapConfiguration(result.rows[0]);

  const existing = await databasePool().query<Row>(
    "select * from compensation.configurations where idempotency_key = $1",
    [input.idempotencyKey]
  );
  if (
    !existing.rows[0] ||
    existing.rows[0].canonical_request_hash !== input.canonicalRequestHash
  ) {
    throw new CompensationRepositoryError(
      "Compensation configuration idempotency conflict."
    );
  }
  return mapConfiguration(existing.rows[0]);
}

export async function findCompensationPeriod(
  periodId: string
): Promise<CompensationPeriod | null> {
  const result = await databasePool().query<Row>(
    `select period_id, brand_id, market_id, period_start_at, period_end_at, status
       from ledger_service.weekly_accounting_periods
      where period_id = $1`,
    [periodId]
  );
  const row = result.rows[0];
  return row
    ? {
        id: text(row, "period_id"),
        brandId: text(row, "brand_id"),
        marketId: text(row, "market_id"),
        startsAt: text(row, "period_start_at"),
        endsAt: text(row, "period_end_at"),
        status: text(row, "status") as CompensationPeriod["status"],
      }
    : null;
}

export async function claimCompensationExecution(input: {
  periodId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  correlationId: string;
}) {
  const result = await databasePool().query<Row>(
    `insert into compensation.executions (
       accounting_period_id, idempotency_key, canonical_request_hash,
       correlation_id
     ) values ($1, $2, $3, $4)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      input.periodId,
      input.idempotencyKey,
      input.canonicalRequestHash,
      input.correlationId,
    ]
  );
  if (result.rows[0]) return text(result.rows[0], "id");
  const existing = await databasePool().query<Row>(
    `select id, canonical_request_hash
       from compensation.executions where idempotency_key = $1`,
    [input.idempotencyKey]
  );
  if (
    !existing.rows[0] ||
    existing.rows[0].canonical_request_hash !== input.canonicalRequestHash
  ) {
    throw new CompensationRepositoryError(
      "Compensation execution idempotency conflict."
    );
  }
  return text(existing.rows[0], "id");
}

export async function listEligibleCompensationConfigurations(
  period: CompensationPeriod
) {
  const result = await databasePool().query<Row>(
    `select configuration.*
       from compensation.configurations configuration
       join public.accounts owner
         on owner.id = configuration.hierarchy_owner_account_id
      where configuration.enabled
        and configuration.funding_instrument = 'CREDIT'
        and configuration.effective_from < $3
        and (configuration.effective_to is null or configuration.effective_to >= $2)
        and owner.status = 'ACTIVE'
        and owner.canonical_brand_id = $1
        and owner.canonical_market_id = $4
      order by configuration.strategy, configuration.id`,
    [period.brandId, period.startsAt, period.endsAt, period.marketId]
  );
  return result.rows.map(mapConfiguration);
}

export async function getAuthoritativeSettledNetResult(
  configuration: CompensationConfiguration,
  period: CompensationPeriod
) {
  const result = await databasePool().query<Row>(
    `with recursive descendants as (
       select id from public.accounts where id = $1
       union all
       select child.id
         from public.accounts child
         join descendants parent on child.parent_account_id = parent.id
     )
     select coalesce(sum(application.balance_impact), 0)::bigint as net_result
       from public.credit_settlement_applications application
       join descendants scope on scope.id = application.player_id
      where application.created_at >= $2
        and application.created_at < $3
        and application.operation_id is not null
        and application.settlement_authority = 'settlement-service'
        and application.authentication_result = 'AUTHENTICATED'`,
    [
      configuration.hierarchyOwnerAccountId,
      period.startsAt,
      period.endsAt,
    ]
  );
  return number(result.rows[0], "net_result");
}

export async function findActiveCreditWallet(accountId: string) {
  const result = await databasePool().query<Row>(
    `select id, currency_code
       from public.financial_wallets
      where account_id = $1 and wallet_type = 'CREDIT' and status = 'ACTIVE'
      limit 1`,
    [accountId]
  );
  return result.rows[0]
    ? {
        id: text(result.rows[0], "id"),
        currency: text(result.rows[0], "currency_code"),
      }
    : null;
}

export async function appendCalculatedEntitlement(input: {
  entitlement: Omit<CompensationEntitlement, "id" | "createdAt">;
}) {
  const value = input.entitlement;
  const result = await databasePool().query<Row>(
    `insert into compensation.entitlements (
       execution_id, configuration_id, accounting_period_id,
       tenant_id, brand_id, market_id,
       hierarchy_owner_account_id, beneficiary_account_id, strategy,
       reporting_classification, calculation_basis, basis_amount_minor,
       rate_basis_points, compensation_amount_minor, currency,
       funding_instrument, wallet_id, ledger_transaction_type,
       canonical_entitlement_hash, reversal_of_entitlement_id
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
     )
     on conflict (configuration_id, accounting_period_id)
       where reversal_of_entitlement_id is null
     do nothing
     returning *`,
    [
      value.executionId,
      value.configurationId,
      value.accountingPeriodId,
      value.tenantId,
      value.brandId,
      value.marketId,
      value.hierarchyOwnerAccountId,
      value.beneficiaryAccountId,
      value.strategy,
      value.reportingClassification,
      value.calculationBasis,
      value.basisAmountMinor,
      value.rateBasisPoints,
      value.compensationAmountMinor,
      value.currency,
      value.fundingInstrument,
      value.walletId,
      value.ledgerTransactionType,
      value.canonicalEntitlementHash,
      value.reversalOfEntitlementId,
    ]
  );
  if (result.rows[0]) return mapEntitlement(result.rows[0]);
  const existing = await databasePool().query<Row>(
    `select * from compensation.entitlements
      where configuration_id = $1 and accounting_period_id = $2`,
    [value.configurationId, value.accountingPeriodId]
  );
  if (
    !existing.rows[0] ||
    existing.rows[0].canonical_entitlement_hash !==
      value.canonicalEntitlementHash
  ) {
    throw new CompensationRepositoryError(
      "Compensation entitlement conflict."
    );
  }
  return mapEntitlement(existing.rows[0]);
}

export async function appendCompensationEvent(input: {
  executionId: string;
  entitlementId?: string | null;
  eventType: "CALCULATED" | "POSTED" | "REVERSED" | "FAILED" | "COMPLETED";
  ledgerEntryId?: string | null;
  evidenceHash: string;
  metadata?: Record<string, unknown>;
}) {
  await databasePool().query(
    `insert into compensation.events (
       execution_id, entitlement_id, event_type, ledger_entry_id,
       canonical_evidence_hash, metadata
     ) values ($1,$2,$3,$4,$5,$6::jsonb)
     on conflict (canonical_evidence_hash) do nothing`,
    [
      input.executionId,
      input.entitlementId ?? null,
      input.eventType,
      input.ledgerEntryId ?? null,
      input.evidenceHash,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

export async function hasPostedCompensationEntitlement(entitlementId: string) {
  const result = await databasePool().query(
    `select 1 from compensation.events
      where entitlement_id = $1 and event_type in ('POSTED', 'REVERSED') limit 1`,
    [entitlementId]
  );
  return result.rowCount === 1;
}

export async function listCompensationEntitlements(executionId: string) {
  const result = await databasePool().query<Row>(
    `select * from compensation.entitlements
      where execution_id = $1 order by strategy, beneficiary_account_id`,
    [executionId]
  );
  return result.rows.map(mapEntitlement);
}

export async function findCompensationEntitlementForReversal(
  entitlementId: string
) {
  const result = await databasePool().query<Row>(
    `select entitlement.*,
            posted.ledger_entry_id as posted_ledger_entry_id,
            ledger.canonical_request_hash as posted_ledger_entry_hash
       from compensation.entitlements entitlement
       join lateral (
         select event.ledger_entry_id
           from compensation.events event
          where event.entitlement_id = entitlement.id
            and event.event_type = 'POSTED'
          order by event.created_at desc
          limit 1
       ) posted on true
       join public.financial_ledger_entries ledger
         on ledger.id = posted.ledger_entry_id
      where entitlement.id = $1
        and entitlement.reversal_of_entitlement_id is null`,
    [entitlementId]
  );
  const row = result.rows[0];
  return row
    ? {
        entitlement: mapEntitlement(row),
        ledgerEntryId: text(row, "posted_ledger_entry_id"),
        ledgerEntryHash: text(row, "posted_ledger_entry_hash"),
      }
    : null;
}

export async function appendCompensationReversalEntitlement(input: {
  original: CompensationEntitlement;
  executionId: string;
  canonicalEntitlementHash: string;
}) {
  const original = input.original;
  const result = await databasePool().query<Row>(
    `insert into compensation.entitlements (
       execution_id, configuration_id, accounting_period_id,
       tenant_id, brand_id, market_id,
       hierarchy_owner_account_id, beneficiary_account_id, strategy,
       reporting_classification, calculation_basis, basis_amount_minor,
       rate_basis_points, compensation_amount_minor, currency,
       funding_instrument, wallet_id, ledger_transaction_type,
       canonical_entitlement_hash, reversal_of_entitlement_id
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
     )
     on conflict (reversal_of_entitlement_id)
       where reversal_of_entitlement_id is not null
     do nothing
     returning *`,
    [
      input.executionId,
      original.configurationId,
      original.accountingPeriodId,
      original.tenantId,
      original.brandId,
      original.marketId,
      original.hierarchyOwnerAccountId,
      original.beneficiaryAccountId,
      original.strategy,
      original.reportingClassification,
      original.calculationBasis,
      original.basisAmountMinor,
      original.rateBasisPoints,
      original.compensationAmountMinor,
      original.currency,
      original.fundingInstrument,
      original.walletId,
      original.ledgerTransactionType,
      input.canonicalEntitlementHash,
      original.id,
    ]
  );
  if (result.rows[0]) return mapEntitlement(result.rows[0]);
  const existing = await databasePool().query<Row>(
    `select * from compensation.entitlements
      where reversal_of_entitlement_id = $1`,
    [original.id]
  );
  if (
    !existing.rows[0] ||
    existing.rows[0].canonical_entitlement_hash !==
      input.canonicalEntitlementHash
  ) {
    throw new CompensationRepositoryError(
      "Compensation reversal conflict."
    );
  }
  return mapEntitlement(existing.rows[0]);
}

export async function compensationPersistenceReadiness() {
  const result = await databasePool().query<Row>(
    `select
       to_regclass('compensation.configurations') is not null as configurations,
       to_regclass('compensation.executions') is not null as executions,
       to_regclass('compensation.entitlements') is not null as entitlements,
       to_regclass('compensation.events') is not null as events`
  );
  return result.rows[0];
}

export async function closeCompensationPool() {
  if (pool) await pool.end();
  pool = null;
}
