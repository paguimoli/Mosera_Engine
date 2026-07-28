import { readFileSync } from "node:fs";

const appUrl =
  process.env.QA_APP_URL || process.env.APP_URL || "http://localhost:3000";
const checks = [];

function check(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function source(path) {
  return readFileSync(path, "utf8");
}

async function request(path, options) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return { response, body };
}

const ticketRoute = source("app/api/tickets/route.ts");
const resultRoute = source("app/api/results/route.ts");
const ticketRpc = source(
  "supabase/migrations/20260618000300_add_ticket_accepted_outbox_event.sql"
);
const gameEngineEndpoints = source(
  "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs"
);
const platformCollectionRoute = source(
  "app/api/platform-management/[resource]/route.ts"
);
const platformRecordRoute = source(
  "app/api/platform-management/[resource]/[id]/route.ts"
);

const permissionIndex = ticketRoute.indexOf(
  'requirePermission(request, "tickets.create")'
);
const bodyReadIndex = ticketRoute.indexOf("request.json()");

check(
  "ticket intake requires tickets.create before reading or mutating",
  permissionIndex >= 0 && bodyReadIndex > permissionIndex
);
check(
  "ticket intake has no non-atomic HTTP outbox backstop",
  !ticketRoute.includes("createOutboxEvent") &&
    !ticketRoute.includes("ensureTicketAcceptedOutboxEvent")
);
check(
  "ticket placement RPC atomically appends ticket.accepted",
  ticketRpc.includes("insert into public.outbox_events") &&
    ticketRpc.includes("'ticket.accepted'")
);
check(
  "legacy result publisher is retired",
  resultRoute.includes("status: 410") &&
    resultRoute.includes('Deprecation: "true"') &&
    !resultRoute.includes('from("drawing_results")') &&
    !resultRoute.includes('from("normalized_drawings")')
);
check(
  "canonical outcome publication and settlement handoff endpoints exist",
  gameEngineEndpoints.includes('MapPost("/outcome-publications"') &&
    gameEngineEndpoints.includes('MapPost("/outcome-settlement-requests"')
);
check(
  "platform management exposes immutable create/read APIs only",
  platformCollectionRoute.includes("export async function GET") &&
    platformCollectionRoute.includes("export async function POST") &&
    !platformCollectionRoute.includes("export async function PATCH") &&
    !platformCollectionRoute.includes("export async function DELETE") &&
    platformRecordRoute.includes("export async function GET") &&
    !platformRecordRoute.includes("export async function PATCH") &&
    !platformRecordRoute.includes("export async function DELETE")
);

try {
  const unauthorizedTicket = await request("/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check(
    "runtime ticket intake fails closed without authentication",
    unauthorizedTicket.response.status === 401 &&
      unauthorizedTicket.body?.accepted === false,
    {
      status: unauthorizedTicket.response.status,
      body: unauthorizedTicket.body,
    }
  );

  const retiredResult = await request("/api/results", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check(
    "runtime legacy result publisher cannot mutate outcomes",
    retiredResult.response.status === 410 &&
      retiredResult.response.headers.get("deprecation") === "true" &&
      retiredResult.body?.accepted === false,
    {
      status: retiredResult.response.status,
      body: retiredResult.body,
    }
  );
} catch (error) {
  check("runtime launch API checks are reachable", false, {
    error: error instanceof Error ? error.message : String(error),
  });
}

const failed = checks.filter((item) => item.status === "FAIL");

console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "PASS" : "FAIL",
      appUrl,
      checks,
    },
    null,
    2
  )
);

process.exit(failed.length === 0 ? 0 : 1);
