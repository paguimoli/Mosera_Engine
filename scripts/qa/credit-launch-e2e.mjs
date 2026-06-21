import "./load-session-env.mjs";

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const MONEY = Object.freeze({
  creditLimit: 10000,
  ticketStake: 1000,
  settlementNetAmount: -1000,
  commissionBasisPoints: 1000,
});

const REQUIRED_TABLES = [
  "accounts",
  "brands",
  "markets",
  "organizations",
  "financial_wallets",
  "players",
  "player_profiles",
  "normalized_drawings",
  "tickets",
  "credit_reservations",
  "credit_reservation_releases",
  "credit_settlement_applications",
  "weekly_accounting_snapshots",
  "commission_plans",
  "commission_runs",
  "commission_run_details",
  "reconciliation_runs",
  "reconciliation_run_findings",
];

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

class QaFailure extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = "QaFailure";
    this.metadata = metadata;
  }
}

function log(message, metadata = {}) {
  console.log(
    JSON.stringify({
      level: "info",
      message,
      ...metadata,
    })
  );
}

function assertQa(condition, message, metadata = {}) {
  if (!condition) {
    throw new QaFailure(message, metadata);
  }
}

function getRequiredEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];

    if (value) {
      return value;
    }
  }

  throw new QaFailure(`Missing required env var: ${keys.join(" or ")}`);
}

function asString(value, fieldName) {
  assertQa(typeof value === "string" && value.length > 0, `${fieldName} missing.`);
  return value;
}

function startOfUtcWeek(date) {
  const current = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const day = current.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  current.setUTCDate(current.getUTCDate() + diff);
  current.setUTCHours(0, 0, 0, 0);
  return current;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function createSupabaseClient() {
  const url = getRequiredEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });
}

async function querySingle(supabase, table, select, filters) {
  let query = supabase.from(table).select(select).limit(1);

  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new QaFailure(`Query failed for ${table}.`, {
      code: error.code,
      message: error.message,
    });
  }

  return data;
}

async function insertAndReturn(supabase, table, payload, select = "*") {
  const { data, error } = await supabase
    .from(table)
    .insert(payload)
    .select(select)
    .single();

  if (error) {
    throw new QaFailure(`Insert failed for ${table}.`, {
      code: error.code,
      message: error.message,
      payload,
    });
  }

  return data;
}

async function updateAndReturn(supabase, table, filters, payload, select = "*") {
  let query = supabase.from(table).update(payload);

  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }

  const { data, error } = await query.select(select).single();

  if (error) {
    throw new QaFailure(`Update failed for ${table}.`, {
      code: error.code,
      message: error.message,
      payload,
    });
  }

  return data;
}

async function assertRequiredTables(supabase) {
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select("*", { head: true }).limit(1);

    if (error) {
      throw new QaFailure(`Required table is unavailable: ${table}`, {
        table,
        code: error.code,
        message: error.message,
      });
    }
  }
}

async function getOrCreateBrand(supabase, runId) {
  const code = `QA125BR${runId}`;
  const existing = await querySingle(supabase, "brands", "*", { code });

  if (existing) {
    return updateAndReturn(
      supabase,
      "brands",
      { id: existing.id },
      {
        name: "QA Credit Launch Brand",
        display_name: "QA Credit Launch Brand",
        status: "ACTIVE",
        is_default: false,
      }
    );
  }

  return insertAndReturn(supabase, "brands", {
    code,
    name: "QA Credit Launch Brand",
    display_name: "QA Credit Launch Brand",
    status: "ACTIVE",
    is_default: false,
  });
}

async function getOrCreateMarket(supabase, runId) {
  const code = `QA125MK${runId}`;
  const existing = await querySingle(supabase, "markets", "*", { code });

  if (existing) {
    return updateAndReturn(
      supabase,
      "markets",
      { id: existing.id },
      {
        name: "QA Credit Launch Market",
        currency_code: "USD",
        language_code: "en",
        timezone: "America/New_York",
        brand_code: "QA",
        status: "ACTIVE",
        is_default: false,
      }
    );
  }

  return insertAndReturn(supabase, "markets", {
    code,
    name: "QA Credit Launch Market",
    currency_code: "USD",
    language_code: "en",
    timezone: "America/New_York",
    brand_code: "QA",
    status: "ACTIVE",
    is_default: false,
  });
}

async function getOrCreateAccount(supabase, input) {
  const existing = await querySingle(supabase, "accounts", "*", {
    account_code: input.account_code,
  });

  const payload = {
    account_type: input.account_type,
    account_code: input.account_code,
    display_name: input.display_name,
    parent_account_id: input.parent_account_id ?? null,
    market_id: input.market_id,
    brand_id: input.brand_id,
    status: "ACTIVE",
    funding_model: input.funding_model ?? null,
    operating_mode: input.operating_mode ?? null,
    balance_authority: input.balance_authority ?? null,
    default_funding_source: input.default_funding_source ?? null,
    weekly_accounting_mode: input.weekly_accounting_mode ?? "CARRY_BALANCE",
    settlement_mode: input.settlement_mode ?? "AUTO_SETTLEMENT",
  };

  if (existing) {
    return updateAndReturn(supabase, "accounts", { id: existing.id }, payload);
  }

  return insertAndReturn(supabase, "accounts", payload);
}

async function ensurePlayerProfile(supabase, playerAccount, externalPlayerId, runId) {
  const existing = await querySingle(supabase, "player_profiles", "*", {
    account_id: playerAccount.id,
  });
  const payload = {
    account_id: playerAccount.id,
    display_name: "QA Credit Launch Player",
    email: `qa-credit-launch-${runId}@example.test`,
    external_player_id: externalPlayerId,
    external_platform: "qa-harness",
    status: "ACTIVE",
  };

  if (existing) {
    return updateAndReturn(supabase, "player_profiles", { id: existing.id }, payload);
  }

  return insertAndReturn(supabase, "player_profiles", payload);
}

async function ensureCreditWallet(supabase, playerAccount) {
  const existing = await querySingle(supabase, "financial_wallets", "*", {
    account_id: playerAccount.id,
    wallet_type: "CREDIT",
  });
  const payload = {
    account_id: playerAccount.id,
    wallet_type: "CREDIT",
    currency_code: "USD",
    balance_authority: "INTERNAL",
    status: "ACTIVE",
    balance: 0,
    credit_limit: MONEY.creditLimit,
    funding_model: "CREDIT",
    operating_mode: null,
    default_funding_source: "CREDIT",
  };

  if (existing) {
    return updateAndReturn(supabase, "financial_wallets", { id: existing.id }, payload);
  }

  return insertAndReturn(supabase, "financial_wallets", payload);
}

async function ensureCommissionPlan(supabase, agentAccount, runId) {
  const code = `QA125COMM${runId}`;
  const existing = await querySingle(supabase, "commission_plans", "*", { code });
  const payload = {
    code,
    name: "QA Credit Launch Commission Plan",
    description: "QA harness loss-based commission plan.",
    calculation_basis: "NET_LOSS",
    status: "ACTIVE",
    account_id: agentAccount.id,
    account_type: "AGENT",
    commission_type: "LOSS_BASED_PERCENTAGE",
    percentage_basis_points: MONEY.commissionBasisPoints,
    active: true,
  };

  if (existing) {
    return updateAndReturn(supabase, "commission_plans", { id: existing.id }, payload);
  }

  return insertAndReturn(supabase, "commission_plans", payload);
}

async function identifyOrganization(supabase) {
  if (process.env.QA_ORGANIZATION_ID) {
    const organization = await querySingle(supabase, "organizations", "id", {
      id: process.env.QA_ORGANIZATION_ID,
    });

    assertQa(Boolean(organization), "QA_ORGANIZATION_ID was not found.", {
      organizationId: process.env.QA_ORGANIZATION_ID,
    });

    return organization;
  }

  if (process.env.QA_ORGANIZATION_EXTERNAL_ID) {
    const organization = await querySingle(supabase, "organizations", "id", {
      external_organization_id: process.env.QA_ORGANIZATION_EXTERNAL_ID,
    });

    assertQa(Boolean(organization), "QA_ORGANIZATION_EXTERNAL_ID was not found.", {
      externalOrganizationId: process.env.QA_ORGANIZATION_EXTERNAL_ID,
    });

    return organization;
  }

  const { data, error } = await supabase.from("organizations").select("id").limit(1);

  if (error) {
    throw new QaFailure("Organization lookup failed.", {
      code: error.code,
      message: error.message,
    });
  }

  assertQa(
    Array.isArray(data) && data.length > 0,
    "No organization is available for ticket placement. Set QA_ORGANIZATION_ID.",
    {}
  );

  return data[0];
}

async function ensureExternalPlayer(supabase, organizationId, playerAccount, runId) {
  if (process.env.QA_PLAYER_ID) {
    const player = await querySingle(supabase, "players", "id", {
      id: process.env.QA_PLAYER_ID,
    });

    assertQa(Boolean(player), "QA_PLAYER_ID was not found.", {
      playerId: process.env.QA_PLAYER_ID,
    });

    return {
      id: player.id,
      externalPlayerId: process.env.QA_PLAYER_EXTERNAL_ID ?? null,
    };
  }

  const externalPlayerId =
    process.env.QA_PLAYER_EXTERNAL_ID ?? `QA125-PLAYER-${runId}`;
  const existing = await querySingle(supabase, "players", "*", {
    organization_id: organizationId,
    external_player_id: externalPlayerId,
  });

  if (existing) {
    return {
      id: existing.id,
      externalPlayerId,
    };
  }

  const attempts = [
    {
      organization_id: organizationId,
      external_player_id: externalPlayerId,
      account_id: playerAccount.id,
      username: `qa125-player-${runId}`.toLowerCase(),
      display_name: "QA Credit Launch Player",
      status: "ACTIVE",
      currency: "USD",
    },
    {
      organization_id: organizationId,
      external_player_id: externalPlayerId,
      account_id: playerAccount.id,
      username: `qa125-player-${runId}`.toLowerCase(),
      display_name: "QA Credit Launch Player",
      status: "ACTIVE",
    },
    {
      organization_id: organizationId,
      external_player_id: externalPlayerId,
      account_id: playerAccount.id,
      username: `qa125-player-${runId}`.toLowerCase(),
    },
    {
      organization_id: organizationId,
      external_player_id: externalPlayerId,
      username: `qa125-player-${runId}`.toLowerCase(),
      display_name: "QA Credit Launch Player",
      status: "ACTIVE",
    },
    {
      organization_id: organizationId,
      external_player_id: externalPlayerId,
      username: `qa125-player-${runId}`.toLowerCase(),
    },
  ];
  let lastError = null;

  for (const payload of attempts) {
    const { data, error } = await supabase
      .from("players")
      .insert(payload)
      .select("*")
      .single();

    if (!error) {
      return {
        id: data.id,
        externalPlayerId,
      };
    }

    lastError = error;
  }

  throw new QaFailure("Unable to create external player row.", {
    code: lastError?.code,
    message: lastError?.message,
  });
}

async function identifyDrawing(supabase) {
  if (process.env.QA_DRAW_ID) {
    const drawing = await querySingle(supabase, "normalized_drawings", "id, game_id", {
      id: process.env.QA_DRAW_ID,
    });

    assertQa(Boolean(drawing), "QA_DRAW_ID was not found.", {
      drawingId: process.env.QA_DRAW_ID,
    });

    return drawing;
  }

  if (process.env.QA_DRAWING_EXTERNAL_ID) {
    const drawing = await querySingle(supabase, "normalized_drawings", "id, game_id", {
      external_id: process.env.QA_DRAWING_EXTERNAL_ID,
    });

    assertQa(Boolean(drawing), "QA_DRAWING_EXTERNAL_ID was not found.", {
      drawingExternalId: process.env.QA_DRAWING_EXTERNAL_ID,
    });

    return drawing;
  }

  const { data, error } = await supabase
    .from("normalized_drawings")
    .select("id, game_id")
    .limit(1);

  if (error) {
    throw new QaFailure("Drawing lookup failed.", {
      code: error.code,
      message: error.message,
    });
  }

  assertQa(
    Array.isArray(data) && data.length > 0,
    "No normalized drawing is available for ticket placement. Set QA_DRAW_ID.",
    {}
  );

  return data[0];
}

async function getPlayerCreditSummary(supabase, playerId) {
  const { data, error } = await supabase.rpc("get_player_credit_summary", {
    p_player_id: playerId,
  });

  if (error) {
    throw new QaFailure("Credit summary RPC failed.", {
      code: error.code,
      message: error.message,
      playerId,
    });
  }

  return data;
}

async function placeCreditTicket(supabase, input) {
  const { data, error } = await supabase.rpc("place_ticket_with_wallet_debit", {
    p_organization_id: input.organizationId,
    p_player_id: input.playerId,
    p_drawing_id: input.drawingId,
    p_external_ticket_id: input.externalTicketId,
    p_source_type: "qa_harness",
    p_currency: "USD",
    p_total_amount: MONEY.ticketStake,
    p_legs: [
      {
        betType: "qa-credit-launch",
        numbers: "01,02,03",
        amount: MONEY.ticketStake,
        stakeMode: "STRAIGHT",
        selectionMethod: "manual",
      },
    ],
    p_idempotency_key: input.idempotencyKey,
    p_correlation_id: input.correlationId,
  });

  if (error) {
    throw new QaFailure("Ticket placement RPC failed.", {
      code: error.code,
      message: error.message,
    });
  }

  assertQa(data?.accepted === true, "Ticket placement was rejected.", {
    response: data,
  });

  return data;
}

async function applySettlement(supabase, input) {
  const { data, error } = await supabase.rpc("apply_credit_settlement", {
    p_reservation_id: input.reservationId,
    p_ticket_id: input.ticketId,
    p_settlement_id: input.settlementId,
    p_release_amount: MONEY.ticketStake,
    p_balance_impact: MONEY.settlementNetAmount,
    p_currency: "USD",
    p_idempotency_key: input.idempotencyKey,
    p_correlation_id: input.correlationId,
    p_metadata: {
      source: "qa_credit_launch_e2e",
      runId: input.runId,
    },
  });

  if (error) {
    throw new QaFailure("Credit settlement RPC failed.", {
      code: error.code,
      message: error.message,
      reservationId: input.reservationId,
      ticketId: input.ticketId,
    });
  }

  return data;
}

async function closeWeeklyAccounting(supabase, input) {
  const { data, error } = await supabase.rpc("generate_weekly_accounting_snapshots", {
    p_week_start: input.weekStart,
    p_week_end: input.weekEnd,
    p_account_scope: input.superMasterId,
    p_currency: "USD",
    p_close_mode: "CARRY_BALANCE",
    p_correlation_id: input.correlationId,
  });

  if (error) {
    throw new QaFailure("Weekly accounting snapshot generation failed.", {
      code: error.code,
      message: error.message,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
    });
  }

  return data ?? [];
}

async function generateCommissionRun(supabase, input) {
  const { data, error } = await supabase.rpc("generate_commission_run_from_snapshots", {
    p_week_start: input.weekStart,
    p_week_end: input.weekEnd,
    p_currency: "USD",
    p_correlation_id: input.correlationId,
  });

  if (error) {
    throw new QaFailure("Commission run generation failed.", {
      code: error.code,
      message: error.message,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
    });
  }

  return data;
}

async function runReconciliation(appUrl, authToken, input) {
  if (!authToken) {
    throw new QaFailure("QA_ADMIN_SESSION_TOKEN is required to run reconciliation API.");
  }

  const response = await fetch(`${appUrl}/api/reconciliation/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
      "x-correlation-id": input.correlationId,
    },
    body: JSON.stringify({
      runType: "FULL",
      scopeType: "WEEK",
      scopeId: input.superMasterId,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      currency: "USD",
    }),
  });
  const body = await response.json().catch(() => null);

  assertQa(response.ok, "Reconciliation API request failed.", {
    status: response.status,
    body,
  });
  assertQa(body?.success === true, "Reconciliation API returned unsuccessful body.", {
    body,
  });
  assertQa(body.run?.status === "COMPLETED", "Reconciliation run did not complete.", {
    body,
  });

  return body;
}

async function main() {
  const runId =
    process.env.QA_RUN_ID ??
    new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const correlationId = `qa-credit-launch-${runId}-${randomUUID()}`;
  const appUrl = process.env.QA_APP_URL ?? "http://localhost:3000";
  const supabase = createSupabaseClient();
  const weekStart = startOfUtcWeek(new Date()).toISOString();
  const weekEnd = addDays(new Date(weekStart), 7).toISOString();

  log("Starting credit launch E2E QA harness.", {
    runId,
    correlationId,
    appUrl,
  });

  await assertRequiredTables(supabase);

  const brand = await getOrCreateBrand(supabase, runId);
  const market = await getOrCreateMarket(supabase, runId);
  const organization = await identifyOrganization(supabase);
  const drawing = await identifyDrawing(supabase);
  const gameId = process.env.QA_GAME_ID ?? drawing.game_id ?? "qa-logical-game";
  const superMaster = await getOrCreateAccount(supabase, {
    account_type: "SUPER_MASTER",
    account_code: `QA125${runId}SM`,
    display_name: "QA Credit Launch Super Master",
    market_id: market.id,
    brand_id: brand.id,
    operating_mode: "CREDIT_EXPOSURE",
  });
  const master = await getOrCreateAccount(supabase, {
    account_type: "MASTER_AGENT",
    account_code: `QA125${runId}MA`,
    display_name: "QA Credit Launch Master",
    parent_account_id: superMaster.id,
    market_id: market.id,
    brand_id: brand.id,
    operating_mode: "CREDIT_EXPOSURE",
  });
  const agent = await getOrCreateAccount(supabase, {
    account_type: "AGENT",
    account_code: `QA125${runId}AG`,
    display_name: "QA Credit Launch Agent",
    parent_account_id: master.id,
    market_id: market.id,
    brand_id: brand.id,
    operating_mode: "CREDIT_EXPOSURE",
  });
  const player = await getOrCreateAccount(supabase, {
    account_type: "PLAYER",
    account_code: `QA125${runId}PL`,
    display_name: "QA Credit Launch Player",
    parent_account_id: agent.id,
    market_id: market.id,
    brand_id: brand.id,
    funding_model: "CREDIT",
    balance_authority: "INTERNAL",
    default_funding_source: "CREDIT",
    weekly_accounting_mode: "CARRY_BALANCE",
    settlement_mode: "AUTO_SETTLEMENT",
  });

  const externalPlayer = await ensureExternalPlayer(
    supabase,
    organization.id,
    player,
    runId
  );

  await ensurePlayerProfile(supabase, player, externalPlayer.externalPlayerId, runId);
  const wallet = await ensureCreditWallet(supabase, player);
  await ensureCommissionPlan(supabase, agent, runId);

  const startingSummary = await getPlayerCreditSummary(supabase, player.id);

  assertQa(Number(startingSummary.creditLimit) === MONEY.creditLimit, "Credit limit mismatch.", {
    playerId: player.id,
    walletId: wallet.id,
    summary: startingSummary,
  });
  assertQa(Number(startingSummary.availableCredit) === MONEY.creditLimit, "Starting available credit mismatch.", {
    playerId: player.id,
    summary: startingSummary,
  });

  const externalTicketId = `QA125-TICKET-${runId}`;
  const ticketResponse = await placeCreditTicket(supabase, {
    organizationId: organization.id,
    playerId: externalPlayer.id,
    drawingId: drawing.id,
    externalTicketId,
    idempotencyKey: `qa125-ticket-${runId}`,
    correlationId,
  });
  const ticketId = asString(ticketResponse.ticketId, "ticketId");
  const reservationId = asString(
    ticketResponse.creditReservationId,
    "creditReservationId"
  );
  const ticket = await querySingle(
    supabase,
    "tickets",
    "id, status, currency, total_amount, credit_reservation_id",
    { id: ticketId }
  );
  const reservation = await querySingle(
    supabase,
    "credit_reservations",
    "*",
    { id: reservationId }
  );

  assertQa(Boolean(ticket), "Ticket row was not persisted.", { ticketId });
  assertQa(ticket.credit_reservation_id === reservationId, "Ticket reservation id mismatch.", {
    ticketId,
    reservationId,
    ticketReservationId: ticket.credit_reservation_id,
  });
  assertQa(Boolean(reservation), "Reservation row was not persisted.", {
    reservationId,
  });
  assertQa(Number(reservation.reserved_amount) === MONEY.ticketStake, "Reservation amount does not match ticket stake.", {
    ticketId,
    reservationId,
    reservedAmount: reservation.reserved_amount,
    ticketStake: MONEY.ticketStake,
  });
  assertQa(Number(reservation.remaining_exposure) === MONEY.ticketStake, "Initial remaining exposure mismatch.", {
    reservationId,
    remainingExposure: reservation.remaining_exposure,
  });

  const reservedSummary = await getPlayerCreditSummary(supabase, player.id);
  assertQa(Number(reservedSummary.pendingExposure) === MONEY.ticketStake, "Pending exposure did not increase.", {
    playerId: player.id,
    summary: reservedSummary,
  });
  assertQa(
    Number(reservedSummary.availableCredit) ===
      MONEY.creditLimit - MONEY.ticketStake,
    "Available credit formula failed after reservation.",
    { playerId: player.id, summary: reservedSummary }
  );

  const settlementId = `QA125-SETTLEMENT-${runId}`;
  const settlement = await applySettlement(supabase, {
    reservationId,
    ticketId,
    settlementId,
    idempotencyKey: `qa125-settlement-${runId}`,
    correlationId,
    runId,
  });

  await updateAndReturn(supabase, "tickets", { id: ticketId }, { status: "settled" });

  assertQa(Number(settlement.releaseAmount) === MONEY.ticketStake, "Settlement release amount mismatch.", {
    settlement,
  });
  assertQa(Number(settlement.balanceImpact) === MONEY.settlementNetAmount, "Settlement balance impact mismatch.", {
    settlement,
  });
  assertQa(Number(settlement.remainingExposure) === 0, "Exposure was not fully released.", {
    settlement,
  });

  const release = await querySingle(
    supabase,
    "credit_reservation_releases",
    "*",
    { reservation_id: reservationId }
  );
  const application = await querySingle(
    supabase,
    "credit_settlement_applications",
    "*",
    { id: settlement.applicationId }
  );
  const settledSummary = await getPlayerCreditSummary(supabase, player.id);

  assertQa(Boolean(release), "Reservation release row missing.", {
    reservationId,
  });
  assertQa(Boolean(application), "Settlement application row missing.", {
    reservationId,
    applicationId: settlement.applicationId,
  });
  assertQa(Number(application.balance_impact) === MONEY.settlementNetAmount, "Application balance impact mismatch.", {
    application,
  });
  assertQa(Number(settledSummary.pendingExposure) === 0, "Pending exposure did not release.", {
    summary: settledSummary,
  });
  assertQa(Number(settledSummary.balance) === MONEY.settlementNetAmount, "Credit balance did not update.", {
    summary: settledSummary,
  });
  assertQa(
    Number(settledSummary.availableCredit) ===
      MONEY.creditLimit + MONEY.settlementNetAmount,
    "Available credit formula failed after settlement.",
    { summary: settledSummary }
  );

  const snapshots = await closeWeeklyAccounting(supabase, {
    superMasterId: superMaster.id,
    weekStart,
    weekEnd,
    correlationId,
  });
  const playerSnapshot = snapshots.find(
    (snapshot) => snapshot.account_id === player.id || snapshot.accountId === player.id
  );

  assertQa(Boolean(playerSnapshot), "Player weekly accounting snapshot missing.", {
    playerId: player.id,
    weekStart,
    weekEnd,
    snapshotCount: snapshots.length,
  });
  assertQa(Number(playerSnapshot.net_result ?? playerSnapshot.netResult) === MONEY.settlementNetAmount, "Weekly snapshot net result mismatch.", {
    playerSnapshot,
  });

  const commissionRun = await generateCommissionRun(supabase, {
    weekStart,
    weekEnd,
    correlationId,
  });
  const commissionRunId = asString(commissionRun.runId ?? commissionRun.id, "commissionRunId");
  const commissionDetail = await querySingle(
    supabase,
    "commission_run_details",
    "*",
    {
      run_id: commissionRunId,
      account_id: agent.id,
    }
  );

  assertQa(Boolean(commissionDetail), "Agent commission run detail missing.", {
    commissionRun,
    agentId: agent.id,
  });

  const reconciliation = await runReconciliation(
    appUrl,
    process.env.QA_ADMIN_SESSION_TOKEN,
    {
      correlationId,
      weekStart,
      weekEnd,
      superMasterId: superMaster.id,
      organizationId: organization.id,
    }
  );

  assertQa(reconciliation.run.totalChecks > 0, "Reconciliation produced no checks.", {
    reconciliationRunId: reconciliation.run.id,
  });

  log("Credit launch E2E QA harness passed.", {
    runId,
    correlationId,
    ids: {
      superMasterId: superMaster.id,
      masterId: master.id,
      agentId: agent.id,
      playerId: player.id,
      externalPlayerId: externalPlayer.id,
      gameId,
      drawingId: drawing.id,
      ticketId,
      reservationId,
      settlementApplicationId: settlement.applicationId,
      commissionRunId,
      reconciliationRunId: reconciliation.run.id,
    },
    assertions: [
      "hierarchy created",
      "credit wallet and limit ready",
      "credit-backed ticket placed",
      "reservation persisted and linked",
      "pending exposure increased",
      "settlement application persisted",
      "exposure released",
      "balance updated",
      "available credit formula verified",
      "weekly accounting snapshot generated",
      "commission run detail generated",
      "reconciliation completed",
    ],
  });
}

main().catch((error) => {
  const failure =
    error instanceof QaFailure
      ? {
          message: error.message,
          metadata: error.metadata,
        }
      : {
          message: error instanceof Error ? error.message : "Unknown QA failure.",
          metadata: {},
        };

  console.error(
    JSON.stringify({
      level: "error",
      message: "Credit launch E2E QA harness failed.",
      failure,
    })
  );
  process.exit(1);
});
