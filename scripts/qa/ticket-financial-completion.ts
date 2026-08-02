import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { seedSettlementFixture, sha256 } from "./lib/credit-wallet-settlement-fixture";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
type Ticket = {
  ticket_id: string; player_account_id: string; player_profile_id: string;
  wallet_id: string; reservation_id: string; product_id: string; manifest_id: string;
  paytable_definition_id: string; draw_id: string; currency: string;
  tenant_id: string; brand_id: string; total_stake_minor: string;
  items: Array<{ ticketItemId: string; stakeMinor: number }>;
};

const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://localhost:5200").replace(/\/$/, "");
const creditUrl = (process.env.CREDIT_SERVICE_URL ?? "http://localhost:5300").replace(/\/$/, "");
const settlementUrl = (process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400").replace(/\/$/, "");
const creditApiKey = process.env.CREDIT_WALLET_INTERNAL_API_KEY ?? "local-credit-wallet-internal-key";

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) fail(message, metadata);
}
function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}
async function body(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}
function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  )).replaceAll("+", "\\u002B");
}
function dotnetTimestamp(value: string) {
  return new Date(value).toISOString().replace("Z", "0000+00:00");
}

async function reject(operation: () => Promise<unknown>, pattern: RegExp, name: string) {
  try {
    await operation();
    fail(`${name} unexpectedly succeeded.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `${name} failed for the wrong reason.`, { message });
    pass(name);
  }
}

async function loadAcceptedTicket(pool: Pool, fundingInstrument = "CREDIT"): Promise<Ticket> {
  const template = await pool.query<Ticket>(
    `select ticket_id::text, player_account_id::text, player_profile_id::text,
            wallet_id::text, reservation_id::text, product_id::text,
            manifest_id::text, paytable_definition_id::text, draw_id::text,
            currency, tenant_id::text, brand_id::text, total_stake_minor::text,
            (select jsonb_agg(jsonb_build_object(
              'ticketItemId', item.ticket_item_id,
              'stakeMinor', item.stake_minor
            ) order by item.item_index)
             from ticket_authority.ticket_items item
             where item.ticket_id=ticket.ticket_id) items
       from ticket_authority.tickets ticket
      where lifecycle_state='SETTLEMENT_REQUESTED' and funding_instrument=$1
        and not exists (
          select 1 from ticket_completion_authority.completion_evidence evidence
          where evidence.ticket_id=ticket.ticket_id
        )
      order by accepted_at desc limit 1`
  , [fundingInstrument]);
  assert(template.rows[0], "Canonical Ticket QA fixture is required before completion QA.");
  return template.rows[0];
}

async function verifyNoopFinancialCompletion(pool: Pool) {
  const ticket = await loadAcceptedTicket(pool, "FREE_PLAY");
  const fixtures = await Promise.all(ticket.items.map(async (item) => ({
    item,
    fixture: await seedSettlementFixture(pool, {
      tenantId: ticket.tenant_id, brandId: ticket.brand_id,
      reservationId: ticket.reservation_id, ticketId: ticket.ticket_id,
      ticketLineId: item.ticketItemId, amountMinor: item.stakeMinor,
      balanceImpactMinor: -item.stakeMinor, outcome: "LOSS",
      ledgerRequired: false, creditInstructionType: "CREDIT_NOOP",
      provenance: { qa: "ticket-financial-completion-noop" },
    }),
  })));

  const executions = [];
  for (const entry of fixtures) {
    executions.push(await executeSettlement(entry.fixture.settlementId));
  }
  assert(executions.every(entry => entry.response.ok),
    "Canonical no-op authority confirmations did not complete the losing ticket.",
    { executions: executions.map(entry => ({ status: entry.response.status, result: entry.result })) });

  const evidence = await pool.query(
    `select ticket.lifecycle_state, evidence.source_count,
            count(*) filter (where source.ledger_posting_request_id is null
              and source.wallet_operation_id is null)::int noop_sources,
            count(*) filter (where ledger_attempt.status='Skipped'
              and wallet_attempt.status='Skipped')::int skipped_confirmations
       from ticket_authority.tickets ticket
       join ticket_completion_authority.completion_evidence evidence using(ticket_id)
       join ticket_completion_authority.completion_sources source using(request_id)
       join settlement_service.financial_instruction_execution_attempts ledger_attempt
         on ledger_attempt.attempt_id=source.ledger_execution_attempt_id
       join settlement_service.financial_instruction_execution_attempts wallet_attempt
         on wallet_attempt.attempt_id=source.wallet_execution_attempt_id
      where ticket.ticket_id=$1
      group by ticket.ticket_id, evidence.source_count`,
    [ticket.ticket_id]
  );
  assert(evidence.rows[0]?.lifecycle_state === "REBATE_ELIGIBLE" &&
    Number(evidence.rows[0].source_count) === ticket.items.length &&
    Number(evidence.rows[0].noop_sources) === ticket.items.length &&
    Number(evidence.rows[0].skipped_confirmations) === ticket.items.length,
  "No-op financial completion evidence was incomplete.", evidence.rows[0] ?? {});
  pass("explicit Ledger and Wallet no-op confirmations complete zero-effect settlements");
}

async function postLedger(ticket: Ticket, fixture: Awaited<ReturnType<typeof seedSettlementFixture>>) {
  const idempotencyKey = `qa-completion-ledger-${fixture.ledgerInstructionId}`;
  const effectiveAt = new Date().toISOString();
  const amountMinor = 5;
  const material = {
    amountMinor, currency: ticket.currency, direction: "CREDIT",
    effectiveAt: dotnetTimestamp(effectiveAt), idempotencyKey,
    instructionHash: fixture.ledgerInstructionHash,
    instructionId: fixture.ledgerInstructionId, instructionType: "LEDGER_PAYOUT",
    ledgerAccountId: ticket.player_account_id, ledgerWalletId: ticket.wallet_id,
    minorUnitPrecision: 2, originatingAuthority: "settlement-service",
    referenceId: fixture.settlementId, referenceType: "settlement_record",
    reversalOfLedgerEntryId: null, settlementRecordId: fixture.settlementId,
    transactionType: "SETTLEMENT_CREDIT",
  };
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey,
      "x-correlation-id": `completion-ledger-${randomUUID()}` },
    body: JSON.stringify({
      walletId: ticket.wallet_id, ledgerAccountId: ticket.player_account_id,
      instructionId: fixture.ledgerInstructionId, instructionType: "LEDGER_PAYOUT",
      instructionHash: fixture.ledgerInstructionHash, originatingAuthority: "settlement-service",
      settlementRecordId: fixture.settlementId, transactionType: "SETTLEMENT_CREDIT",
      direction: "CREDIT", money: { amount: amountMinor, currency: ticket.currency },
      minorUnitPrecision: 2, canonicalRequestHash: sha256(canonicalJson(material)),
      effectiveAt, reference: { type: "settlement_record", id: fixture.settlementId },
      reversalOfLedgerEntryId: null, metadata: { qa: "ticket-financial-completion" },
    }),
  });
  const result = await body(response);
  assert(response.ok && result?.postingRequestId, "Ledger Authority did not complete posting.", {
    status: response.status, result,
  });
  return result.postingRequestId as string;
}

async function applyWallet(ticket: Ticket, fixture: Awaited<ReturnType<typeof seedSettlementFixture>>, stakeMinor: number) {
  const requestId = randomUUID();
  const response = await fetch(`${creditUrl}/v1/credit-wallets/internal/operations`, {
    method: "POST",
    headers: { "content-type": "application/json",
      "idempotency-key": `qa-completion-wallet-${fixture.creditInstructionId}`,
      "x-internal-service-name": "settlement-service", authorization: `Bearer ${creditApiKey}`,
      "x-correlation-id": `completion-wallet-${randomUUID()}` },
    body: JSON.stringify({
      requestId, tenantId: ticket.tenant_id, brandId: ticket.brand_id,
      playerId: ticket.player_account_id, walletId: ticket.wallet_id,
      instrument: "CREDIT", operation: "SETTLE",
      money: { amount: stakeMinor, currency: ticket.currency },
      balanceImpact: { amount: 5, currency: ticket.currency },
      authority: "settlement-service", effectiveAt: new Date().toISOString(),
      ticketId: ticket.ticket_id, reservationId: ticket.reservation_id,
      settlementId: fixture.settlementId, settlementBatchId: randomUUID(),
      settlementInstructionId: fixture.creditInstructionId,
      settlementInstructionSequence: 2,
      settlementInstructionHash: fixture.creditInstructionHash,
      settlementVersion: fixture.settlementVersion, settlementHash: fixture.settlementHash,
      settlementOutcome: "WIN", ledgerInstructionId: fixture.ledgerInstructionId,
      ledgerPostingRequired: true, originalOperationId: null, correctsOperationId: null,
      reasonCode: "QA_FINANCIAL_COMPLETION", sourceService: "settlement-service",
      auditMetadata: { qa: "ticket-financial-completion" },
    }),
  });
  const result = await body(response);
  assert(response.ok && result?.status === "COMMITTED", "Wallet Authority did not apply settlement.", {
    status: response.status, result,
  });
  return result.operationId as string;
}

async function recordLedgerExecutionEvidence(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof seedSettlementFixture>>,
  ledgerPostingRequestId: string,
) {
  const attemptId = randomUUID();
  await pool.query(
    `insert into settlement_service.financial_instruction_execution_attempts(
       attempt_id, instruction_id, settlement_id, attempt_number, status,
       target_service, target_idempotency_key, external_reference_type,
       external_reference_id, target_response_hash, evidence_hash
     ) values ($1,$2,$3,1,'Posted','ledger-service',$4,'ledger_posting_request',$5,$6,$7)`,
    [attemptId, fixture.ledgerInstructionId, fixture.settlementId,
      `qa-completion-execution:${fixture.ledgerInstructionId}`, ledgerPostingRequestId,
      sha256(`ledger-response:${ledgerPostingRequestId}`), sha256(`ledger-attempt:${fixture.ledgerInstructionId}`)]
  );
  return attemptId;
}

async function recordWalletExecutionEvidence(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof seedSettlementFixture>>,
  walletOperationId: string,
) {
  const attemptId = randomUUID();
  await pool.query(
    `insert into settlement_service.financial_instruction_execution_attempts(
       attempt_id, instruction_id, settlement_id, attempt_number, status,
       target_service, target_idempotency_key, external_reference_type,
       external_reference_id, target_response_hash, evidence_hash
     ) values ($1,$2,$3,1,'Posted','credit-wallet-service',$4,'wallet_operation',$5,$6,$7)`,
    [attemptId, fixture.creditInstructionId, fixture.settlementId,
      `qa-completion-execution:${fixture.creditInstructionId}`, walletOperationId,
      sha256(`wallet-response:${walletOperationId}`), sha256(`wallet-attempt:${fixture.creditInstructionId}`)]
  );
  return attemptId;
}

async function executeSettlement(settlementId: string) {
  const response = await fetch(
    `${settlementUrl}/v1/settlement/records/${settlementId}/financial-instructions/execute`,
    { method: "POST", headers: { "x-correlation-id": `completion-runtime-${randomUUID()}` } }
  );
  return { response, result: await body(response) };
}

async function main() {
  assert(databaseUrl, "DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const ticket = await loadAcceptedTicket(pool);
    const fixtures = await Promise.all(ticket.items.map(async (item) => ({
      item,
      fixture: await seedSettlementFixture(pool, {
        tenantId: ticket.tenant_id, brandId: ticket.brand_id,
        reservationId: ticket.reservation_id, ticketId: ticket.ticket_id,
        ticketLineId: item.ticketItemId, amountMinor: item.stakeMinor,
        balanceImpactMinor: 5, ledgerRequired: true,
        provenance: { qa: "ticket-financial-completion" },
      }),
    })));
    const completionSql = `select ticket_completion_authority.complete_ticket(
      $1,$2::jsonb,$3,$4,$5,$6
    ) result`;
    const key = `ticket-financial-completion:${ticket.ticket_id.replaceAll("-", "")}`;
    const source = (
      ledgerAttemptIds: string[], ledgerIds: Array<string | null>,
      walletAttemptIds: string[], walletIds: Array<string | null>
    ) => fixtures.map((entry, index) => ({
      ticketItemId: entry.item.ticketItemId, settlementId: entry.fixture.settlementId,
      ledgerExecutionAttemptId: ledgerAttemptIds[index],
      ledgerPostingRequestId: ledgerIds[index],
      walletExecutionAttemptId: walletAttemptIds[index],
      walletOperationId: walletIds[index],
    }));
    await reject(
      () => pool.query(completionSql, [ticket.ticket_id,
        JSON.stringify(source(fixtures.map(() => randomUUID()), fixtures.map(() => null),
          fixtures.map(() => randomUUID()), fixtures.map(() => null))), key,
        "qa-ticket-completion", `correlation:${key}`, null]),
      /Ledger confirmation/, "settlement alone cannot complete ticket"
    );
    const ledgerPostingRequestIds: string[] = [];
    const ledgerAttemptIds: string[] = [];
    for (const entry of fixtures) {
      const postingRequestId = await postLedger(ticket, entry.fixture);
      ledgerPostingRequestIds.push(postingRequestId);
      ledgerAttemptIds.push(await recordLedgerExecutionEvidence(pool, entry.fixture, postingRequestId));
    }
    pass("Settlement and Ledger authorities completed in order");
    await reject(
      () => pool.query(completionSql, [ticket.ticket_id,
        JSON.stringify(source(ledgerAttemptIds, ledgerPostingRequestIds,
          fixtures.map(() => randomUUID()), fixtures.map(() => null))), key,
        "qa-ticket-completion", `correlation:${key}`, null]),
      /Wallet confirmation/, "missing wallet confirmation fails closed"
    );
    const walletOperationIds: string[] = [];
    const walletAttemptIds: string[] = [];
    for (const entry of fixtures) {
      const operationId = await applyWallet(ticket, entry.fixture, entry.item.stakeMinor);
      walletOperationIds.push(operationId);
      walletAttemptIds.push(await recordWalletExecutionEvidence(pool, entry.fixture, operationId));
    }
    pass("Wallet Authority applied only after Ledger confirmation");

    const concurrent = await Promise.all([
      executeSettlement(fixtures[0].fixture.settlementId),
      executeSettlement(fixtures[0].fixture.settlementId),
    ]);
    assert(concurrent.every(entry => entry.response.ok),
      "Settlement runtime did not invoke Ticket Completion Authority successfully.",
      { concurrent: concurrent.map(entry => ({ status: entry.response.status, result: entry.result })) });
    const duplicate = await pool.query(completionSql, [ticket.ticket_id,
      JSON.stringify(source(ledgerAttemptIds, ledgerPostingRequestIds,
        walletAttemptIds, walletOperationIds)), key,
      "qa-ticket-completion", `correlation:${key}`, null]);
    assert(duplicate.rows[0].result.duplicate === true,
      "Duplicate completion did not return existing evidence.", duplicate.rows[0]);
    pass("Settlement runtime invokes one idempotent Completion Authority under concurrency");

    const state = await pool.query(
      `select ticket.status, ticket.lifecycle_state, ticket.lifecycle_version,
              evidence.completion_id::text, evidence.source_count,
              count(distinct source.source_id)::int source_rows,
              count(distinct event.event_id) filter (where event.command_type in (
                'ConfirmSettlement','PostLedger','ApplyWallet','MarkSettled',
                'MarkCommissionEligible','MarkRebateEligible'))::int completion_events
         from ticket_authority.tickets ticket
         join ticket_completion_authority.completion_evidence evidence
           on evidence.ticket_id=ticket.ticket_id
         join ticket_completion_authority.completion_sources source
           on source.request_id=evidence.request_id
         join ticket_authority.ticket_lifecycle_events event
           on event.ticket_id=ticket.ticket_id
        where ticket.ticket_id=$1
        group by ticket.ticket_id, evidence.completion_id, evidence.source_count`,
      [ticket.ticket_id]
    );
    assert(state.rows[0].status === "SETTLED" &&
      state.rows[0].lifecycle_state === "REBATE_ELIGIBLE" &&
      Number(state.rows[0].source_count) === ticket.items.length &&
      Number(state.rows[0].source_rows) === ticket.items.length &&
      Number(state.rows[0].completion_events) === 6,
    "Ticket completion evidence or lifecycle was incomplete.", state.rows[0]);
    pass("ticket settles and compensation eligibility follows complete financial evidence");

    await reject(
      () => pool.query(completionSql, [ticket.ticket_id,
        JSON.stringify(source(ledgerAttemptIds, ledgerPostingRequestIds,
          walletAttemptIds, walletOperationIds.map(() => randomUUID()))), key,
        "qa-ticket-completion", `correlation:${key}`, null]),
      /conflicts/, "conflicting completion idempotency fails closed"
    );
    await reject(
      () => pool.query(
        `update ticket_completion_authority.completion_evidence
            set canonical_completion_hash=$2 where ticket_id=$1`,
        [ticket.ticket_id, sha256("tamper")]
      ), /append-only/, "completion evidence is immutable"
    );
    const duplicates = await pool.query(
      `select
        (select count(*) from settlement_service.authoritative_settlement_records where settlement_id=any($1::uuid[]))::int settlements,
        (select count(*) from ledger_service.ledger_posting_requests where id=any($2::uuid[]))::int ledger_requests,
        (select count(*) from credit_wallet_service.wallet_operation_terminal_results where operation_id=any($3::uuid[]))::int wallet_results,
        (select count(*) from ticket_completion_authority.completion_evidence where ticket_id=$4)::int completions,
        (select count(*) from compensation.entitlements where canonical_entitlement_hash=$5)::int compensation_effects`,
      [fixtures.map((entry) => entry.fixture.settlementId), ledgerPostingRequestIds, walletOperationIds,
        ticket.ticket_id, sha256(`ticket:${ticket.ticket_id}`)]
    );
    assert(Object.entries(duplicates.rows[0]).every(([keyName, value]) =>
      keyName === "compensation_effects" ? Number(value) === 0 :
        keyName === "completions" ? Number(value) === 1 : Number(value) === ticket.items.length),
    "Completion duplicated financial or compensation effects.", duplicates.rows[0]);
    pass("completion retries do not duplicate financial or compensation effects");

    const directCommands = await pool.query(
      `select count(*)::int count from pg_proc procedure
       join pg_namespace namespace on namespace.oid=procedure.pronamespace
       where namespace.nspname='ticket_authority'
         and procedure.proname=any($1::text[])`,
      [["confirm_settlement", "post_ledger", "apply_wallet", "mark_settled",
        "mark_commission_eligible", "mark_rebate_eligible"]]
    );
    assert(directCommands.rows[0].count === 0, "Direct completion lifecycle paths remain.");
    const compensationSource = readFileSync(
      "src/domains/compensation/compensation.repository.ts", "utf8"
    );
    assert(compensationSource.includes("ticket_completion_authority.completion_evidence"),
      "Compensation does not consume completed Ticket evidence.");
    pass("one Completion Authority owns completion and Compensation consumes completed tickets only");

    await verifyNoopFinancialCompletion(pool);

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail("Ticket financial completion QA failed unexpectedly.", {
  error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
}));
