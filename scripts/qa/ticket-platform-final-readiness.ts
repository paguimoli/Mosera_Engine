import { readFileSync } from "node:fs";
import { Pool } from "pg";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
const checks: Check[] = [];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) {
    console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
    process.exit(1);
  }
}

async function main() {
  try {
    const readiness = await pool.query<{
      check_name: string; ready: boolean; issue_count: string;
    }>("select * from ticket_authority.ticket_platform_readiness()");
    const required = [
      "acceptance_authority", "effective_availability_authority", "liability_authority",
      "reservation_and_funding_authority", "settlement_ingestion_lifecycle_gate",
      "financial_completion_authority", "ledger_wallet_completion_evidence",
      "typed_lifecycle_authority", "replay_and_recovery_authority", "exception_authority",
      "compensation_handoff", "draw_outcome_lineage", "hierarchy_and_scope_binding",
      "referential_integrity", "legacy_mutation_paths_retired",
    ];
    assert(required.every((name) => readiness.rows.some((row) => row.check_name === name)),
      "Ticket Platform readiness is missing required authority checks.", { readiness: readiness.rows });
    assert(readiness.rows.every((row) => row.ready && Number(row.issue_count) === 0),
      "Ticket Platform readiness failed closed.", { readiness: readiness.rows });
    pass("one aggregate Ticket Platform readiness evaluation passes", { checks: readiness.rows.length });

    const authority = await pool.query(`
      select
        to_regprocedure('ticket_authority.accept_ticket(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text)') is not null acceptance,
        to_regprocedure('ticket_authority.request_settlement(uuid,text,text,text,text,text,text,text,jsonb)') is not null settlement_request,
        to_regprocedure('ticket_completion_authority.complete_ticket(uuid,jsonb,text,text,text,text)') is not null completion,
        to_regprocedure('ticket_exception_authority.request_operation(text,uuid,integer,text,text,text,text,text,text,text,text,uuid,uuid,uuid)') is not null exception_request,
        to_regprocedure('ticket_authority.confirm_settlement(uuid,text,text,text,text,text,text,text,jsonb)') is null direct_confirm_retired,
        to_regprocedure('ticket_authority.post_ledger(uuid,text,text,text,text,text,text,text,jsonb)') is null direct_ledger_retired,
        to_regprocedure('ticket_authority.apply_wallet(uuid,text,text,text,text,text,text,text,jsonb)') is null direct_wallet_retired,
        to_regprocedure('ticket_authority.mark_settled(uuid,text,text,text,text,text,text,text,jsonb)') is null direct_settled_retired
    `);
    assert(authority.rows[0] && Object.values(authority.rows[0]).every(Boolean),
      "Canonical authority ownership or legacy retirement is incomplete.", authority.rows[0] ?? {});
    pass("one acceptance, settlement request, completion, and exception path remains");

    const gate = await pool.query(`
      select exists(
        select 1 from pg_trigger
        where tgrelid='settlement_service.settlement_requests'::regclass
          and tgname='trg_bind_ticket_settlement_request' and tgenabled <> 'D'
      ) enabled,
      (select count(*)::int
       from settlement_service.settlement_requests request
       join ticket_authority.tickets ticket on ticket.ticket_id::text=request.ticket_id
       where ticket.lineage_model='CANONICAL_V1'
         and ticket.lifecycle_state='RESERVATION_CREATED'
         and request.status='Accepted') orphan_count
    `);
    assert(gate.rows[0]?.enabled && gate.rows[0]?.orphan_count === 0,
      "Settlement ingestion can bypass typed Ticket lifecycle evidence.", gate.rows[0] ?? {});
    pass("SettlementInput ingestion and lifecycle transition are atomic");

    const canonicalRepository = readFileSync(
      "src/domains/tickets/canonical-ticket.repository.ts", "utf8");
    const healthRoute = readFileSync("app/api/health/ready/route.ts", "utf8");
    const ticketRoutes = [
      "app/api/tickets/route.ts", "app/api/tickets/[ticketId]/route.ts",
      "app/api/tickets/[ticketId]/history/route.ts", "app/api/tickets/[ticketId]/cancel/route.ts",
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    assert(canonicalRepository.includes("ticket_platform_readiness()") &&
      healthRoute.includes("ticketPlatformBackendFreezeReady"),
      "Runtime readiness is not using the aggregate Ticket Platform evaluation.");
    pass("existing readiness endpoint exposes canonical Ticket Platform readiness");
    assert(ticketRoutes.includes("canonical-ticket.repository") &&
      !ticketRoutes.includes('from "@/src/domains/tickets/ticket.repository"') &&
      !ticketRoutes.includes('from "@/src/domains/tickets/ticket.service"'),
      "A production Ticket API route uses a legacy authority path.");
    pass("production Ticket APIs use only the canonical repository");

    const settlementRepository = readFileSync(
      "services/settlement-service/Infrastructure/TicketCompletionRepository.cs", "utf8");
    assert(settlementRepository.includes("ticket_completion_authority.complete_ticket") &&
      !settlementRepository.includes("ticket_authority.mark_settled"),
      "Settlement Service bypasses Ticket Completion Authority.");
    pass("Settlement Service completes tickets only through Completion Authority");

    const worker = readFileSync(
      "src/domains/workers/canonical-settlement-request-handler.ts", "utf8");
    assert(worker.includes("game_engine.outcome_settlement_requests") &&
      worker.includes("settlement_service.authoritative_settlement_records") &&
      !worker.includes("ticket.repository"),
      "Canonical Settlement worker bypasses durable Outcome or Settlement evidence.");
    pass("worker consumes canonical outcome and authoritative Settlement evidence only");

    const noFinancialBypass = await pool.query(`
      select count(*)::int issue_count
      from ticket_completion_authority.completion_evidence evidence
      where not exists (
        select 1 from ticket_completion_authority.completion_sources source
        where source.request_id=evidence.request_id
          and source.ledger_execution_attempt_id is not null
          and source.wallet_execution_attempt_id is not null
      )
    `);
    assert(noFinancialBypass.rows[0]?.issue_count === 0,
      "Completed ticket lacks authoritative Ledger or Wallet attempt evidence.", noFinancialBypass.rows[0] ?? {});
    pass("completion cannot bypass Ledger or Wallet authority evidence");

    console.log(JSON.stringify({
      status: "PASS", message: "BF-5.7 Ticket Platform final readiness QA passed.", checks,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error), checks }, null, 2));
  process.exit(1);
});
