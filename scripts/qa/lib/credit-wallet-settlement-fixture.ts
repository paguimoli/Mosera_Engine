import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type SettlementFixture = {
  settlementId: string;
  settlementHash: string;
  settlementVersion: string;
  ledgerInstructionId: string;
  ledgerInstructionHash: string;
  creditInstructionId: string;
  creditInstructionHash: string;
};

export function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function seedSettlementFixture(
  pool: Pool,
  input: {
    reservationId: string;
    ticketId: string;
    amountMinor: number;
    balanceImpactMinor: number;
    outcome?: "WIN" | "LOSS" | "PUSH" | "VOID";
    ledgerRequired?: boolean;
    creditInstructionType?: "CREDIT_APPLY" | "CREDIT_REFUND";
    ledgerInstructionType?: "LEDGER_PAYOUT" | "LEDGER_REFUND" | "LEDGER_REVERSAL" | "LEDGER_NOOP";
    provenance?: Record<string, unknown>;
  }
): Promise<SettlementFixture> {
  const settlementInputId = randomUUID();
  const settlementRequestId = randomUUID();
  const settlementId = randomUUID();
  const mathCertificateId = randomUUID();
  const outcomeCertificateId = randomUUID();
  const ticketLineId = randomUUID();
  const suffix = randomUUID();
  const settlementVersion = "settlement-policy:v1";
  const outcome = input.outcome ?? "WIN";
  const inputHash = sha256(`settlement-input:${suffix}`);
  const mathHash = sha256(`math:${suffix}`);
  const outcomeHash = sha256(`outcome:${suffix}`);
  const settlementHash = sha256(`settlement:${suffix}`);
  const ledgerInstructionId = randomUUID();
  const creditInstructionId = randomUUID();
  const ledgerInstructionHash = sha256(`ledger-instruction:${suffix}`);
  const creditInstructionHash = sha256(`credit-instruction:${suffix}`);
  const ledgerRequired = input.ledgerRequired ?? false;
  const ledgerInstructionType = input.ledgerInstructionType
    ?? (ledgerRequired ? "LEDGER_PAYOUT" : "LEDGER_NOOP");
  const creditInstructionType = input.creditInstructionType ?? "CREDIT_APPLY";

  await pool.query(
    `insert into game_engine.settlement_input_records(
       settlement_input_id, math_evaluation_certificate_id,
       math_evaluation_certificate_hash, outcome_certificate_id,
       outcome_certificate_hash, ticket_reference, game_manifest_id,
       game_manifest_version, game_manifest_hash, math_model_id,
       math_model_version, math_model_hash, paytable_id, paytable_version,
       paytable_hash, evaluator_version, evaluation_outcome, prize_tier,
       prize_facts, prize_facts_hash, payout_units, multiplier, replay_hash,
       idempotency_key, issued_at, provenance, canonical_payload,
       canonical_payload_hash)
     values ($1,$2,$3,$4,$5,$6,$7,'1.0.0',$8,$9,'1.0.0',$10,$11,'1.0.0',
       $12,'qa-evaluator:v1',$13,'QA', '{}'::jsonb,$14,0,1,$15,$16,now(),
       '{}'::jsonb,'{}'::jsonb,$17)`,
    [settlementInputId, mathCertificateId, mathHash, outcomeCertificateId,
      outcomeHash, ticketLineId, `qa-manifest-${suffix}`, sha256(`manifest:${suffix}`),
      `qa-math-${suffix}`, sha256(`math-model:${suffix}`), `qa-paytable-${suffix}`,
      sha256(`paytable:${suffix}`), outcome[0] + outcome.slice(1).toLowerCase(),
      mathHash, sha256(`replay:${suffix}`),
      `qa-settlement-input:${suffix}`, inputHash]
  );
  await pool.query(
    `insert into settlement_service.settlement_requests(
       settlement_request_id, idempotency_key, canonical_request_hash,
       settlement_input_id, settlement_input_hash,
       math_evaluation_certificate_id, math_evaluation_certificate_hash,
       outcome_certificate_id, outcome_certificate_hash, ticket_id,
       ticket_line_id, player_account_reference,
       accepted_wager_financial_context_reference, accepted_stake_amount_minor,
       currency, minor_unit_precision, rounding_policy_reference,
       credit_reservation_reference, settlement_policy_version, accepted_at,
       mode, status, request_provenance)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'USD',2,
       'rounding-policy:v1',$15,$16,now(),'DryRun','Accepted','{}'::jsonb)`,
    [settlementRequestId, `qa-settlement-request:${suffix}`,
      sha256(`settlement-request:${suffix}`), settlementInputId, inputHash,
      mathCertificateId, mathHash, outcomeCertificateId, outcomeHash,
      input.ticketId, ticketLineId, `qa-player:${suffix}`, `qa-context:${suffix}`,
      input.amountMinor, input.reservationId, settlementVersion]
  );
  await pool.query(
    `insert into settlement_service.authoritative_settlement_records(
       settlement_id, settlement_request_id, settlement_input_id,
       settlement_input_hash, math_evaluation_certificate_id,
       math_evaluation_certificate_hash, outcome_certificate_id,
       outcome_certificate_hash, ticket_id, ticket_line_id,
       player_account_reference, currency, minor_unit_precision,
       stake_amount_minor, gross_payout_amount_minor, net_result_amount_minor,
       settlement_outcome, policy_version, canonical_settlement_hash,
       idempotency_key, issued_at, provenance)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'USD',2,$12,$13,$14,$15,$16,$17,$18,now(),$19::jsonb)`,
    [settlementId, settlementRequestId, settlementInputId, inputHash,
      mathCertificateId, mathHash, outcomeCertificateId, outcomeHash,
      input.ticketId, ticketLineId, `qa-player:${suffix}`, input.amountMinor,
      Math.max(0, input.amountMinor + input.balanceImpactMinor),
      input.balanceImpactMinor, outcome, settlementVersion, settlementHash,
      `qa-settlement:${suffix}`, JSON.stringify(input.provenance ?? {})]
  );
  await pool.query(
    `insert into settlement_service.financial_instructions(
       instruction_id, settlement_id, settlement_request_id, instruction_type,
       instruction_status, canonical_payload_hash, idempotency_key,
       target_service, instruction_sequence, attempt_count, created_at, provenance)
     values
       ($1,$2,$3,$4,$5,$6,$7,'ledger-service',1,0,now(),$8::jsonb),
       ($9,$2,$3,$10,'Ready',$11,$12,'credit-wallet-service',2,0,now(),$13::jsonb)`,
    [ledgerInstructionId, settlementId, settlementRequestId, ledgerInstructionType,
      ledgerRequired ? "Ready" : "Skipped", ledgerInstructionHash,
      `qa-ledger-instruction:${suffix}`, JSON.stringify(input.provenance ?? {}),
      creditInstructionId, creditInstructionType, creditInstructionHash,
      `qa-credit-instruction:${suffix}`, JSON.stringify({
        ...input.provenance,
        amountMinor: input.amountMinor,
        captureAmountMinor: input.amountMinor,
        balanceImpactMinor: input.balanceImpactMinor,
      })]
  );

  return {
    settlementId,
    settlementHash,
    settlementVersion,
    ledgerInstructionId,
    ledgerInstructionHash,
    creditInstructionId,
    creditInstructionHash,
  };
}
