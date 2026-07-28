import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) {
    console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
    process.exit(1);
  }
}

async function classify(
  pool: Pool,
  targetType: "SETTLEMENT_RECORD" | "FINANCIAL_INSTRUCTION" | "RECOVERY_ITEM",
  targetId: string,
  correlationReference: string
) {
  const evidenceSource = "settlement_requests.mode=DryRun";
  const evidenceHash = hash([
    "P1-011.2",
    targetType,
    targetId,
    "DRY_RUN_EVIDENCE",
    evidenceSource,
    correlationReference,
  ].join("|"));
  await pool.query(
    `insert into settlement_service.settlement_evidence_classifications (
       classification_id, target_type, target_id, classification, reason,
       evidence_source, reviewer_reference, promotion_eligible, recovery_required,
       correlation_reference, evidence_hash
     )
     values ($1, $2, $3, 'DRY_RUN_EVIDENCE',
       'Historical evidence was created by the explicitly disabled DryRun settlement path.',
       $4, 'system:p1-011.2-classifier', false, false, $5, $6)
     on conflict (evidence_hash) do nothing`,
    [randomUUID(), targetType, targetId, evidenceSource, correlationReference, evidenceHash]
  );
}

async function main() {
  assert(Boolean(databaseUrl), "DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const records = await pool.query(
        `select record.settlement_id::text as target_id,
              request.idempotency_key as correlation_reference
       from settlement_service.authoritative_settlement_records record
       join settlement_service.settlement_requests request
         on request.settlement_request_id = record.settlement_request_id
       where request.mode = 'DryRun'
         and (
           record.tenant_id is null
           or request.tenant_id is null
           or coalesce(request.request_provenance->>'source', '') like 'qa%'
           or (
             request.request_provenance->>'source' = 'resettlement-reversal'
             and exists (
               select 1
               from settlement_service.settlement_promotion_exclusions excluded
               where excluded.target_type = 'SETTLEMENT_RECORD'
                 and excluded.target_id =
                   (request.request_provenance->>'originalSettlementId')::uuid
             )
           )
         )`
      );
      for (const row of records.rows) {
        await classify(pool, "SETTLEMENT_RECORD", row.target_id, row.correlation_reference);
      }
    }

    const instructions = await pool.query(
      `select instruction.instruction_id::text as target_id,
              instruction.idempotency_key as correlation_reference
       from settlement_service.financial_instructions instruction
       join settlement_service.authoritative_settlement_records record
         on record.settlement_id = instruction.settlement_id
       join settlement_service.settlement_requests request
         on request.settlement_request_id = record.settlement_request_id
       where request.mode = 'DryRun'
         and (
           record.tenant_id is null
           or request.tenant_id is null
           or coalesce(request.request_provenance->>'source', '') like 'qa%'
         )`
    );
    for (const row of instructions.rows) {
      await classify(pool, "FINANCIAL_INSTRUCTION", row.target_id, row.correlation_reference);
    }

    const recoveryItems = await pool.query(
      `select event_id::text as target_id, 'recovery:' || event_id::text as correlation_reference
       from settlement_service.recovery_events recovery
       join settlement_service.authoritative_settlement_records record
         on record.settlement_id = recovery.settlement_id
       join settlement_service.settlement_requests request
         on request.settlement_request_id = record.settlement_request_id
       where request.mode = 'DryRun'
         and (
           record.tenant_id is null
           or request.tenant_id is null
           or coalesce(request.request_provenance->>'source', '') like 'qa%'
         )
       union all
       select event_id::text, 'reconciliation:' || event_id::text
       from settlement_service.reconciliation_events reconciliation
       join settlement_service.authoritative_settlement_records record
         on record.settlement_id = reconciliation.settlement_id
       join settlement_service.settlement_requests request
         on request.settlement_request_id = record.settlement_request_id
       where request.mode = 'DryRun'
         and (
           record.tenant_id is null
           or request.tenant_id is null
           or coalesce(request.request_provenance->>'source', '') like 'qa%'
         )`
    );
    for (const row of recoveryItems.rows) {
      await classify(pool, "RECOVERY_ITEM", row.target_id, row.correlation_reference);
    }

    const summary = await pool.query(
      `select
         (select count(*)::int from settlement_service.settlement_evidence_classifications) classified,
         (select count(*)::int from settlement_service.settlement_promotion_exclusions) excluded,
         (select count(*)::int
          from settlement_service.authoritative_settlement_records record
          join settlement_service.settlement_requests request
            on request.settlement_request_id = record.settlement_request_id
          where request.mode = 'DryRun'
            and (record.tenant_id is null or request.tenant_id is null)
            and not exists (
              select 1 from settlement_service.settlement_promotion_exclusions excluded
              where excluded.target_type = 'SETTLEMENT_RECORD'
                and excluded.target_id = record.settlement_id
            )) unclassified_dry_run_records`
    );
    assert(
      Number(summary.rows[0].unclassified_dry_run_records) === 0,
      "Every proven historical DryRun settlement record must have governed exclusion evidence.",
      { summary: summary.rows[0] }
    );

    const sample = await pool.query(
      `select classification_id
       from settlement_service.settlement_evidence_classifications
       order by created_at
       limit 1`
    );
    assert(sample.rowCount === 1, "Classification evidence must exist.");
    const updateBlocked = await pool
      .query(
        `update settlement_service.settlement_evidence_classifications
         set reason = reason
         where classification_id = $1`,
        [sample.rows[0].classification_id]
      )
      .then(() => false)
      .catch(() => true);
    const deleteBlocked = await pool
      .query(
        `delete from settlement_service.settlement_evidence_classifications
         where classification_id = $1`,
        [sample.rows[0].classification_id]
      )
      .then(() => false)
      .catch(() => true);
    assert(updateBlocked && deleteBlocked, "Classification evidence must be append-only.");

    const unsafeExclusionBlocked = await pool
      .query(
        `insert into settlement_service.settlement_evidence_classifications (
           classification_id, target_type, target_id, classification, reason,
           evidence_source, reviewer_reference, promotion_eligible, recovery_required,
           correlation_reference, evidence_hash
         )
         values ($1, 'SETTLEMENT_RECORD', $2, 'UNKNOWN_OR_INCONSISTENT',
           'QA verifies unknown evidence cannot be excluded.', 'qa', 'qa', false, true,
           'qa:unknown', $3)`,
        [randomUUID(), randomUUID(), hash(`unknown:${randomUUID()}`)]
      )
      .then(() => false)
      .catch(() => true);
    assert(unsafeExclusionBlocked, "Unknown evidence must not be excluded from promotion.");

    console.log(JSON.stringify({
      status: "PASS",
      classified: Number(summary.rows[0].classified),
      governedPromotionExclusions: Number(summary.rows[0].excluded),
      unclassifiedDryRunRecords: 0,
      appendOnly: true,
      unknownEvidenceFailsClosed: true,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "FAIL",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
