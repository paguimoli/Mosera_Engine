"use client";

import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { supabase } from "@/app/lib/supabaseClient";
import {
  ADMIN_PERMISSION_GROUPS,
  type AdminPermission,
  type AdminRole,
  type AdminUser,
} from "@/src/domains/admin-access/admin-access.types";
import {
  addDefaultRolesController,
  deleteAdminRoleController,
  deleteAdminUserController,
  saveAdminRoleController,
  saveAdminUserController,
} from "@/src/domains/admin-access/admin-access.controller";
import {
  getAccountTypeLabel,
} from "@/src/domains/accounts/account.helpers";
import type {
  AccountStatus,
  AccountType,
  PlayerAccount,
} from "@/src/domains/accounts/account.types";
import {
  getChildAccounts as getChildAccountsFromAccounts,
  getDescendantAccountIds as getDescendantAccountIdsFromAccounts,
  wouldCreateHierarchyCycle as wouldCreateHierarchyCycleForAccounts,
} from "@/src/domains/accounts/account.service";
import {
  deleteAccountController,
  saveAccountController,
} from "@/src/domains/accounts/account.controller";
import type {
  AccountFinancialSummary,
  LedgerCategory,
  LedgerTransaction,
  TransactionType,
} from "@/src/domains/ledger/ledger.types";
import {
  buildAccountFinancialSummary,
  calculateAccountingBalance as calculateAccountingBalanceFromTransactions,
  calculateFreeplayBalance as calculateFreeplayBalanceFromTransactions,
  calculatePendingExposure as calculatePendingExposureFromAccount,
  calculateWeeklyFigure as calculateWeeklyFigureFromTransactions,
} from "@/src/domains/ledger/ledger.service";
import {
  createLedgerTransactionController,
  reverseLedgerTransactionController,
} from "@/src/domains/ledger/ledger.controller";
import {
  getGameLocalId,
} from "@/src/domains/games/game.service";
import {
  createGameController,
  updateGameController,
} from "@/src/domains/games/game.controller";
import type { Market } from "@/src/domains/markets/market.types";
import {
  addDefaultMarketsController,
  deleteMarketController,
  saveMarketController,
} from "@/src/domains/markets/market.controller";
import type {
  SettlementRecord,
  SettlementRun,
  SettlementRunStatus,
} from "@/src/domains/settlement/settlement.types";
import {
  calculateSettlementRunTotals as calculateSettlementRunTotalsFromRecords,
  getSettlementRecordsForRun as getSettlementRecordsForRunFromRecords,
  getSettlementRecordsForTicket as getSettlementRecordsForTicketFromRecords,
  getSettlementRunsForDrawing as getSettlementRunsForDrawingFromRuns,
  hasExistingCompletedSettlementForDrawing as hasCompletedSettlementRunForDrawing,
} from "@/src/domains/settlement/settlement.service";
import {
  createSettlementRunController,
  generatePlaceholderSettlementRecordsController,
  updateSettlementRunStatusController,
} from "@/src/domains/settlement/settlement.controller";
import {
  isOpenTicketStatus,
} from "@/src/domains/tickets/ticket.helpers";
import type {
  Ticket,
  TicketFundingType,
  TicketLine,
  TicketStatus,
} from "@/src/domains/tickets/ticket.types";
import {
  calculateTicketPotentialPayout as calculateTicketPotentialPayoutFromLines,
  calculateTicketTotalStake as calculateTicketTotalStakeFromLines,
  type DraftTicketLine,
} from "@/src/domains/tickets/ticket.service";
import {
  addTicketLineController,
  createTicketController,
  updateTicketStatusController,
} from "@/src/domains/tickets/ticket.controller";
import {
  COMPARISON_OPERATORS,
  KENO_METRIC_KEYS,
  type KenoDrawMetrics,
  type PayTable,
  type PayTableRow,
  type WagerOption,
  type WagerType,
} from "@/src/domains/wagers/wager.types";
import {
  methodNeedsMetricKey,
  methodNeedsOperator,
  methodNeedsThreshold,
  methodUsesPayTable,
} from "@/src/domains/wagers/wager.service";
import {
  addDefaultKenoWagersController,
  deleteWagerOptionController,
  deleteWagerTypeController,
  saveWagerOptionController,
  saveWagerTypeController,
} from "@/src/domains/wagers/wager.controller";
import { formatMoney } from "@/src/lib/money/format-money";

const states = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "IL", name: "Illinois" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "MA", name: "Massachusetts" },
  { code: "MD", name: "Maryland" },
  { code: "MI", name: "Michigan" },
  { code: "NJ", name: "New Jersey" },
  { code: "NY", name: "New York" },
  { code: "OH", name: "Ohio" },
  { code: "PA", name: "Pennsylvania" },
  { code: "TX", name: "Texas" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
];
function getExposureByNumbers(drawing: any) {
  const exposure: Record<string, number> = {};

  (drawing.bets || []).forEach((bet: any) => {
    const combo = bet.numbers.trim();

    if (!exposure[combo]) {
      exposure[combo] = 0;
    }

    exposure[combo] += Number(bet.potentialPayout || 0);
  });

  return Object.entries(exposure)
    .map(([numbers, payout]) => ({ numbers, payout }))
    .sort((a, b) => b.payout - a.payout);
}
const DEFAULT_TIME_ZONE = "America/New_York";
const MAX_VISIBLE_BETS = 25;


export default function Home() {
  const [games, setGames] = useState<any[]>([]);
  const [drawings, setDrawings] = useState<any[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [expandedGameIds, setExpandedGameIds] = useState<number[]>([]);
  const [expandedDrawingIds, setExpandedDrawingIds] = useState<string[]>([]);
  const [expandedBetIds, setExpandedBetIds] = useState<string[]>([]);
  const [expandedBetLists, setExpandedBetLists] = useState<string[]>([]);
  const [betSearchTerms, setBetSearchTerms] = useState<Record<string, string>>({});
  const [betStatusFilters, setBetStatusFilters] = useState<Record<string, string>>({});
  const [betTypeFilters, setBetTypeFilters] = useState<Record<string, string>>({});
  const [ticketLookupDrawingId, setTicketLookupDrawingId] = useState("");
  const [ticketLookupTicketId, setTicketLookupTicketId] = useState("");
  const [ticketLookupNumbers, setTicketLookupNumbers] = useState("");
  const [ticketLookupBetType, setTicketLookupBetType] = useState("all");
  const [ticketLookupStatus, setTicketLookupStatus] = useState("all");
  const [showAllTicketLookupResults, setShowAllTicketLookupResults] = useState(false);
  const [editingGameIndex, setEditingGameIndex] = useState<number | null>(null);
  const [editingDrawingIndex, setEditingDrawingIndex] = useState<number | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [showCreateGame, setShowCreateGame] = useState(true);
  const [showCreateDrawing, setShowCreateDrawing] = useState(true);
  const [showPrintableReport, setShowPrintableReport] = useState(false);
  const [showInactiveGames, setShowInactiveGames] = useState(true);
  const [showInactiveDrawings, setShowInactiveDrawings] = useState(true);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [hotspotProfiles, setHotspotProfiles] = useState<any[]>([]);
  const [hotspotTiers, setHotspotTiers] = useState<any[]>([]);
  const [editingHotspotTierId, setEditingHotspotTierId] = useState<string | null>(null);
  const [selectedKenoGameId, setSelectedKenoGameId] = useState("");
  const [lastGeneratedKenoDraw, setLastGeneratedKenoDraw] = useState<any | null>(null);
  const [kenoDrawMetrics, setKenoDrawMetrics] = useState<KenoDrawMetrics[]>([]);
  const [wagerTypes, setWagerTypes] = useState<WagerType[]>([]);
  const [editingWagerTypeId, setEditingWagerTypeId] = useState<string | null>(null);
  const [wagerTypeForm, setWagerTypeForm] = useState({
    gameId: "",
    name: "",
    code: "",
    settlementMethod: "hit_count",
    metricKey: "",
    comparisonOperator: "",
    thresholdValue: "",
    payTableId: "",
    active: true,
  });
  const [payTables, setPayTables] = useState<PayTable[]>([]);
  const [wagerOptions, setWagerOptions] = useState<WagerOption[]>([]);
  const [editingWagerOptionId, setEditingWagerOptionId] = useState<string | null>(null);
  const [wagerOptionForm, setWagerOptionForm] = useState({
    wagerTypeId: "",
    name: "",
    code: "",
    active: true,
  });
  const [adminRoles, setAdminRoles] = useState<AdminRole[]>([]);
  const [editingAdminRoleId, setEditingAdminRoleId] = useState<string | null>(null);
  const [adminRoleForm, setAdminRoleForm] = useState<{
    name: string;
    description: string;
    permissions: AdminPermission[];
    active: boolean;
  }>({
    name: "",
    description: "",
    permissions: [],
    active: true,
  });
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [editingAdminUserId, setEditingAdminUserId] = useState<string | null>(null);
  const [adminUserForm, setAdminUserForm] = useState<{
    name: string;
    email: string;
    roleIds: string[];
    status: AdminUser["status"];
  }>({
    name: "",
    email: "",
    roleIds: [],
    status: "active",
  });
  const [markets, setMarkets] = useState<Market[]>([]);
  const [editingMarketId, setEditingMarketId] = useState<string | null>(null);
  const [marketForm, setMarketForm] = useState({
    name: "",
    code: "",
    language: "",
    currency: "",
    timeZone: "",
    dateFormat: "",
    numberFormat: "",
    defaultBrand: "Default",
    active: true,
  });
  const [playerAccounts, setPlayerAccounts] = useState<PlayerAccount[]>([]);
  const [editingPlayerAccountId, setEditingPlayerAccountId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [expandedNetworkAccountIds, setExpandedNetworkAccountIds] = useState<string[]>([]);
  const [accountSearchTerm, setAccountSearchTerm] = useState("");
  const [accountTreeFilter, setAccountTreeFilter] = useState("all");
  const [accountPanelMode, setAccountPanelMode] = useState<
    "create" | "edit" | "move" | null
  >(null);
  const [playerAccountForm, setPlayerAccountForm] = useState<{
    accountType: AccountType;
    parentId: string;
    username: string;
    displayName: string;
    email: string;
    phone: string;
    marketId: string;
    language: string;
    currency: string;
    status: AccountStatus;
    cashBalance: string;
    creditLimit: string;
    currentExposure: string;
    maxBet: string;
    maxPayout: string;
    notes: string;
  }>({
    accountType: "super_master",
    parentId: "",
    username: "",
    displayName: "",
    email: "",
    phone: "",
    marketId: "",
    language: "",
    currency: "USD",
    status: "active",
    cashBalance: "0",
    creditLimit: "0",
    currentExposure: "0",
    maxBet: "",
    maxPayout: "",
    notes: "",
  });
  const [ledgerTransactions, setLedgerTransactions] = useState<LedgerTransaction[]>([]);
  const [ledgerForm, setLedgerForm] = useState<{
    accountId: string;
    category: LedgerCategory;
    transactionType: TransactionType;
    amount: string;
    description: string;
    referenceId: string;
    createdBy: string;
  }>({
    accountId: "",
    category: "accounting",
    transactionType: "deposit",
    amount: "",
    description: "",
    referenceId: "",
    createdBy: "",
  });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketLines, setTicketLines] = useState<TicketLine[]>([]);
  const [expandedTicketIds, setExpandedTicketIds] = useState<string[]>([]);
  const [ticketForm, setTicketForm] = useState<{
    accountId: string;
    marketId: string;
    gameId: string;
    drawingId: string;
    fundingType: TicketFundingType;
    notes: string;
  }>({
    accountId: "",
    marketId: "",
    gameId: "",
    drawingId: "",
    fundingType: "cash",
    notes: "",
  });
  const [ticketLineForm, setTicketLineForm] = useState({
    wagerTypeId: "",
    wagerOptionId: "",
    selectedNumbers: "",
    stake: "",
    potentialPayout: "",
  });
  const [draftTicketLines, setDraftTicketLines] = useState<
    DraftTicketLine[]
  >([]);
  const [settlementRuns, setSettlementRuns] = useState<SettlementRun[]>([]);
  const [settlementRecords, setSettlementRecords] = useState<SettlementRecord[]>([]);
  const [expandedSettlementRunIds, setExpandedSettlementRunIds] = useState<string[]>([]);
  const [settlementForm, setSettlementForm] = useState({
    drawingId: "",
    notes: "",
  });
  const [payTableForm, setPayTableForm] = useState({
    gameId: "",
    name: "",
    effectiveDate: "",
  });
  const [payTableRows, setPayTableRows] = useState<PayTableRow[]>([
    {
      id: "row-1",
      spotCount: 1,
      hitCount: 1,
      bullseyeRequired: false,
      payout: 0,
    },
  ]);
  const [hotspotTierForm, setHotspotTierForm] = useState({
    profileId: "",
    spotCount: "",
    matchCount: "",
    bullseyeRequired: false,
    payoutType: "fixed",
    fixedPayout: "",
    maximumPayout: "",
    status: "active",
  });
  const [gamesLoadedFromSupabase, setGamesLoadedFromSupabase] = useState(false);
  const [drawingsLoadedFromSupabase, setDrawingsLoadedFromSupabase] = useState(false);
  const lastSavedGamesJson = useRef("");
  const lastNormalizedGamesJson = useRef("");
  const lastSavedDrawingsJson = useRef("");
  const lastNormalizedDrawingsJson = useRef("");
  const lastNormalizedBetsJson = useRef("");
  const [reportFilters, setReportFilters] = useState({
  fromDate: "",
  toDate: "",
  state: "",
  game: "",
  status: "",
});

  function alertControllerErrors(result: { errors?: string[] }) {
    alert((result.errors && result.errors.length > 0
      ? result.errors
      : ["Something went wrong."]).join("\n"));
  }
	  const [mockBetForm, setMockBetForm] = useState({
	  drawingId: "",
	  playerId: "",
	  playerName: "",
	  agentId: "",
	  numbers: "",
	  amount: "",
	  betType: "straight",
  boxStakeMode: "total",
});

  const [form, setForm] = useState({
  state: "",
  name: "",
  status: "Active",
  gameType: "pick_n",
  gameFamily: "lottery",
  requiresPaytable: false,
  activePaytableId: null as string | null,
  mainNumbersCount: "",
  mainNumbersMin: "",
  mainNumbersMax: "",
  bonusNumbersCount: "",
  bonusNumbersMin: "",
  bonusNumbersMax: "",
  numberRangeMin: "1",
  numberRangeMax: "80",
  numbersDrawn: "20",
  availableSpots: "1,2,3,4,5,6,7,8,9,10",
  bullseyeEnabled: false,
  drawFrequencyType: "manual",
  drawIntervalSeconds: "",
  drawIdPrefix: "",
  autoGenerateDraws: false,
  ticketPrice: "",
  scheduleType: "one_time",
  recurringFrequency: "daily",
  defaultDrawTime: "",
  defaultCutoffTime: "",
  defaultTimeZone: "America/New_York",
  payoutMultiplier: "",
  maxPayout: "",
  defaultMaxBet: "",
  defaultMaxTotalHandle: "",
  defaultMaxTotalLiability: "",

});
const [selectedGameIndex, setSelectedGameIndex] = useState("");

  const [drawingForm, setDrawingForm] = useState({
    gameIndex: "",
    drawDate: "",
    drawTime: "",
    cutoffTime: "",
    timeZone: "America/New_York",
    status: "scheduled",
    maxBet: "",
    maxTotalHandle: "",
    maxTotalLiability: "",
  });

  useEffect(() => {
    async function loadGamesFromSupabase() {
      const { data, error } = await supabase
        .from("games")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Supabase games load failed:", error);
        setGamesLoadedFromSupabase(true);
        return;
      }

      setGames((data || []).map((row: any) => row.data));
      setGamesLoadedFromSupabase(true);
    }

    loadGamesFromSupabase();
  }, []);

	  useEffect(() => {
	    if (!gamesLoadedFromSupabase) return;

	    async function saveGamesToSupabase() {
	      const gamesJson = JSON.stringify(games);

	      if (lastSavedGamesJson.current === gamesJson) {
	        return;
	      }

	      lastSavedGamesJson.current = gamesJson;

	      const { error: deleteError } = await supabase
	        .from("games")
	        .delete()
        .not("created_at", "is", null);

      if (deleteError) {
        console.error("Supabase games clear failed:", deleteError);
        return;
      }

      if (games.length === 0) {
        return;
      }

      const { error: insertError } = await supabase
        .from("games")
        .insert(games.map((game: any) => ({ data: game })));

      if (insertError) {
        console.error("Supabase games save failed:", insertError);
      }
    }

    saveGamesToSupabase();
  }, [games, gamesLoadedFromSupabase]);

	  useEffect(() => {
	    if (!gamesLoadedFromSupabase) return;

		    async function syncNormalizedGamesToSupabase() {
	      if (games.length === 0) {
	        return;
	      }

	      function normalizeSpotCounts(value: any) {
	        const rawValues = Array.isArray(value)
	          ? value
	          : typeof value === "string"
	            ? value.split(",")
	            : [];

	        const normalizedValues = rawValues
	          .map((spot: any) => Number(String(spot).trim()))
	          .filter((spot: number) => Number.isInteger(spot) && spot > 0);

	        return normalizedValues.length > 0
	          ? normalizedValues
	          : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	      }

	      const normalizedGames = games.map((game: any) => ({
	        external_id:
	          game.externalId ||
	          `${game.state || ""}-${game.name || ""}`
	            .toUpperCase()
	            .replace(/[^A-Z0-9]+/g, "-")
	            .replace(/^-|-$/g, ""),
	        state: game.state,
	        name: game.name,
	        status: game.status || "active",
        game_type: game.gameType,
        game_family:
          game.gameFamily === "keno"
            ? "keno_style"
            : game.gameFamily === "lottery"
              ? "numbers_lottery"
              : game.gameFamily ||
          (game.gameType === "hotspot_style" || game.gameType === "keno_style"
            ? "keno_style"
            : "numbers_lottery"),
        main_numbers_count: Number(game.mainNumbersCount || 0),
        main_numbers_min: Number(game.mainNumbersMin || 0),
        main_numbers_max: Number(game.mainNumbersMax || 0),
        bonus_numbers_count: Number(game.bonusNumbersCount || 0),
        bonus_numbers_min: Number(game.bonusNumbersMin || 0),
        bonus_numbers_max: Number(game.bonusNumbersMax || 0),
        number_pool_min: Number(
          game.numberRangeMin || game.numberPoolMin || game.mainNumbersMin || 1
        ),
        number_pool_max: Number(
          game.numberRangeMax || game.numberPoolMax || game.mainNumbersMax || 80
        ),
        draw_count: Number(game.numbersDrawn || game.drawCount || 20),
        allowed_spot_counts: normalizeSpotCounts(
          game.availableSpots || game.allowedSpotCounts
        ),
        bullseye_enabled: Boolean(game.bullseyeEnabled || false),
        ticket_price: Number(game.ticketPrice || 0),
        payout_multiplier: Number(game.payoutMultiplier || 0),
        max_payout: Number(game.maxPayout || 0),
        default_max_bet: Number(game.defaultMaxBet || 0),
        default_max_total_handle: Number(game.defaultMaxTotalHandle || 0),
        default_max_total_liability: Number(game.defaultMaxTotalLiability || 0),
        schedule_type: game.scheduleType,
        recurring_frequency: game.recurringFrequency,
        default_draw_time: game.defaultDrawTime,
        default_cutoff_time: game.defaultCutoffTime,
	        default_time_zone: game.defaultTimeZone,
	      }));

	      const normalizedGamesJson = JSON.stringify(normalizedGames);

	      if (lastNormalizedGamesJson.current === normalizedGamesJson) {
	        return;
	      }

	      lastNormalizedGamesJson.current = normalizedGamesJson;

		      const { error: insertError } = await supabase
	        .from("normalized_games")
	        .upsert(normalizedGames, {
	          onConflict: "external_id",
	        });

      if (insertError) {
        console.error(
          "Supabase normalized_games save failed:",
          JSON.stringify(
            {
              message: insertError?.message,
              details: insertError?.details,
              hint: insertError?.hint,
              code: insertError?.code,
              rawError: insertError,
              payload: normalizedGames,
            },
            null,
            2
          )
        );
      }
    }

    syncNormalizedGamesToSupabase();
  }, [games, gamesLoadedFromSupabase]);

  useEffect(() => {
    async function loadDrawingsFromSupabase() {
      const { data, error } = await supabase
        .from("drawings")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Supabase drawings load failed:", error);
        setDrawingsLoadedFromSupabase(true);
        return;
      }

      const loadedDrawings = (data || [])
        .map((row: any) => row.data)
        .filter((drawing: any) => drawing?.id);
      const drawingsById = new Map();

      loadedDrawings.forEach((drawing: any) => {
        drawingsById.set(drawing.id, drawing);
      });

      if (drawingsById.size !== loadedDrawings.length) {
        console.warn(
          "Duplicate drawing IDs detected during Supabase load"
        );
      }

      const uniqueDrawings = Array.from(drawingsById.values());

      setDrawings(uniqueDrawings);
      setDrawingsLoadedFromSupabase(true);
    }

    loadDrawingsFromSupabase();
  }, []);

	  useEffect(() => {
	    if (!drawingsLoadedFromSupabase) return;

	    async function saveDrawingsToSupabase() {
	      const drawingsJson = JSON.stringify(drawings);

	      if (lastSavedDrawingsJson.current === drawingsJson) {
	        return;
	      }

	      lastSavedDrawingsJson.current = drawingsJson;

	      const { error: deleteError } = await supabase
	        .from("drawings")
	        .delete()
        .not("created_at", "is", null);

      if (deleteError) {
        console.error("Supabase drawings clear failed:", deleteError);
        return;
      }

      if (drawings.length === 0) {
        return;
      }

      const { error: insertError } = await supabase
        .from("drawings")
        .insert(drawings.map((drawing: any) => ({ data: drawing })));

      if (insertError) {
        console.error("Supabase drawings save failed:", insertError);
      }
    }

    saveDrawingsToSupabase();
	  }, [drawings, drawingsLoadedFromSupabase]);

  useEffect(() => {
    if (activeTab !== "hotspotAdmin") return;

    loadHotspotAdminData();
  }, [activeTab]);

	  useEffect(() => {
	    if (!drawingsLoadedFromSupabase || !gamesLoadedFromSupabase) return;

	    async function syncNormalizedDrawingsToSupabase() {
	      function isValidDateString(value: any) {
	        return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
	      }

		      if (drawings.length === 0) {
		        return;
		      }

	      const { data: normalizedGames, error: gamesLookupError } = await supabase
	        .from("normalized_games")
	        .select("id,state,name");

	      if (gamesLookupError) {
	        console.error(
	          "Supabase normalized_games lookup for drawings failed:",
	          gamesLookupError
	        );
	      }

	      const normalizedGameIdByStateName = new Map();

	      (normalizedGames || []).forEach((game: any) => {
	        normalizedGameIdByStateName.set(
	          `${game.state || ""}::${game.name || ""}`,
	          game.id
	        );
	      });

	      const normalizedDrawings = drawings.map((drawing: any) => {
	        const state = drawing.game?.state || "";
	        const gameName = drawing.game?.name || "";

	        return {
		          external_id: String(drawing.id || "").trim(),
	          game_id:
	            normalizedGameIdByStateName.get(`${state}::${gameName}`) || null,
	          state,
	          game_name: gameName,
	          draw_date: isValidDateString(drawing.drawDate) ? drawing.drawDate : null,
	          draw_time: drawing.drawTime || "",
	          cutoff_time: drawing.cutoffTime || "",
	          time_zone: drawing.timeZone || "",
	          status: drawing.status || "scheduled",
	          max_bet: Number(drawing.maxBet || 0),
	          max_total_handle: Number(drawing.maxTotalHandle || 0),
	          max_total_liability: Number(drawing.maxTotalLiability || 0),
	          total_handle: Number(drawing.totalHandle || 0),
	          total_potential_payout: Number(drawing.totalPotentialPayout || 0),
	          worst_case_liability: Number(drawing.worstCaseLiability || 0),
	          house_position: Number(drawing.housePosition || 0),
	          winning_numbers: drawing.winningNumbers || "",
	          winning_bonus: drawing.winningBonus || "",
	          result_source: drawing.resultSource || "",
	          actual_payout: Number(drawing.actualPayout || 0),
	          override_reason: drawing.overrideReason || "",
	          settled_at: drawing.settledAt || null,
	          reopened_at: drawing.reopenedAt || null,
	        };
		      }).filter((drawing: any) => drawing.external_id !== "");

      const drawingRowsByExternalId = new Map();

      normalizedDrawings.forEach((drawing: any) => {
        drawingRowsByExternalId.set(drawing.external_id, drawing);
      });

	      const uniqueDrawingRows = Array.from(drawingRowsByExternalId.values()).filter(
	        (drawing: any) => drawing.external_id !== ""
	      );

	      if (uniqueDrawingRows.length === 0) {
	        return;
	      }

	      const normalizedDrawingsJson = JSON.stringify(uniqueDrawingRows);

	      if (lastNormalizedDrawingsJson.current === normalizedDrawingsJson) {
	        return;
	      }

			      lastNormalizedDrawingsJson.current = normalizedDrawingsJson;

			      const { error: insertError } = await supabase
			        .from("normalized_drawings")
	        .upsert(uniqueDrawingRows, {
	          onConflict: "external_id",
	        });

      if (insertError) {
        console.error(
          "Supabase normalized_drawings save failed:",
          JSON.stringify(insertError, null, 2),
          uniqueDrawingRows
        );
      }
    }

    syncNormalizedDrawingsToSupabase();
	  }, [drawings, drawingsLoadedFromSupabase, gamesLoadedFromSupabase]);

	  useEffect(() => {
	    if (!drawingsLoadedFromSupabase) return;

	    async function syncNormalizedBetsToSupabase() {
	      function isValidIsoDate(value: any) {
	        return typeof value === "string" && !Number.isNaN(Date.parse(value));
	      }

	      const normalizedRows = drawings.flatMap((drawing: any) =>
	        (drawing.bets || []).map((bet: any) => ({
          external_id: String(bet.id || "").trim(),
          drawing_external_id: String(drawing.id || ""),
          state: String(drawing.game?.state || ""),
          game_name: String(drawing.game?.name || ""),
          numbers: String(bet.numbers || ""),
          bet_type: String(bet.betType || ""),
          amount: Number(bet.amount || 0),
          potential_payout: Number(bet.potentialPayout || 0),
          status: String(bet.status || "accepted"),
          placed_at: isValidIsoDate(bet.placedAt) ? bet.placedAt : null,
          settled_at: isValidIsoDate(bet.settledAt) ? bet.settledAt : null,
        }))
      );

      const uniqueMap = new Map();

      normalizedRows.forEach((row: any) => {
        if (!row.external_id) return;
        uniqueMap.set(row.external_id, row);
      });

	      const uniqueBetRows = Array.from(uniqueMap.values());

	      console.log(
	        "Normalized bet sync count:",
        normalizedRows.length,
        "Unique:",
        uniqueBetRows.length
      );

		      const normalizedBetsJson = JSON.stringify(uniqueBetRows);

		      if (lastNormalizedBetsJson.current === normalizedBetsJson) {
	        return;
	      }

		      lastNormalizedBetsJson.current = normalizedBetsJson;

		      const { error: deleteError } = await supabase
		        .from("normalized_bets")
		        .delete()
		        .not("created_at", "is", null);

		      if (deleteError) {
		        console.error("Supabase normalized_bets clear failed:", deleteError);
		        return;
		      }

	      if (uniqueBetRows.length === 0) {
	        return;
	      }

		      const { error: insertError } = await supabase
        .from("normalized_bets")
        .upsert(uniqueBetRows, {
          onConflict: "external_id",
        });

      if (insertError) {
        console.error(
          "Supabase normalized_bets save failed:",
          JSON.stringify(insertError, null, 2),
          uniqueBetRows.map((row: any) => row.external_id)
        );
      }
    }

	    syncNormalizedBetsToSupabase();
	  }, [drawings, drawingsLoadedFromSupabase]);

  async function loadHotspotAdminData() {
    const { data: profiles, error: profilesError } = await supabase
      .from("hotspot_prize_profiles")
      .select("*")
      .order("profile_code", { ascending: true });

    if (profilesError) {
      console.error("Hot Spot profiles load failed:", profilesError);
    } else {
      setHotspotProfiles(profiles || []);
    }

    const { data: tiers, error: tiersError } = await supabase
      .from("hotspot_prize_tiers")
      .select("*, hotspot_prize_profiles(profile_code)")
      .order("spot_count", { ascending: true })
      .order("match_count", { ascending: false });

    if (tiersError) {
      console.error("Hot Spot prize tiers load failed:", tiersError);
    } else {
      setHotspotTiers(tiers || []);
    }
  }

  function resetHotspotTierForm() {
    setEditingHotspotTierId(null);
    setHotspotTierForm({
      profileId: "",
      spotCount: "",
      matchCount: "",
      bullseyeRequired: false,
      payoutType: "fixed",
      fixedPayout: "",
      maximumPayout: "",
      status: "active",
    });
  }

  function editHotspotTier(tier: any) {
    setEditingHotspotTierId(tier.id);
    setHotspotTierForm({
      profileId: tier.profile_id || "",
      spotCount: String(tier.spot_count || ""),
      matchCount: String(tier.match_count || ""),
      bullseyeRequired: Boolean(tier.bullseye_required),
      payoutType: tier.payout_type || "fixed",
      fixedPayout: tier.fixed_payout === null ? "" : String(tier.fixed_payout || ""),
      maximumPayout:
        tier.maximum_payout === null ? "" : String(tier.maximum_payout || ""),
      status: tier.status || "active",
    });
  }

  async function saveHotspotTier(event: React.FormEvent) {
    event.preventDefault();

    const payload = {
      profile_id: hotspotTierForm.profileId,
      spot_count: Number(hotspotTierForm.spotCount || 0),
      match_count: Number(hotspotTierForm.matchCount || 0),
      bullseye_required: hotspotTierForm.bullseyeRequired,
      payout_type: hotspotTierForm.payoutType,
      fixed_payout:
        hotspotTierForm.fixedPayout === ""
          ? null
          : Number(hotspotTierForm.fixedPayout || 0),
      maximum_payout:
        hotspotTierForm.maximumPayout === ""
          ? null
          : Number(hotspotTierForm.maximumPayout || 0),
      status: hotspotTierForm.status,
    };

    const { error } = editingHotspotTierId
      ? await supabase
          .from("hotspot_prize_tiers")
          .update(payload)
          .eq("id", editingHotspotTierId)
      : await supabase.from("hotspot_prize_tiers").insert(payload);

    if (error) {
      console.error("Hot Spot prize tier save failed:", error);
      alert("Hot Spot prize tier save failed.");
      return;
    }

    resetHotspotTierForm();
    loadHotspotAdminData();
  }

  async function toggleHotspotTierStatus(tier: any) {
    const nextStatus = tier.status === "active" ? "inactive" : "active";
    const { error } = await supabase
      .from("hotspot_prize_tiers")
      .update({ status: nextStatus })
      .eq("id", tier.id);

    if (error) {
      console.error("Hot Spot prize tier status update failed:", error);
      alert("Hot Spot prize tier status update failed.");
      return;
    }

    loadHotspotAdminData();
  }

		  function handleChange(
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    const { name, value } = event.target;
    const checked =
      event.target instanceof HTMLInputElement ? event.target.checked : false;

    if (name === "gameType") {
      setForm({
        ...form,
        gameType: value,
        drawFrequencyType: value === "keno_style" ? "recurring" : "manual",
        drawIntervalSeconds:
          value === "keno_style" ? form.drawIntervalSeconds || "240" : "",
        drawIdPrefix: value === "keno_style" ? form.drawIdPrefix || "HS" : "",
        autoGenerateDraws: value === "keno_style",
      });
      return;
    }

    setForm({
      ...form,
      [name]: event.target.type === "checkbox" ? checked : value,
    });
  }

  function getActivePayTableForGame(game: any, index: number) {
    const gameId = getGameLocalId(game, index);

    return payTables.find(
      (payTable) =>
        payTable.gameId === gameId &&
        payTable.active &&
        payTable.id === game.activePaytableId
    );
  }

  function resetPayTableForm() {
    setPayTableForm({
      gameId: "",
      name: "",
      effectiveDate: "",
    });
    setPayTableRows([
      {
        id: `row-${Date.now()}`,
        spotCount: 1,
        hitCount: 1,
        bullseyeRequired: false,
        payout: 0,
      },
    ]);
  }

  function addPayTableRow() {
    setPayTableRows([
      ...payTableRows,
      {
        id: `row-${Date.now()}`,
        spotCount: 1,
        hitCount: 1,
        bullseyeRequired: false,
        payout: 0,
      },
    ]);
  }

  function updatePayTableRow(
    rowId: string,
    field: "spotCount" | "hitCount" | "bullseyeRequired" | "payout",
    value: string | boolean
  ) {
    setPayTableRows(
      payTableRows.map((row) =>
        row.id === rowId
          ? {
              ...row,
              [field]:
                field === "bullseyeRequired" ? value : Number(value || 0),
            }
          : row
      )
    );
  }

  function removePayTableRow(rowId: string) {
    if (payTableRows.length === 1) {
      return;
    }

    setPayTableRows(payTableRows.filter((row) => row.id !== rowId));
  }

  function savePayTable(event: React.FormEvent) {
    event.preventDefault();

    if (!payTableForm.gameId || !payTableForm.name || !payTableForm.effectiveDate) {
      alert("Please select a game, name the pay table, and enter an effective date.");
      return;
    }

    if (
      payTableRows.some(
        (row) =>
          row.spotCount <= 0 ||
          row.hitCount < 0 ||
          row.hitCount > row.spotCount ||
          row.payout < 0
      )
    ) {
      alert("Please enter valid pay table rows.");
      return;
    }

    const existingActivePayTable = payTables.find(
      (payTable) => payTable.gameId === payTableForm.gameId && payTable.active
    );
    const payTableId = `PAYTABLE-${Date.now()}`;
    const isActive = !existingActivePayTable;
    const newPayTable: PayTable = {
      id: payTableId,
      gameId: payTableForm.gameId,
      name: payTableForm.name,
      active: isActive,
      effectiveDate: payTableForm.effectiveDate,
      rows: payTableRows.map((row) => ({ ...row })),
    };

    setPayTables([...payTables, newPayTable]);

    if (isActive) {
      setGames(
        games.map((game: any, index: number) =>
          getGameLocalId(game, index) === payTableForm.gameId
            ? {
                ...game,
                activePaytableId: payTableId,
              }
            : game
        )
      );
    }

    resetPayTableForm();
  }

  function resetWagerTypeForm() {
    setEditingWagerTypeId(null);
    setWagerTypeForm({
      gameId: "",
      name: "",
      code: "",
      settlementMethod: "hit_count",
      metricKey: "",
      comparisonOperator: "",
      thresholdValue: "",
      payTableId: "",
      active: true,
    });
  }

  function resetWagerOptionForm() {
    setEditingWagerOptionId(null);
    setWagerOptionForm({
      wagerTypeId: "",
      name: "",
      code: "",
      active: true,
    });
  }

  function getPayTablesForGame(gameId: string) {
    return payTables.filter((payTable) => payTable.gameId === gameId);
  }

  function getOptionsForWagerType(wagerTypeId: string) {
    return wagerOptions.filter((option) => option.wagerTypeId === wagerTypeId);
  }

  function editWagerType(wagerType: WagerType) {
    setEditingWagerTypeId(wagerType.id);
    setWagerTypeForm({
      gameId: wagerType.gameId,
      name: wagerType.name,
      code: wagerType.code,
      settlementMethod: wagerType.settlementMethod,
      metricKey: wagerType.metricKey || "",
      comparisonOperator: wagerType.comparisonOperator || "",
      thresholdValue:
        wagerType.thresholdValue === null || wagerType.thresholdValue === undefined
          ? ""
          : String(wagerType.thresholdValue),
      payTableId: wagerType.payTableId || "",
      active: wagerType.active,
    });
  }

  function saveWagerType(event: React.FormEvent) {
    event.preventDefault();
    const result = saveWagerTypeController({
      form: wagerTypeForm,
      wagerTypes,
      editingWagerTypeId,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setWagerTypes(result.data.wagerTypes);
    resetWagerTypeForm();
  }

  function deleteWagerType(wagerTypeId: string) {
    if (!window.confirm("Delete this wager type? This cannot be undone.")) {
      return;
    }

    const result = deleteWagerTypeController({
      wagerTypeId,
      wagerTypes,
      wagerOptions,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setWagerTypes(result.data.wagerTypes);
    setWagerOptions(result.data.wagerOptions);

    if (editingWagerTypeId === wagerTypeId) {
      resetWagerTypeForm();
    }

    if (wagerOptionForm.wagerTypeId === wagerTypeId) {
      resetWagerOptionForm();
    }
  }

  function editWagerOption(option: WagerOption) {
    setEditingWagerOptionId(option.id);
    setWagerOptionForm({
      wagerTypeId: option.wagerTypeId,
      name: option.name,
      code: option.code,
      active: option.active,
    });
  }

  function saveWagerOption(event: React.FormEvent) {
    event.preventDefault();
    const result = saveWagerOptionController({
      form: wagerOptionForm,
      wagerOptions,
      editingWagerOptionId,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setWagerOptions(result.data.wagerOptions);
    resetWagerOptionForm();
  }

  function deleteWagerOption(optionId: string) {
    if (!window.confirm("Delete this wager option? This cannot be undone.")) {
      return;
    }

    const result = deleteWagerOptionController({
      optionId,
      wagerOptions,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setWagerOptions(result.data.wagerOptions);

    if (editingWagerOptionId === optionId) {
      resetWagerOptionForm();
    }
  }

  function resetAdminRoleForm() {
    setEditingAdminRoleId(null);
    setAdminRoleForm({
      name: "",
      description: "",
      permissions: [],
      active: true,
    });
  }

  function resetAdminUserForm() {
    setEditingAdminUserId(null);
    setAdminUserForm({
      name: "",
      email: "",
      roleIds: [],
      status: "active",
    });
  }

  function toggleAdminRolePermission(permission: AdminPermission) {
    setAdminRoleForm((currentForm) => ({
      ...currentForm,
      permissions: currentForm.permissions.includes(permission)
        ? currentForm.permissions.filter(
            (currentPermission) => currentPermission !== permission
          )
        : [...currentForm.permissions, permission],
    }));
  }

  function editAdminRole(role: AdminRole) {
    setEditingAdminRoleId(role.id);
    setAdminRoleForm({
      name: role.name,
      description: role.description,
      permissions: [...role.permissions],
      active: role.active,
    });
  }

  function saveAdminRole(event: React.FormEvent) {
    event.preventDefault();
    const result = saveAdminRoleController({
      form: adminRoleForm,
      adminRoles,
      editingAdminRoleId,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setAdminRoles(result.data.adminRoles);
    resetAdminRoleForm();
  }

  function deleteAdminRole(roleId: string) {
    if (!window.confirm("Delete this admin role? This cannot be undone.")) {
      return;
    }

    const result = deleteAdminRoleController({
      roleId,
      adminRoles,
      adminUsers,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setAdminRoles(result.data.adminRoles);
    setAdminUsers(result.data.adminUsers);

    if (editingAdminRoleId === roleId) {
      resetAdminRoleForm();
    }

    if (adminUserForm.roleIds.includes(roleId)) {
      setAdminUserForm({
        ...adminUserForm,
        roleIds: adminUserForm.roleIds.filter(
          (userRoleId) => userRoleId !== roleId
        ),
      });
    }
  }

  function addDefaultAdminRoles() {
    const result = addDefaultRolesController(adminRoles);

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setAdminRoles(result.data.adminRoles);
  }

  function toggleAdminUserRole(roleId: string) {
    setAdminUserForm((currentForm) => ({
      ...currentForm,
      roleIds: currentForm.roleIds.includes(roleId)
        ? currentForm.roleIds.filter((currentRoleId) => currentRoleId !== roleId)
        : [...currentForm.roleIds, roleId],
    }));
  }

  function editAdminUser(user: AdminUser) {
    setEditingAdminUserId(user.id);
    setAdminUserForm({
      name: user.name,
      email: user.email,
      roleIds: [...user.roleIds],
      status: user.status,
    });
  }

  function saveAdminUser(event: React.FormEvent) {
    event.preventDefault();
    const result = saveAdminUserController({
      form: adminUserForm,
      adminUsers,
      editingAdminUserId,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setAdminUsers(result.data.adminUsers);
    resetAdminUserForm();
  }

  function deleteAdminUser(userId: string) {
    if (!window.confirm("Delete this admin user? This cannot be undone.")) {
      return;
    }

    const result = deleteAdminUserController({
      userId,
      adminUsers,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setAdminUsers(result.data.adminUsers);

    if (editingAdminUserId === userId) {
      resetAdminUserForm();
    }
  }

  function resetMarketForm() {
    setEditingMarketId(null);
    setMarketForm({
      name: "",
      code: "",
      language: "",
      currency: "",
      timeZone: "",
      dateFormat: "",
      numberFormat: "",
      defaultBrand: "Default",
      active: true,
    });
  }

  function editMarket(market: Market) {
    setEditingMarketId(market.id);
    setMarketForm({
      name: market.name,
      code: market.code,
      language: market.language,
      currency: market.currency,
      timeZone: market.timeZone,
      dateFormat: market.dateFormat,
      numberFormat: market.numberFormat,
      defaultBrand: market.defaultBrand,
      active: market.active,
    });
  }

  function saveMarket(event: React.FormEvent) {
    event.preventDefault();
    const result = saveMarketController({
      form: marketForm,
      markets,
      editingMarketId,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setMarkets(result.data.markets);
    resetMarketForm();
  }

  function deleteMarket(marketId: string) {
    if (!window.confirm("Delete this market? This cannot be undone.")) {
      return;
    }

    const result = deleteMarketController({ marketId, markets });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setMarkets(result.data.markets);

    if (editingMarketId === marketId) {
      resetMarketForm();
    }
  }

  function addDefaultMarkets() {
    const result = addDefaultMarketsController(markets);

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setMarkets(result.data.markets);
  }

  function resetPlayerAccountForm() {
    setEditingPlayerAccountId(null);
    setAccountPanelMode(null);
    setPlayerAccountForm({
      accountType: "super_master",
      parentId: "",
      username: "",
      displayName: "",
      email: "",
      phone: "",
      marketId: "",
      language: "",
      currency: "USD",
      status: "active",
      cashBalance: "0",
      creditLimit: "0",
      currentExposure: "0",
      maxBet: "",
      maxPayout: "",
      notes: "",
    });
  }

  function getParentOptionsForAccountType(accountType: AccountType) {
    if (accountType === "master_agent") {
      return playerAccounts.filter(
        (account) =>
          (account.accountType === "super_master" ||
            account.accountType === "master_agent") &&
          account.id !== editingPlayerAccountId &&
          !wouldCreateHierarchyCycle(editingPlayerAccountId || "", account.id)
      );
    }

    if (accountType === "agent") {
      return playerAccounts.filter(
        (account) =>
          account.accountType === "master_agent" &&
          account.id !== editingPlayerAccountId &&
          !wouldCreateHierarchyCycle(editingPlayerAccountId || "", account.id)
      );
    }

    if (accountType === "player") {
      return playerAccounts.filter(
        (account) =>
          account.accountType === "agent" && account.id !== editingPlayerAccountId
      );
    }

    return [];
  }

  function getChildAccounts(accountId: string) {
    return getChildAccountsFromAccounts(playerAccounts, accountId);
  }

  function getParentAccount(accountId: string) {
    const account = playerAccounts.find(
      (createdAccount) => createdAccount.id === accountId
    );

    if (!account?.parentId) {
      return null;
    }

    return (
      playerAccounts.find(
        (createdAccount) => createdAccount.id === account.parentId
      ) || null
    );
  }

  function getDescendantAccountIds(accountId: string) {
    return getDescendantAccountIdsFromAccounts(playerAccounts, accountId);
  }

  function wouldCreateHierarchyCycle(accountId: string, newParentId: string | null) {
    return wouldCreateHierarchyCycleForAccounts(
      playerAccounts,
      accountId,
      newParentId
    );
  }

  function getAccountDisplayName(accountId: string | null) {
    if (!accountId) {
      return "";
    }

    const account = playerAccounts.find(
      (createdAccount) => createdAccount.id === accountId
    );

    return account ? `${account.displayName} (${account.username})` : accountId;
  }

  function getSelectedAccount() {
    return (
      playerAccounts.find((account) => account.id === selectedAccountId) || null
    );
  }

  function getRootNetworkAccounts() {
    return playerAccounts.filter(
      (account) => account.accountType === "super_master" || !account.parentId
    );
  }

  function editPlayerAccount(account: PlayerAccount) {
    setEditingPlayerAccountId(account.id);
    setPlayerAccountForm({
      accountType: account.accountType,
      parentId: account.parentId || "",
      username: account.username,
      displayName: account.displayName,
      email: account.email || "",
      phone: account.phone || "",
      marketId: account.marketId || "",
      language: account.language || "",
      currency: account.currency || "USD",
      status: account.status,
      cashBalance: String(account.cashBalance),
      creditLimit: String(account.creditLimit),
      currentExposure: String(account.currentExposure),
      maxBet:
        account.maxBet === null || account.maxBet === undefined
          ? ""
          : String(account.maxBet),
      maxPayout:
        account.maxPayout === null || account.maxPayout === undefined
          ? ""
          : String(account.maxPayout),
      notes: account.notes || "",
    });
  }

  function savePlayerAccount(event: React.FormEvent) {
    event.preventDefault();
    const result = saveAccountController({
      form: playerAccountForm,
      accounts: playerAccounts,
      markets,
      editingAccountId: editingPlayerAccountId,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    // Production backend must write audit log for hierarchy moves including oldParentId, newParentId, changedBy, reason, and timestamp.
    // Future backend queries must filter by downline: super master sees all, master agent sees descendants, agent sees own players, player sees own account.
    const nextAccount = result.data.account;

    setPlayerAccounts(result.data.accounts);
    setSelectedAccountId(nextAccount.id);
    setExpandedNetworkAccountIds((currentIds) =>
      nextAccount.parentId && !currentIds.includes(nextAccount.parentId)
        ? [...currentIds, nextAccount.parentId]
        : currentIds
    );
    resetPlayerAccountForm();
  }

  function deletePlayerAccount(accountId: string) {
    const result = deleteAccountController({
      accountId,
      accounts: playerAccounts,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    if (!window.confirm("Delete this account? This cannot be undone.")) {
      return;
    }

    setPlayerAccounts(result.data.accounts);
    setSelectedAccountId((currentId) => (currentId === accountId ? null : currentId));

    if (editingPlayerAccountId === accountId) {
      resetPlayerAccountForm();
    }
  }

  function addSampleAgentHierarchy() {
    const existingUsernames = new Set(
      playerAccounts.map((account) => account.username.trim().toLowerCase())
    );
    const sampleUsernames = [
      "house",
      "master1",
      "master2",
      "master1a",
      "agent1",
      "agent2",
      "agent3",
      "player1",
      "player2",
      "player3",
      "player4",
    ];

    if (sampleUsernames.every((username) => existingUsernames.has(username))) {
      alert("Sample agent hierarchy already exists.");
      return;
    }

    const selectedMarket = markets[0];
    const createdAt = new Date().toISOString();
    const idSeed = Date.now();
    const houseId =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "house"
      )?.id || `ACCOUNT-${idSeed}-house`;
    const masterId =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "master1"
      )?.id || `ACCOUNT-${idSeed}-master1`;
    const master2Id =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "master2"
      )?.id || `ACCOUNT-${idSeed}-master2`;
    const master1aId =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "master1a"
      )?.id || `ACCOUNT-${idSeed}-master1a`;
    const agent1Id =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "agent1"
      )?.id || `ACCOUNT-${idSeed}-agent1`;
    const agent2Id =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "agent2"
      )?.id || `ACCOUNT-${idSeed}-agent2`;
    const agent3Id =
      playerAccounts.find(
        (account) => account.username.trim().toLowerCase() === "agent3"
      )?.id || `ACCOUNT-${idSeed}-agent3`;
    const sampleAccounts: PlayerAccount[] = [
      {
        id: houseId,
        accountType: "super_master",
        parentId: null,
        username: "house",
        displayName: "House / Super Master",
        email: "house@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 0,
        currentExposure: 0,
        availableCredit: 0,
        notes: "Sample house root account",
        createdAt,
      },
      {
        id: masterId,
        accountType: "master_agent",
        parentId: houseId,
        username: "master1",
        displayName: "Master Agent 1",
        email: "master1@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 0,
        currentExposure: 0,
        availableCredit: 0,
        notes: "Sample master agent",
        createdAt,
      },
      {
        id: master2Id,
        accountType: "master_agent",
        parentId: houseId,
        username: "master2",
        displayName: "Master Agent 2",
        email: "master2@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 0,
        currentExposure: 0,
        availableCredit: 0,
        notes: "Sample master agent under house",
        createdAt,
      },
      {
        id: master1aId,
        accountType: "master_agent",
        parentId: masterId,
        username: "master1a",
        displayName: "Master Agent 1A",
        email: "master1a@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 0,
        currentExposure: 0,
        availableCredit: 0,
        notes: "Sample nested master agent under master1",
        createdAt,
      },
      {
        id: agent1Id,
        accountType: "agent",
        parentId: masterId,
        username: "agent1",
        displayName: "Agent 1",
        email: "agent1@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 5000,
        currentExposure: 0,
        availableCredit: 5000,
        notes: "Sample agent under master1a",
        createdAt,
      },
      {
        id: agent2Id,
        accountType: "agent",
        parentId: master1aId,
        username: "agent2",
        displayName: "Agent 2",
        email: "agent2@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 5000,
        currentExposure: 0,
        availableCredit: 5000,
        notes: "Sample agent under master1",
        createdAt,
      },
      {
        id: agent3Id,
        accountType: "agent",
        parentId: master2Id,
        username: "agent3",
        displayName: "Agent 3",
        email: "agent3@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 0,
        creditLimit: 5000,
        currentExposure: 0,
        availableCredit: 5000,
        notes: "Sample agent under master2",
        createdAt,
      },
      {
        id: `ACCOUNT-${idSeed}-player1`,
        accountType: "player",
        parentId: agent1Id,
        username: "player1",
        displayName: "Player 1",
        email: "player1@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 100,
        creditLimit: 1000,
        currentExposure: 125,
        availableCredit: 875,
        maxBet: 50,
        maxPayout: 5000,
        notes: "Sample player under agent1",
        createdAt,
      },
      {
        id: `ACCOUNT-${idSeed}-player2`,
        accountType: "player",
        parentId: agent1Id,
        username: "player2",
        displayName: "Player 2",
        email: "player2@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 75,
        creditLimit: 1000,
        currentExposure: 0,
        availableCredit: 1000,
        maxBet: 50,
        maxPayout: 5000,
        notes: "Sample player under agent1",
        createdAt,
      },
      {
        id: `ACCOUNT-${idSeed}-player3`,
        accountType: "player",
        parentId: agent2Id,
        username: "player3",
        displayName: "Player 3",
        email: "player3@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 50,
        creditLimit: 750,
        currentExposure: 25,
        availableCredit: 725,
        maxBet: 25,
        maxPayout: 2500,
        notes: "Sample player under agent2",
        createdAt,
      },
      {
        id: `ACCOUNT-${idSeed}-player4`,
        accountType: "player",
        parentId: agent3Id,
        username: "player4",
        displayName: "Player 4",
        email: "player4@example.com",
        phone: "",
        marketId: selectedMarket?.id || null,
        language: selectedMarket?.language || "en",
        currency: selectedMarket?.currency || "USD",
        status: "active",
        cashBalance: 50,
        creditLimit: 750,
        currentExposure: 25,
        availableCredit: 725,
        maxBet: 25,
        maxPayout: 2500,
        notes: "Sample player under agent3",
        createdAt,
      },
    ];
    const newAccounts = sampleAccounts.filter(
      (account) => !existingUsernames.has(account.username.trim().toLowerCase())
    );

    if (newAccounts.length === 0) {
      alert("Sample agent hierarchy already exists.");
      return;
    }

    setPlayerAccounts([...playerAccounts, ...newAccounts]);
  }

  function getAllowedChildAccountTypes(accountType: AccountType): AccountType[] {
    if (accountType === "super_master") return ["master_agent"];
    if (accountType === "master_agent") return ["master_agent", "agent"];
    if (accountType === "agent") return ["player"];
    return [];
  }

  function toggleNetworkAccount(accountId: string) {
    setExpandedNetworkAccountIds((currentIds) =>
      currentIds.includes(accountId)
        ? currentIds.filter((currentId) => currentId !== accountId)
        : [...currentIds, accountId]
    );
  }

  function selectNetworkAccount(accountId: string) {
    setSelectedAccountId(accountId);
    setAccountPanelMode(null);
  }

  function startCreateChildAccount(parentAccount: PlayerAccount, accountType: AccountType) {
    setSelectedAccountId(parentAccount.id);
    setEditingPlayerAccountId(null);
    setAccountPanelMode("create");
    setExpandedNetworkAccountIds((currentIds) =>
      currentIds.includes(parentAccount.id)
        ? currentIds
        : [...currentIds, parentAccount.id]
    );
    setPlayerAccountForm({
      accountType,
      parentId: parentAccount.id,
      username: "",
      displayName: "",
      email: "",
      phone: "",
      marketId: parentAccount.marketId || "",
      language: parentAccount.language || "",
      currency: parentAccount.currency || "USD",
      status: "active",
      cashBalance: "0",
      creditLimit: "0",
      currentExposure: "0",
      maxBet: "",
      maxPayout: "",
      notes: "",
    });
  }

  function startCreateRootAccount() {
    setSelectedAccountId(null);
    setEditingPlayerAccountId(null);
    setAccountPanelMode("create");
    setPlayerAccountForm({
      accountType: "super_master",
      parentId: "",
      username: "",
      displayName: "",
      email: "",
      phone: "",
      marketId: "",
      language: "",
      currency: "USD",
      status: "active",
      cashBalance: "0",
      creditLimit: "0",
      currentExposure: "0",
      maxBet: "",
      maxPayout: "",
      notes: "",
    });
  }

  function startEditSelectedAccount(account: PlayerAccount) {
    editPlayerAccount(account);
    setSelectedAccountId(account.id);
    setAccountPanelMode("edit");
  }

  function startMoveSelectedAccount(account: PlayerAccount) {
    editPlayerAccount(account);
    setSelectedAccountId(account.id);
    setAccountPanelMode("move");
  }

  function toggleSelectedAccountStatus(account: PlayerAccount) {
    setPlayerAccounts(
      playerAccounts.map((createdAccount) =>
        createdAccount.id === account.id
          ? {
              ...createdAccount,
              status:
                createdAccount.status === "active" ? "inactive" : "active",
            }
          : createdAccount
      )
    );
  }

  function accountMatchesTreeFilter(account: PlayerAccount) {
    if (accountTreeFilter === "all") return true;
    if (accountTreeFilter === "active") return account.status === "active";
    if (accountTreeFilter === "inactive") return account.status !== "active";
    return account.accountType === accountTreeFilter;
  }

  function accountMatchesSearch(account: PlayerAccount) {
    const searchTerm = accountSearchTerm.trim().toLowerCase();

    if (!searchTerm) {
      return true;
    }

    return (
      account.username.toLowerCase().includes(searchTerm) ||
      account.displayName.toLowerCase().includes(searchTerm)
    );
  }

  function shouldShowAccountInTree(account: PlayerAccount): boolean {
    const directMatch =
      accountMatchesTreeFilter(account) && accountMatchesSearch(account);

    if (directMatch) {
      return true;
    }

    return getChildAccounts(account.id).some((childAccount) =>
      shouldShowAccountInTree(childAccount)
    );
  }

  function renderNetworkTreeNode(account: PlayerAccount, depth = 0): ReactNode {
    if (!shouldShowAccountInTree(account)) {
      return null;
    }

    const childAccounts = getChildAccounts(account.id).filter((childAccount) =>
      shouldShowAccountInTree(childAccount)
    );
    const hasChildren = childAccounts.length > 0;
    const isExpanded =
      expandedNetworkAccountIds.includes(account.id) ||
      accountSearchTerm.trim().length > 0 ||
      accountTreeFilter !== "all";
    const isSelected = selectedAccountId === account.id;

    return (
      <div key={account.id}>
        <div
          className={`flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm ${
            isSelected ? "bg-blue-50 text-blue-900" : "hover:bg-gray-100"
          }`}
          style={{ marginLeft: `${depth * 18}px` }}
          onClick={() => selectNetworkAccount(account.id)}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (hasChildren) {
                toggleNetworkAccount(account.id);
              }
            }}
            className="w-5 text-center text-xs text-gray-600"
          >
            {hasChildren ? (isExpanded ? "▼" : "▶") : ""}
          </button>
          <span
            className={`h-2 w-2 rounded-full ${
              account.status === "active" ? "bg-green-600" : "bg-gray-400"
            }`}
          />
          <span className="font-semibold">{account.username.toUpperCase()}</span>
          <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
            {getAccountTypeLabel(account.accountType)}
          </span>
          {hasChildren && (
            <span className="text-xs text-gray-500">({childAccounts.length})</span>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div className="border-l border-gray-200">
            {childAccounts.map((childAccount) =>
              renderNetworkTreeNode(childAccount, depth + 1)
            )}
          </div>
        )}
      </div>
    );
  }

  function renderAccountHierarchyNode(
    account: PlayerAccount,
    depth = 0
  ): ReactNode {
    const childAccounts = getChildAccounts(account.id);

    return (
      <div
        key={account.id}
        className={`rounded border ${
          depth === 0 ? "bg-gray-50 p-4" : "bg-white p-3"
        }`}
      >
        <p className="text-sm font-semibold uppercase text-gray-500">
          {getAccountTypeLabel(account.accountType)}
        </p>
        <p className="font-semibold text-gray-900">
          {account.displayName} ({account.username})
        </p>

        {childAccounts.length > 0 && (
          <div className="mt-3 ml-4 grid gap-3 border-l pl-4">
            {childAccounts.map((childAccount) =>
              renderAccountHierarchyNode(childAccount, depth + 1)
            )}
          </div>
        )}
      </div>
    );
  }

  function getTransactionTypesForCategory(category: LedgerCategory): TransactionType[] {
    if (category === "accounting") {
      return [
        "deposit",
        "withdrawal",
        "zero_balance_credit",
        "zero_balance_debit",
        "transfer_in",
        "transfer_out",
        "manual_adjustment",
      ];
    }

    if (category === "operational") {
      return [
        "bet_stake",
        "bet_win",
        "win",
        "loss",
        "credit_adjustment",
        "debit_adjustment",
        "freeplay_win",
      ];
    }

    return [
      "freeplay_grant",
      "freeplay_wager",
      "freeplay_expiration",
      "freeplay_adjustment",
      "freeplay_reversal",
    ];
  }

  function getTransactionTypeLabel(transactionType: TransactionType) {
    if (transactionType === "bet_stake") return "Stake";
    if (transactionType === "bet_win") return "Win";
    if (transactionType === "freeplay_win") return "Freeplay Win";

    return transactionType;
  }

  function getAccountLedgerTransactions(accountId: string) {
    return ledgerTransactions.filter(
      (transaction) => transaction.accountId === accountId
    );
  }

  function calculateAccountingBalance(accountId: string) {
    return calculateAccountingBalanceFromTransactions(ledgerTransactions, accountId);
  }

  function calculateWeeklyFigure(accountId: string) {
    return calculateWeeklyFigureFromTransactions(ledgerTransactions, accountId);
  }

  function calculateFreeplayBalance(accountId: string) {
    return calculateFreeplayBalanceFromTransactions(ledgerTransactions, accountId);
  }

  function calculatePendingExposure(accountId: string) {
    const account = playerAccounts.find(
      (createdAccount) => createdAccount.id === accountId
    );

    // Future pendingExposure = open unsettled wagers from ticket/risk integrations.
    return calculatePendingExposureFromAccount(account);
  }

  function getAccountFinancialSummary(accountId: string): AccountFinancialSummary {
    const account = playerAccounts.find(
      (createdAccount) => createdAccount.id === accountId
    );
    // Future hierarchical credit allocation: credit allocated downward reduces available credit upward.
    return buildAccountFinancialSummary({
      account,
      transactions: ledgerTransactions,
    });
  }

  function saveLedgerTransaction(event: React.FormEvent) {
    event.preventDefault();
    const result = createLedgerTransactionController({
      form: ledgerForm,
      transactions: ledgerTransactions,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setLedgerTransactions(result.data.transactions);
    setLedgerForm({
      ...ledgerForm,
      amount: "",
      description: "",
      referenceId: "",
    });
  }

  function reverseLedgerTransaction(transaction: LedgerTransaction) {
    const result = reverseLedgerTransactionController({
      transaction,
      transactions: ledgerTransactions,
      createdBy: ledgerForm.createdBy,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    if (!window.confirm("Reverse this transaction? The original transaction will remain unchanged.")) {
      return;
    }

    setLedgerTransactions(result.data.transactions);
  }

  function getStatementTransactions(accountId: string) {
    const statementTypes: TransactionType[] = [
      "deposit",
      "withdrawal",
      "bet_stake",
      "bet_win",
      "win",
      "loss",
      "credit_adjustment",
      "debit_adjustment",
      "freeplay_win",
    ];

    return getAccountLedgerTransactions(accountId)
      .filter((transaction) => statementTypes.includes(transaction.transactionType))
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }

  function getTicketLines(ticketId: string) {
    return ticketLines.filter((line) => line.ticketId === ticketId);
  }

  function calculateTicketTotalStake(ticketId: string) {
    return calculateTicketTotalStakeFromLines(getTicketLines(ticketId));
  }

  function calculateTicketPotentialPayout(ticketId: string) {
    return calculateTicketPotentialPayoutFromLines(getTicketLines(ticketId));
  }

  function calculatePendingExposureForAccount(accountId: string) {
    const openTicketIds = new Set(
      tickets
        .filter(
          (ticket) => ticket.accountId === accountId && isOpenTicketStatus(ticket.status)
        )
        .map((ticket) => ticket.id)
    );

    return ticketLines
      .filter((line) => openTicketIds.has(line.ticketId))
      .reduce((total, line) => total + Number(line.stake || 0), 0);
  }

  function calculatePendingExposureForDownline(accountId: string) {
    const accountIds = [accountId, ...getDescendantAccountIds(accountId)];

    return accountIds.reduce(
      (total, currentAccountId) =>
        total + calculatePendingExposureForAccount(currentAccountId),
      0
    );
  }

  function addDraftTicketLine() {
    const result = addTicketLineController(ticketLineForm);

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setDraftTicketLines([
      ...draftTicketLines,
      result.data.line,
    ]);
    setTicketLineForm({
      wagerTypeId: "",
      wagerOptionId: "",
      selectedNumbers: "",
      stake: "",
      potentialPayout: "",
    });
  }

  function removeDraftTicketLine(index: number) {
    setDraftTicketLines(
      draftTicketLines.filter((_, lineIndex) => lineIndex !== index)
    );
  }

  function saveTestTicket(event: React.FormEvent) {
    event.preventDefault();
    const result = createTicketController({
      form: ticketForm,
      draftLines: draftTicketLines,
      tickets,
      ticketLines,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }
    const ticket = result.data.ticket;

    setTickets(result.data.tickets);
    setTicketLines(result.data.ticketLines);
    setExpandedTicketIds([...expandedTicketIds, ticket.id]);
    setDraftTicketLines([]);
    setTicketForm({
      accountId: "",
      marketId: "",
      gameId: "",
      drawingId: "",
      fundingType: "cash",
      notes: "",
    });
  }

  function toggleTicketExpanded(ticketId: string) {
    setExpandedTicketIds((currentIds) =>
      currentIds.includes(ticketId)
        ? currentIds.filter((currentId) => currentId !== ticketId)
        : [...currentIds, ticketId]
    );
  }

  function updateTicketStatus(ticketId: string, nextStatus: TicketStatus) {
    const result = updateTicketStatusController({
      tickets,
      ticketId,
      nextStatus,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setTickets(result.data.tickets);
  }

  function getSettlementRecordsForRun(settlementRunId: string) {
    return getSettlementRecordsForRunFromRecords(
      settlementRecords,
      settlementRunId
    );
  }

  function getSettlementRecordsForTicket(ticketId: string) {
    return getSettlementRecordsForTicketFromRecords(settlementRecords, ticketId);
  }

  function getSettlementRunsForDrawing(drawingId: string) {
    return getSettlementRunsForDrawingFromRuns(settlementRuns, drawingId);
  }

  function calculateSettlementRunTotals(settlementRunId: string) {
    return calculateSettlementRunTotalsFromRecords(
      getSettlementRecordsForRun(settlementRunId)
    );
  }

  function hasExistingCompletedSettlementForDrawing(drawingId: string) {
    return hasCompletedSettlementRunForDrawing(settlementRuns, drawingId);
  }

  function getDrawingGameId(drawing: any) {
    if (drawing?.gameId) {
      return String(drawing.gameId);
    }

    const drawingGameIndex = games.findIndex((game: any) => game === drawing?.game);

    if (drawingGameIndex >= 0) {
      return getGameLocalId(drawing.game, drawingGameIndex);
    }

    const matchingGameIndex = games.findIndex(
      (game: any) =>
        game.name === drawing?.game?.name && game.state === drawing?.game?.state
    );

    if (matchingGameIndex >= 0) {
      return getGameLocalId(games[matchingGameIndex], matchingGameIndex);
    }

    return "";
  }

  function createSettlementRun(event: React.FormEvent) {
    event.preventDefault();

    if (
      getSettlementRunsForDrawing(settlementForm.drawingId).length > 0 &&
      !confirm(
        "A settlement run already exists for this drawing. Create another pending run?"
      )
    ) {
      return;
    }

    const drawing = drawings.find(
      (createdDrawing: any) => createdDrawing.id === settlementForm.drawingId
    );
    const result = createSettlementRunController({
      drawingId: settlementForm.drawingId,
      gameId: getDrawingGameId(drawing),
      notes: settlementForm.notes,
      runs: settlementRuns,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setSettlementRuns(result.data.runs);
    setSettlementForm({
      drawingId: "",
      notes: "",
    });
  }

  function generatePlaceholderSettlementRecords(settlementRunId: string) {
    const result = generatePlaceholderSettlementRecordsController({
      settlementRunId,
      runs: settlementRuns,
      records: settlementRecords,
      tickets,
      ticketLines,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setSettlementRecords(result.data.records);
    setSettlementRuns(result.data.runs);
  }

  function toggleSettlementRunExpanded(settlementRunId: string) {
    setExpandedSettlementRunIds((currentIds) =>
      currentIds.includes(settlementRunId)
        ? currentIds.filter((currentId) => currentId !== settlementRunId)
        : [...currentIds, settlementRunId]
    );
  }

  function updateSettlementRunStatus(
    settlementRunId: string,
    nextStatus: SettlementRunStatus
  ) {
    const run = settlementRuns.find(
      (createdRun) => createdRun.id === settlementRunId
    );

    if (!run) {
      return;
    }

    const result = updateSettlementRunStatusController({
      settlementRunId,
      nextStatus,
      runs: settlementRuns,
      records: settlementRecords,
    });

    if (!result.success || !result.data) {
      if (
        nextStatus === "completed" &&
        hasCompletedSettlementRunForDrawing(settlementRuns, run.drawingId, run.id)
      ) {
        alertControllerErrors(result);
      }
      return;
    }

    setSettlementRuns(result.data.runs);
    setSettlementRecords(result.data.records);
  }

  function addDefaultKenoWagerTypes() {
    if (!wagerTypeForm.gameId) {
      alert("Select a Keno game first.");
      return;
    }

    const selectedGame = games.find(
      (game: any, index: number) => getGameLocalId(game, index) === wagerTypeForm.gameId
    );

    if (!selectedGame || selectedGame.gameType !== "keno_style") {
      alert("Select a valid Keno game first.");
      return;
    }

    const result = addDefaultKenoWagersController({
      gameId: wagerTypeForm.gameId,
      wagerTypes,
      wagerOptions,
      payTables,
    });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setWagerTypes(result.data.wagerTypes);
    setWagerOptions(result.data.wagerOptions);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result =
      editingGameIndex !== null
        ? updateGameController({
            games,
            form,
            editingGameIndex,
          })
        : createGameController({
            games,
            form,
          });

    if (!result.success || !result.data) {
      alertControllerErrors(result);
      return;
    }

    setGames(result.data.games);

    if (editingGameIndex !== null) {
      setEditingGameIndex(null);
    }

    setForm({
      state: "",
      name: "",
      status: "Active",
      gameType: "pick_n",
      gameFamily: "lottery",
      requiresPaytable: false,
      activePaytableId: null,
      mainNumbersCount: "",
      mainNumbersMin: "",
      mainNumbersMax: "",
      bonusNumbersCount: "",
      bonusNumbersMin: "",
      bonusNumbersMax: "",
      numberRangeMin: "1",
      numberRangeMax: "80",
      numbersDrawn: "20",
      availableSpots: "1,2,3,4,5,6,7,8,9,10",
      bullseyeEnabled: false,
      drawFrequencyType: "manual",
      drawIntervalSeconds: "",
      drawIdPrefix: "",
      autoGenerateDraws: false,
      ticketPrice: "",
      scheduleType: "one_time",
      recurringFrequency: "daily",
      defaultDrawTime: "",
      defaultCutoffTime: "",
      defaultTimeZone: "America/New_York",
      payoutMultiplier: "",
      maxPayout: "",
      defaultMaxBet: "",
      defaultMaxTotalHandle: "",
      defaultMaxTotalLiability: "",
    });
  }

  function handleDrawingChange(
  event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  const { name, value } = event.target;

  if (name === "gameIndex") {
    const selectedGame = games[Number(value)];

    if (!selectedGame) return;

    setDrawingForm({
      ...drawingForm,
      gameIndex: value,
      drawTime: selectedGame.defaultDrawTime || "",
      cutoffTime: selectedGame.defaultCutoffTime || "",
      timeZone: selectedGame.defaultTimeZone || "America/New_York",
    });

    return;
  }

  setDrawingForm({
    ...drawingForm,
    [name]: value,
  });
  }
function handleReportFilterChange(
  e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  const { name, value } = e.target;

  setReportFilters((prev) => ({
    ...prev,
    [name]: value,
  }));
}
  function handleDrawingSubmit(event: React.FormEvent) {
  event.preventDefault();

  const selectedGame = games[Number(drawingForm.gameIndex)];

  const now = new Date();
  const cutoffDateTime = new Date(
    `${drawingForm.drawDate}T${drawingForm.cutoffTime}`
  );

  let calculatedStatus = drawingForm.status;

  if (now > cutoffDateTime) {
    calculatedStatus = "closed";
  }
const drawingId = `${selectedGame.state}-${selectedGame.name
  .replace(/\s+/g, "-")
  .toUpperCase()}-${drawingForm.drawDate}-${Date.now()}`;

const drawingPayload = {
  ...drawingForm,
  status: calculatedStatus,
  game: selectedGame,
};

if (editingDrawingIndex !== null) {
  setDrawings(
    drawings.map((drawing: any, index: number) =>
      index === editingDrawingIndex
        ? {
            ...drawing,
            ...drawingPayload,
          }
        : drawing
    )
  );

  setEditingDrawingIndex(null);
} else {
  setDrawings([
    ...drawings,
    {
      id: drawingId,
      ...drawingPayload,
      totalHandle: 0,
      totalPotentialPayout: 0,
      worstCaseLiability: 0,
      housePosition: 0,
      winningNumbers: "",
      winningBonus: "",
      resultSource: "",
      settledAt: "",
      bets: [],
    },

  ]);
}

    setDrawingForm({
      gameIndex: "",
      drawDate: "",
      drawTime: "",
      cutoffTime: "",
      timeZone: "America/New_York",
      status: "scheduled",
      maxBet: "",
      maxTotalHandle: "",
      maxTotalLiability: "",
    });

  }
  function getDrawingStatus(drawing: any) {
  const now = currentTime;

  // Get current time in the drawing's timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone:
  drawing.timeZone &&
  drawing.timeZone !== "DEFAULT_TIME_ZONE"
    ? drawing.timeZone
    : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value;

  const nowInTZ = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`
  );

  const cutoffDateTime = new Date(
    `${drawing.drawDate}T${drawing.cutoffTime}`
  );

  if (nowInTZ > cutoffDateTime) {
    return "closed";
  }

  return drawing.status;
}
function generateTodayDrawings() {
  const today = new Date().toISOString().split("T")[0];

  const targetGames =
  selectedGameIndex === ""
    ? games
    : [games[Number(selectedGameIndex)]];

const newDrawings = targetGames
    .filter((game: any) => game.scheduleType === "recurring")
    .map((game: any) => {
      const drawingId = `${game.state}-${game.name
        .replace(/\s+/g, "-")
        .toUpperCase()}-${today}-${game.defaultDrawTime}`;

      const alreadyExists = drawings.some(
        (drawing: any) => drawing.id === drawingId
      );

      if (alreadyExists) {
        return null;
      }

      return {
        id: drawingId,
        game,
        drawDate: today,
        drawTime: game.defaultDrawTime,
        cutoffTime: game.defaultCutoffTime,
        timeZone: game.defaultTimeZone || "America/New_York",
        status: "scheduled",
        maxBet: game.defaultMaxBet || "",
        maxTotalHandle: game.defaultMaxTotalHandle || "",
        maxTotalLiability: game.defaultMaxTotalLiability || "",
        totalHandle: 0,
        totalPotentialPayout: 0,
        worstCaseLiability: 0,
        housePosition: 0,
        winningNumbers: "",
        winningBonus: "",
        resultSource: "",
        settledAt: "",
        bets: [],

      };
    })
    .filter(Boolean);

  setDrawings([...drawings, ...newDrawings]);

alert(
  newDrawings.length > 0
    ? `${newDrawings.length} drawing(s) generated for today.`
    : "No new drawings generated. They may already exist or no recurring game was selected."
);
}

function generateNext7Days() {
  const newDrawings: any[] = [];

  const targetGames =
  selectedGameIndex === ""
    ? games
    : [games[Number(selectedGameIndex)]];

targetGames
    .filter((game: any) => game.scheduleType === "recurring")
    .forEach((game: any) => {
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);

        const drawDate = date.toISOString().split("T")[0];

        const drawingId = `${game.state}-${game.name
          .replace(/\s+/g, "-")
          .toUpperCase()}-${drawDate}-${game.defaultDrawTime}`;

        const alreadyExists = drawings.some(
          (drawing: any) => drawing.id === drawingId
        );

        if (!alreadyExists) {
          newDrawings.push({
            id: drawingId,
            game,
            drawDate,
            drawTime: game.defaultDrawTime,
            cutoffTime: game.defaultCutoffTime,
            timeZone: game.defaultTimeZone || "America/New_York",
            status: "scheduled",
            maxBet: game.defaultMaxBet || "",
            maxTotalHandle: game.defaultMaxTotalHandle || "",
            maxTotalLiability: game.defaultMaxTotalLiability || "",
            totalHandle: 0,
            totalPotentialPayout: 0,
            worstCaseLiability: 0,
            housePosition: 0,
            winningNumbers: "",
            winningBonus: "",
            resultSource: "",
            settledAt: "",
            bets: [],

          });
        }
      }
    });

  setDrawings([...drawings, ...newDrawings]);

alert(
  newDrawings.length > 0
    ? `${newDrawings.length} drawing(s) generated for the next 7 days.`
    : "No new drawings generated. They may already exist or no recurring game was selected."
);
}

function getDatePartsInTimeZone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    compactDate: `${get("year")}${get("month")}${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

function getKenoGames() {
  return games.filter((game: any) => game.gameType === "keno_style");
}

function getSelectedKenoGame() {
  return games.find(
    (game: any, index: number) => getGameLocalId(game, index) === selectedKenoGameId
  );
}

function getKenoDrawSequence(prefix: string, compactDate: string, pendingDrawings: any[]) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedPrefix}-${compactDate}-(\\d{4})$`);
  const maxSequence = pendingDrawings.reduce((max: number, drawing: any) => {
    const match = String(drawing.drawCode || drawing.id || "").match(pattern);

    if (!match) {
      return max;
    }

    return Math.max(max, Number(match[1] || 0));
  }, 0);

  return maxSequence + 1;
}

function createKenoDrawing(game: any, drawDateTime: Date, pendingDrawings: any[]) {
  const timeZone = game.defaultTimeZone || "America/New_York";
  const intervalSeconds = Number(game.drawIntervalSeconds || 240);
  const prefix = String(game.drawIdPrefix || "HS").trim() || "HS";
  const drawParts = getDatePartsInTimeZone(drawDateTime, timeZone);
  const cutoffDateTime = new Date(
    drawDateTime.getTime() - Math.max(1, Math.min(intervalSeconds, 60)) * 1000
  );
  const cutoffParts = getDatePartsInTimeZone(cutoffDateTime, timeZone);
  const sequence = getKenoDrawSequence(prefix, drawParts.compactDate, pendingDrawings);
  const drawCode = `${prefix}-${drawParts.compactDate}-${String(sequence).padStart(4, "0")}`;

  return {
    id: drawCode,
    drawCode,
    game,
    gameId: getGameLocalId(game, games.findIndex((createdGame: any) => createdGame === game)),
    drawDate: drawParts.date,
    drawTime: drawParts.time,
    drawDateTime: drawDateTime.toISOString(),
    cutoffTime: cutoffParts.time,
    cutoffDateTime: cutoffDateTime.toISOString(),
    timeZone,
    status: "open",
    maxBet: game.defaultMaxBet || "",
    maxTotalHandle: game.defaultMaxTotalHandle || "",
    maxTotalLiability: game.defaultMaxTotalLiability || "",
    totalHandle: 0,
    totalPotentialPayout: 0,
    worstCaseLiability: 0,
    housePosition: 0,
    winningNumbers: "",
    winningBonus: "",
    resultSource: "",
    settledAt: "",
    bets: [],
  };
}

function generateKenoDraws(count: number) {
  const selectedGame = getSelectedKenoGame();

  if (!selectedGame) {
    alert("Select a Keno game first.");
    return;
  }

  const intervalSeconds = Number(selectedGame.drawIntervalSeconds || 240);
  const generatedDrawings: any[] = [];
  let pendingDrawings = [...drawings];

  for (let i = 1; i <= count; i++) {
    const drawDateTime = new Date(Date.now() + intervalSeconds * i * 1000);
    const drawing = createKenoDrawing(selectedGame, drawDateTime, pendingDrawings);

    if (!pendingDrawings.some((existingDrawing: any) => existingDrawing.id === drawing.id)) {
      generatedDrawings.push(drawing);
      pendingDrawings = [...pendingDrawings, drawing];
    }
  }

  if (generatedDrawings.length === 0) {
    alert("No new Keno drawings generated.");
    return;
  }

  setDrawings([...drawings, ...generatedDrawings]);
  setLastGeneratedKenoDraw(generatedDrawings[generatedDrawings.length - 1]);
}

function generateTodaysKenoDraws() {
  const selectedGame = getSelectedKenoGame();

  if (!selectedGame) {
    alert("Select a Keno game first.");
    return;
  }

  const intervalSeconds = Number(selectedGame.drawIntervalSeconds || 240);
  const timeZone = selectedGame.defaultTimeZone || "America/New_York";
  const now = new Date();
  const nowParts = getDatePartsInTimeZone(now, timeZone);
  const tomorrowStart = new Date(`${nowParts.date}T00:00:00`);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const secondsRemaining = Math.max(
    0,
    Math.floor((tomorrowStart.getTime() - now.getTime()) / 1000)
  );
  const drawCount = Math.floor(secondsRemaining / intervalSeconds);

  generateKenoDraws(drawCount);
}

function getNextKenoDrawPreview() {
  const selectedGame = getSelectedKenoGame();

  if (!selectedGame) {
    return null;
  }

  const intervalSeconds = Number(selectedGame.drawIntervalSeconds || 240);
  return createKenoDrawing(
    selectedGame,
    new Date(Date.now() + intervalSeconds * 1000),
    drawings
  );
}


function handleMockBetChange(
  event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  setMockBetForm({
    ...mockBetForm,
    [event.target.name]: event.target.value,
  });
}
function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function getBoxWayCount(numbers: string) {
  const digits = numbers.replace(/[^0-9]/g, "").split("");

  const counts: Record<string, number> = {};

  digits.forEach((digit) => {
    counts[digit] = (counts[digit] || 0) + 1;
  });

  const totalDigits = digits.length;

  const duplicateFactor = Object.values(counts).reduce(
    (total, count) => total * factorial(count),
    1
  );

  return factorial(totalDigits) / duplicateFactor;
}

function getAdjustedMultiplier(
  baseMultiplier: number,
  betType: string,
  numbers: string
) {
  if (betType === "straight") {
    return baseMultiplier;
  }

  if (betType === "box") {
    const ways = getBoxWayCount(numbers);

    if (ways <= 1) {
      return baseMultiplier;
    }

    return baseMultiplier / ways;
  }

  return baseMultiplier;
}
function handleMockBetSubmit(event: React.FormEvent) {
  event.preventDefault();
  let betAccepted = false;

  setDrawings(drawings.map((drawing: any) => {
      if (drawing.id !== mockBetForm.drawingId) {
        return drawing;
      }
      if (drawing.status === "settled") {
  alert("Bet rejected. This drawing has already been settled.");
  return drawing;
}
if (getDrawingStatus(drawing) === "closed") {
  alert("Bet rejected. This drawing is closed.");
  return drawing;
}
      const numbersArray = mockBetForm.numbers
  .split("-")
  .map((n) => n.trim())
  .filter((n) => n !== "")
  .map((n) => Number(n));
  const minNumber = Number(drawing.game.mainNumbersMin);
const maxNumber = Number(drawing.game.mainNumbersMax);

const outOfRangeNumber = numbersArray.find(
  (number) => number < minNumber || number > maxNumber
);

if (outOfRangeNumber !== undefined) {
  alert(
    `Number ${outOfRangeNumber} is invalid. This game only allows numbers from ${minNumber} to ${maxNumber}.`
  );
  return drawing;
}

const requiredCount = Number(drawing.game.mainNumbersCount);

if (numbersArray.length !== requiredCount) {
  alert(`This game requires exactly ${requiredCount} numbers.`);
  return drawing;
}
      const betAmount = Number(mockBetForm.amount);
      const maxBet = Number(drawing.maxBet || 0);

if (maxBet > 0 && betAmount > maxBet) {
  alert(`Bet rejected. Max bet for this drawing is ${formatMoney(maxBet)}.`);
  return drawing;
}
	      const multiplier = Number(drawing.game.payoutMultiplier || 0);
	      const maxPayout = Number(drawing.game.maxPayout || 0);

	      let newBets: any[] = [];
	      let totalTicketCost = betAmount;
	      let totalPotentialPayout = 0;
	      const boxWayCount = getBoxWayCount(mockBetForm.numbers);

	if (mockBetForm.betType === "straight_box") {
	  // Straight leg
	  const straightMultiplier = multiplier;
	  const straightPayout =
	    maxPayout > 0
	      ? Math.min(betAmount * straightMultiplier, maxPayout)
	      : betAmount * straightMultiplier;

	  // Box leg
	  const boxTotalTicketCost =
	    mockBetForm.boxStakeMode === "per_combo"
	      ? betAmount * boxWayCount
	      : betAmount;
	  const boxAmountPerCombination =
	    mockBetForm.boxStakeMode === "per_combo"
	      ? betAmount
	      : betAmount / boxWayCount;

	  const boxPayout =
	    maxPayout > 0
	      ? Math.min(boxAmountPerCombination * multiplier, maxPayout)
	      : boxAmountPerCombination * multiplier;

	  totalTicketCost = betAmount + boxTotalTicketCost;
	  totalPotentialPayout = straightPayout + boxPayout;

	  newBets = [
	    {
      id: `BET-${Date.now()}-S`,
	      drawingId: drawing.id,
	      playerId: mockBetForm.playerId,
	      playerName: mockBetForm.playerName,
	      agentId: mockBetForm.agentId,
	      numbers: mockBetForm.numbers,
	      betType: "straight",
      amount: betAmount,
      potentialPayout: straightPayout,
      placedAt: new Date().toISOString(),
      status: "accepted",
    },
    {
		      id: `BET-${Date.now()}-B`,
		      drawingId: drawing.id,
		      playerId: mockBetForm.playerId,
		      playerName: mockBetForm.playerName,
		      agentId: mockBetForm.agentId,
		      numbers: mockBetForm.numbers,
	      betType: "box",
	      amount: boxTotalTicketCost,
	      boxStakeMode: mockBetForm.boxStakeMode,
	      potentialPayout: boxPayout,
	      placedAt: new Date().toISOString(),
	      status: "accepted",
	    },
	  ];
	} else {
	  let storedBetAmount = betAmount;
	  let potentialPayout = 0;

	  if (mockBetForm.betType === "box") {
	    const amountPerCombination =
	      mockBetForm.boxStakeMode === "per_combo"
	        ? betAmount
	        : betAmount / boxWayCount;

	    storedBetAmount =
	      mockBetForm.boxStakeMode === "per_combo"
	        ? betAmount * boxWayCount
	        : betAmount;

	    const calculatedPayout = amountPerCombination * multiplier;
	    potentialPayout =
	      maxPayout > 0
	        ? Math.min(calculatedPayout, maxPayout)
	        : calculatedPayout;
	  } else {
	    const calculatedPayout = betAmount * multiplier;
	    potentialPayout =
	      maxPayout > 0
	        ? Math.min(calculatedPayout, maxPayout)
	        : calculatedPayout;
	  }

	  totalTicketCost = storedBetAmount;
	  totalPotentialPayout = potentialPayout;

	  newBets = [
	    {
		      id: `BET-${Date.now()}`,
		      drawingId: drawing.id,
		      playerId: mockBetForm.playerId,
		      playerName: mockBetForm.playerName,
		      agentId: mockBetForm.agentId,
		      numbers: mockBetForm.numbers,
	      betType: mockBetForm.betType,
	      amount: storedBetAmount,
	      boxStakeMode:
	        mockBetForm.betType === "box" ? mockBetForm.boxStakeMode : undefined,
	      potentialPayout,
	      placedAt: new Date().toISOString(),
	      status: "accepted",
        },
  ];
}

      const updatedBets = [...(drawing.bets || []), ...newBets];


      const exposureMap: Record<string, number> = {};

      updatedBets.forEach((bet: any) => {
        const combo = bet.numbers.trim();
        exposureMap[combo] =
          (exposureMap[combo] || 0) + Number(bet.potentialPayout);
      });

      const worstCase = Math.max(...Object.values(exposureMap), 0);
      const maxLiability = Number(drawing.maxTotalLiability || 0);

if (maxLiability > 0 && worstCase > maxLiability) {
  alert(
    `Bet rejected. This would exceed max liability of ${formatMoney(maxLiability)}.`
  );
  return drawing;
}
	      betAccepted = newBets.length > 0;
	      return {
		        ...drawing,
		        bets: updatedBets,
	        totalHandle: Number(drawing.totalHandle || 0) + totalTicketCost,
	        totalPotentialPayout:
	          Number(drawing.totalPotentialPayout || 0) + totalPotentialPayout,
	        worstCaseLiability: worstCase,
	        housePosition:
	          Number(drawing.totalHandle || 0) +
	          totalTicketCost -
	          (Number(drawing.totalPotentialPayout || 0) + totalPotentialPayout),
	      };
    })
  );

  if (betAccepted) {
	    setMockBetForm({
	      drawingId: "",
	      playerId: "",
	      playerName: "",
	      agentId: "",
	      numbers: "",
      amount: "",
      betType: "straight",
      boxStakeMode: "total",
    });
  }
}
  function toggleDrawingDetails(id: string) {
  setExpandedDrawingIds((prev) =>
    prev.includes(id)
      ? prev.filter((drawingId) => drawingId !== id)
      : [...prev, id]
  );


}
function toggleBetDetails(betId: string) {
  setExpandedBetIds((prev) =>
    prev.includes(betId)
      ? prev.filter((id) => id !== betId)
      : [...prev, betId]
  );
}
function toggleExpandedBetList(drawingId: string) {
  setExpandedBetLists((prev) =>
    prev.includes(drawingId)
      ? prev.filter((id) => id !== drawingId)
      : [...prev, drawingId]
  );
}
function updateBetSearchTerm(drawingId: string, value: string) {
  setBetSearchTerms((prev) => ({
    ...prev,
    [drawingId]: value,
  }));
}
function updateBetStatusFilter(drawingId: string, value: string) {
  setBetStatusFilters((prev) => ({
    ...prev,
    [drawingId]: value,
  }));
}
function updateBetTypeFilter(drawingId: string, value: string) {
  setBetTypeFilters((prev) => ({
    ...prev,
    [drawingId]: value,
  }));
}
function toggleDrawingDetails(id: string) {
  setExpandedDrawingIds((prev) =>
    prev.includes(id)
      ? prev.filter((drawingId) => drawingId !== id)
      : [...prev, id]);
}
function toggleGameDetails(index: number) {
  setExpandedGameIds((prev) =>
    prev.includes(index)
      ? prev.filter((gameIndex) => gameIndex !== index)
      : [...prev, index]
  );
}
function disableGame(index: number) {
  const confirmed = confirm("Disable this game? Existing drawings and bets will remain.");

  if (!confirmed) return;

  setGames(
    games.map((game: any, gameIndex: number) =>
      gameIndex === index ? { ...game, status: "disabled" } : game
    )
  );
}

function archiveGame(index: number) {
  const confirmed = confirm("Archive this game? Historical drawings and bets will remain.");

  if (!confirmed) return;

  setGames(
    games.map((game: any, gameIndex: number) =>
      gameIndex === index ? { ...game, status: "archived" } : game
    )
  );
}

function restoreGame(index: number) {
  const confirmed = confirm("Restore this archived game?");

  if (!confirmed) return;

  setGames(
    games.map((game: any, gameIndex: number) =>
      gameIndex === index ? { ...game, status: "active" } : game
    )
  );
}

function deleteGame(index: number) {
  const gameToDelete = games[index];

  const relatedDrawings = drawings.filter(
    (drawing: any) =>
      drawing.game.name === gameToDelete.name &&
      drawing.game.state === gameToDelete.state
  );

  const hasBets = relatedDrawings.some(
    (drawing: any) => drawing.bets && drawing.bets.length > 0
  );

  if (hasBets) {
    alert("Delete blocked. This game has drawings with bets attached.");
    return;
  }

  const confirmed = confirm(
    relatedDrawings.length > 0
      ? "Delete this game and its drawings? This cannot be undone."
      : "Delete this game? This cannot be undone."
  );

  if (!confirmed) return;

  setGames(games.filter((_: any, gameIndex: number) => gameIndex !== index));

  setDrawings(
    drawings.filter(
      (drawing: any) =>
        !(
          drawing.game.name === gameToDelete.name &&
          drawing.game.state === gameToDelete.state
        )
    )
  );
}
function editGame(index: number) {
  setEditingGameIndex(index);
  const game = games[index];

  setForm({
    ...game,
    gameFamily:
      game.gameFamily || (game.gameType === "keno_style" ? "keno" : "lottery"),
    requiresPaytable:
      game.requiresPaytable !== undefined
        ? game.requiresPaytable
        : game.gameType === "keno_style",
    activePaytableId: game.activePaytableId || null,
    numberRangeMin:
      game.numberRangeMin || game.numberPoolMin || game.mainNumbersMin || "1",
    numberRangeMax:
      game.numberRangeMax || game.numberPoolMax || game.mainNumbersMax || "80",
    numbersDrawn: game.numbersDrawn || game.drawCount || "20",
    availableSpots: Array.isArray(game.availableSpots)
      ? game.availableSpots.join(",")
      : Array.isArray(game.allowedSpotCounts)
        ? game.allowedSpotCounts.join(",")
        : game.availableSpots || "1,2,3,4,5,6,7,8,9,10",
    bullseyeEnabled: Boolean(game.bullseyeEnabled),
    drawFrequencyType:
      game.drawFrequencyType || (game.gameType === "keno_style" ? "recurring" : "manual"),
    drawIntervalSeconds:
      game.drawIntervalSeconds || (game.gameType === "keno_style" ? "240" : ""),
    drawIdPrefix: game.drawIdPrefix || (game.gameType === "keno_style" ? "HS" : ""),
    autoGenerateDraws:
      game.autoGenerateDraws !== undefined
        ? Boolean(game.autoGenerateDraws)
        : game.gameType === "keno_style",
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function parseKenoWinningNumbers(value: any) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
        .split("-")
        .map((part) => part.trim())
        .filter(Boolean);

  const numbers = values.map((number) => Number(number));

  if (
    values.length === 0 ||
    numbers.some((number) => !Number.isInteger(number))
  ) {
    return [];
  }

  return numbers;
}

function calculateKenoDrawMetrics({
  drawing,
  game,
  winningNumbers,
  bullseyeNumber,
}: {
  drawing: any;
  game: any;
  winningNumbers: any;
  bullseyeNumber?: any;
}): KenoDrawMetrics {
  const numbers = parseKenoWinningNumbers(winningNumbers);

  if (numbers.length === 0) {
    throw new Error("Keno winning numbers must contain at least one number.");
  }

  const parsedBullseyeNumber = Number(bullseyeNumber || 0);
  const resolvedBullseyeNumber =
    game?.bullseyeEnabled
      ? Number.isInteger(parsedBullseyeNumber) && parsedBullseyeNumber > 0
        ? parsedBullseyeNumber
        : numbers[0]
      : null;
  const drawingId = String(drawing.id || drawing.drawCode || "");
  const drawSum = numbers.reduce((sum, number) => sum + number, 0);
  const lowCount = numbers.filter((number) => number >= 1 && number <= 40).length;
  const highCount = numbers.filter((number) => number >= 41 && number <= 80).length;
  const dragonDigit = Math.floor(drawSum / 10) % 10;
  const tigerDigit = drawSum % 10;
  const dragonTigerResult =
    dragonDigit > tigerDigit
      ? "dragon"
      : tigerDigit > dragonDigit
        ? "tiger"
        : "tie";
  const upDownResult =
    lowCount > highCount
      ? "up"
      : highCount > lowCount
        ? "down"
        : "tie";

  return {
    id: `METRICS-${drawingId}`,
    drawingId,
    gameId: String(drawing.gameId || game?.externalId || game?.name || ""),
    drawSum,
    oddCount: numbers.filter((number) => number % 2 !== 0).length,
    evenCount: numbers.filter((number) => number % 2 === 0).length,
    lowCount,
    highCount,
    firstHalfCount: numbers.filter((number) => number >= 1 && number <= 40).length,
    secondHalfCount: numbers.filter((number) => number >= 41 && number <= 80).length,
    minDrawnNumber: Math.min(...numbers),
    maxDrawnNumber: Math.max(...numbers),
    dragonDigit,
    tigerDigit,
    dragonTigerResult,
    upDownResult,
    bullseyeNumber: resolvedBullseyeNumber,
    woodCount: numbers.filter((number) => number >= 1 && number <= 16).length,
    fireCount: numbers.filter((number) => number >= 17 && number <= 32).length,
    earthCount: numbers.filter((number) => number >= 33 && number <= 48).length,
    metalCount: numbers.filter((number) => number >= 49 && number <= 64).length,
    waterCount: numbers.filter((number) => number >= 65 && number <= 80).length,
    createdAt: new Date().toISOString(),
  };
}

function saveKenoDrawMetrics(metrics: KenoDrawMetrics) {
  setKenoDrawMetrics((prev) => [
    ...prev.filter((item) => item.drawingId !== metrics.drawingId),
    metrics,
  ]);
}

function updateDrawingResult(index: number, field: string, value: string) {
  const targetDrawing = drawings[index];
  // TODO Phase 5.7 integration: emit RESULT_POSTED / RESULT_CORRECTED /
  // RESULT_VOIDED audit events when result state moves through explicit
  // result workflows instead of raw field editing.
  const updatedDrawing = targetDrawing
    ? {
        ...targetDrawing,
        [field]: value,
      }
    : null;

  if (
    updatedDrawing?.game?.gameType === "keno_style" &&
    updatedDrawing.winningNumbers
  ) {
    try {
      saveKenoDrawMetrics(
        calculateKenoDrawMetrics({
          drawing: updatedDrawing,
          game: updatedDrawing.game,
          winningNumbers: updatedDrawing.winningNumbers,
          bullseyeNumber: updatedDrawing.winningBonus,
        })
      );
    } catch (error) {
      console.error("Keno draw metrics calculation failed:", error);
    }
  }

  setDrawings(
    drawings.map((drawing: any, drawingIndex: number) =>
      drawingIndex === index
        ? updatedDrawing || drawing
        : drawing
    )
  );
  function normalizeNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .join("-");
}

function sortNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .join("-");
}

function isWinningBet(bet: any, winningNumbers: string) {
  const betNumbers = normalizeNumbers(bet.numbers);
  const resultNumbers = normalizeNumbers(winningNumbers);

  if (bet.betType === "straight") {
    return betNumbers === resultNumbers;
  }

  if (bet.betType === "box") {
    return sortNumbers(betNumbers) === sortNumbers(resultNumbers);
  }

  return false;
}

}
async function createSettlementAuditLog(payload: any) {
const { error } = await supabase
.from("settlement_audit_logs")
.insert(payload);

if (error) {
console.error("Settlement audit log insert failed:", JSON.stringify(error, null, 2));
}
}
function settleDrawing(index: number) {
  const drawing = drawings[index];
  if (drawing.status === "settled") {
  alert("This drawing has already been settled.");
  return;
}

  if (!drawing.winningNumbers) {
    alert("Enter winning numbers before settling.");
    return;
  }

  const confirmed = confirm("Settle this drawing? This will mark bets as winners or losers.");

  if (!confirmed) return;

  const winningNumbers = drawing.winningNumbers.trim();

  const settledBets = (drawing.bets || []).map((bet: any) => {
    const isWinner = isWinningBet(bet, winningNumbers);

    return {
      ...bet,
      status: isWinner ? "winner" : "loser",
      settledAt: new Date().toISOString(),
    };
  });

  const totalPayout = settledBets
    .filter((bet: any) => bet.status === "winner")
    .reduce((sum: number, bet: any) => sum + Number(bet.potentialPayout || 0), 0);

    const finalHousePosition =
  Number(drawing.totalHandle || 0) - totalPayout;

  createSettlementAuditLog({
    drawing_external_id: drawing.id,
    state: drawing.game?.state || "",
    game_name: drawing.game?.name || "",
    winning_numbers: drawing.winningNumbers || "",
    winning_bonus: drawing.winningBonus || "",
    result_source: drawing.resultSource || "",
    previous_status: drawing.status || "",
    new_status: "settled",
    total_handle: Number(drawing.totalHandle || 0),
    actual_payout: Number(totalPayout || 0),
    house_result: Number(finalHousePosition || 0),
    winner_count: settledBets.filter((bet: any) => bet.status === "winner").length,
    loser_count: settledBets.filter((bet: any) => bet.status === "loser").length,
    override_reason: drawing.overrideReason || "",
    action_type: "settle",
  });

  setDrawings(
    drawings.map((item: any, drawingIndex: number) =>
      drawingIndex === index
        ? {
            ...item,
            bets: settledBets,
            status: "settled",
            settledAt: new Date().toISOString(),
            actualPayout: totalPayout,
            housePosition: finalHousePosition,
          }
        : item
    )
  );


alert(
  `Drawing settled. Total payout: ${formatMoney(totalPayout)}. House result: ${formatMoney(finalHousePosition)}.`
);
}
function normalizeNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .join("-");
}

function sortNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .join("-");
}

function isWinningBet(bet: any, winningNumbers: string) {
  const betNumbers = normalizeNumbers(bet.numbers);
  const resultNumbers = normalizeNumbers(winningNumbers);

  if (bet.betType === "straight") {
    return betNumbers === resultNumbers;
  }

  if (bet.betType === "box") {
    return sortNumbers(betNumbers) === sortNumbers(resultNumbers);
  }

  return false;
}

function reopenDrawing(index: number) {
  const drawing = drawings[index];

  if (drawing.status !== "settled") {
    alert("Only settled drawings can be reopened.");
    return;
  }

  if (!overrideReason.trim()) {
    alert("Enter an override reason before reopening.");
    return;
  }

  const confirmed = confirm(
    "Reopen this settled drawing? This will unlock results and reset bet settlement statuses."
  );

  if (!confirmed) return;

  createSettlementAuditLog({
    drawing_external_id: drawing.id,
    state: drawing.game?.state || "",
    game_name: drawing.game?.name || "",
    winning_numbers: drawing.winningNumbers || "",
    winning_bonus: drawing.winningBonus || "",
    result_source: drawing.resultSource || "",
    previous_status: drawing.status || "",
    new_status: "reopened",
    total_handle: Number(drawing.totalHandle || 0),
    actual_payout: Number(drawing.actualPayout || 0),
    house_result: Number(drawing.housePosition || 0),
    winner_count: (drawing.bets || []).filter((bet: any) => bet.status === "winner").length,
    loser_count: (drawing.bets || []).filter((bet: any) => bet.status === "loser").length,
    override_reason: overrideReason,
    action_type: "reopen",
  });

  setDrawings(
    drawings.map((item: any, drawingIndex: number) =>
      drawingIndex === index
        ? {
            ...item,
            status: "closed",
            settledAt: "",
            actualPayout: 0,
            housePosition: Number(item.totalHandle || 0),
            overrideReason,
            reopenedAt: new Date().toISOString(),
            bets: (item.bets || []).map((bet: any) => ({
              ...bet,
              status: "accepted",
              settledAt: "",
            })),
          }
        : item
    )
  );

  setOverrideReason("");

  alert("Drawing reopened. You can now correct results and settle again.");
}
function getDashboardMetrics() {
  const totalGames = games.length;
  const filteredDrawings = drawings.filter((drawing: any) => {
  const drawingDate = drawing.drawDate;

  if (
    reportFilters.fromDate &&
    drawingDate < reportFilters.fromDate
  ) {
    return false;
  }

  if (
    reportFilters.toDate &&
    drawingDate > reportFilters.toDate
  ) {
    return false;
  }

  if (
    reportFilters.state &&
    drawing.game.state !== reportFilters.state
  ) {
    return false;
  }

  if (
    reportFilters.game &&
    drawing.game.name !== reportFilters.game
  ) {
    return false;
  }

  if (
    reportFilters.status &&
    drawing.status !== reportFilters.status
  ) {
    return false;
  }

  return true;
});
  const totalDrawings = filteredDrawings.length;

  const openDrawings = filteredDrawings.filter(
    (drawing: any) => getDrawingStatus(drawing) === "open"
  ).length;

  const closedDrawings = filteredDrawings.filter(
    (drawing: any) => getDrawingStatus(drawing) === "closed"
  ).length;

  const settledDrawings = filteredDrawings.filter(
    (drawing: any) => drawing.status === "settled"
  ).length;

  const totalHandle = filteredDrawings.reduce(
    (sum: number, drawing: any) => sum + Number(drawing.totalHandle || 0),
    0
  );

  const totalPotentialPayout = filteredDrawings.reduce(
    (sum: number, drawing: any) =>
      sum + Number(drawing.totalPotentialPayout || 0),
    0
  );

  const actualPayout = filteredDrawings.reduce(
    (sum: number, drawing: any) => sum + Number(drawing.actualPayout || 0),
    0
  );

  const houseResult = totalHandle - actualPayout;

  return {
    totalGames,
    totalDrawings,
    openDrawings,
    closedDrawings,
    settledDrawings,
    totalHandle,
    totalPotentialPayout,
    actualPayout,
    houseResult,
  };
}
const metrics = getDashboardMetrics();
function printReport() {
  window.print();
}
function exportReportToCSV() {
  const filteredDrawings = drawings.filter((drawing: any) => {
  const drawingDate = drawing.drawDate;

  if (
    reportFilters.fromDate &&
    drawingDate < reportFilters.fromDate
  ) {
    return false;
  }

  if (
    reportFilters.toDate &&
    drawingDate > reportFilters.toDate
  ) {
    return false;
  }

  if (
    reportFilters.state &&
    drawing.game.state !== reportFilters.state
  ) {
    return false;
  }

  if (
    reportFilters.game &&
    drawing.game.name !== reportFilters.game
  ) {
    return false;
  }

  if (
    reportFilters.status &&
    drawing.status !== reportFilters.status
  ) {
    return false;
  }

  return true;
});

  const drawingRows = filteredDrawings.map((drawing: any) => [
    drawing.id,
    drawing.game.state,
    drawing.game.name,
    drawing.drawDate,
    drawing.drawTime,
    drawing.status === "settled" ? "settled" : getDrawingStatus(drawing),
    formatMoney(drawing.totalHandle),
    formatMoney(drawing.totalPotentialPayout),
    formatMoney(drawing.actualPayout),
    formatMoney(drawing.housePosition),
  ]);

  const rows = [
    ["Metric", "Value"],
    ["Total Games", metrics.totalGames],
    ["Total Drawings", metrics.totalDrawings],
    ["Open Drawings", metrics.openDrawings],
    ["Closed Drawings", metrics.closedDrawings],
    ["Settled Drawings", metrics.settledDrawings],
    ["Total Handle", formatMoney(metrics.totalHandle)],
    ["Potential Payout", formatMoney(metrics.totalPotentialPayout)],
    ["Actual Payout", formatMoney(metrics.actualPayout)],
    ["House Result", formatMoney(metrics.houseResult)],
    [],
    [
      "ID",
      "State",
      "Game",
      "Date",
      "Draw Time",
      "Status",
      "Handle",
      "Potential Payout",
      "Actual Payout",
      "House Result",
    ],
    ...drawingRows,
  ];

  const csvContent = rows
    .map((row) =>
      row
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  const blob = new Blob([csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "lottery-report.csv";
  link.click();

  URL.revokeObjectURL(url);
}
function exportTicketAuditCSV() {
  const filteredDrawings = drawings.filter((drawing: any) => {
  const drawingDate = drawing.drawDate;

  if (
    reportFilters.fromDate &&
    drawingDate < reportFilters.fromDate
  ) {
    return false;
  }

  if (
    reportFilters.toDate &&
    drawingDate > reportFilters.toDate
  ) {
    return false;
  }

  if (
    reportFilters.state &&
    drawing.game.state !== reportFilters.state
  ) {
    return false;
  }

  if (
    reportFilters.game &&
    drawing.game.name !== reportFilters.game
  ) {
    return false;
  }

  if (
    reportFilters.status &&
    drawing.status !== reportFilters.status
  ) {
    return false;
  }

  return true;
});

  const rows = [
    [
      "Bet ID",
      "Drawing ID",
      "State",
      "Game",
	      "Draw Date",
	      "Draw Time",
	      "Player ID",
	      "Player Name",
	      "Agent ID",
	      "Bet Numbers",
      "Bet Type",
      "Bet Amount",
      "Potential Payout",
      "Bet Status",
      "Winning Numbers",
      "Result Source",
    ],
    ...filteredDrawings.flatMap((drawing: any) =>
      (drawing.bets || []).map((bet: any) => [
        bet.id,
        drawing.id,
        drawing.game.state,
	        drawing.game.name,
	        drawing.drawDate,
	        drawing.drawTime,
	        bet.playerId || "",
	        bet.playerName || "",
	        bet.agentId || "",
	        bet.numbers,
        bet.betType,
        formatMoney(bet.amount),
        formatMoney(bet.potentialPayout),
        bet.status,
        drawing.winningNumbers || "",
        drawing.resultSource || "",
      ])
    ),
  ];

  const csvContent = rows
    .map((row) =>
      row
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  const blob = new Blob([csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "lottery-ticket-audit.csv";
  link.click();

  URL.revokeObjectURL(url);
}
function exportSettlementSummaryCSV() {
  const filteredDrawings = drawings.filter((drawing: any) => {
  const drawingDate = drawing.drawDate;

  if (
    reportFilters.fromDate &&
    drawingDate < reportFilters.fromDate
  ) {
    return false;
  }

  if (
    reportFilters.toDate &&
    drawingDate > reportFilters.toDate
  ) {
    return false;
  }

  if (
    reportFilters.state &&
    drawing.game.state !== reportFilters.state
  ) {
    return false;
  }

  if (
    reportFilters.game &&
    drawing.game.name !== reportFilters.game
  ) {
    return false;
  }

  if (
    reportFilters.status &&
    drawing.status !== reportFilters.status
  ) {
    return false;
  }

  return true;
});

  const rows = [
    [
      "Drawing ID",
      "State",
      "Game",
      "Draw Date",
      "Draw Time",
      "Winning Numbers",
      "Result Source",
      "Total Handle",
      "Actual Payout",
      "House Result",
      "Winner Count",
      "Loser Count",
      "Reopened",
      "Override Reason",
      "Settled At",
    ],
    ...filteredDrawings
      .filter((drawing: any) => drawing.status === "settled")
      .map((drawing: any) => {
        const winnerCount = (drawing.bets || []).filter(
          (bet: any) => bet.status === "winner"
        ).length;
        const loserCount = (drawing.bets || []).filter(
          (bet: any) => bet.status === "loser"
        ).length;

        return [
          drawing.id,
          drawing.game.state,
          drawing.game.name,
          drawing.drawDate,
          drawing.drawTime,
          drawing.winningNumbers || "",
          drawing.resultSource || "",
          formatMoney(drawing.totalHandle),
          formatMoney(drawing.actualPayout),
          formatMoney(drawing.housePosition),
          winnerCount,
          loserCount,
          drawing.overrideReason ? "Yes" : "No",
          drawing.overrideReason || "",
          drawing.settledAt || "",
        ];
      }),
  ];

  const csvContent = rows
    .map((row) =>
      row
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  const blob = new Blob([csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "lottery-settlement-summary.csv";
  link.click();

  URL.revokeObjectURL(url);
}
function exportRiskExposureCSV() {
  const filteredDrawings = drawings.filter((drawing: any) => {
  const drawingDate = drawing.drawDate;

  if (
    reportFilters.fromDate &&
    drawingDate < reportFilters.fromDate
  ) {
    return false;
  }

  if (
    reportFilters.toDate &&
    drawingDate > reportFilters.toDate
  ) {
    return false;
  }

  if (
    reportFilters.state &&
    drawing.game.state !== reportFilters.state
  ) {
    return false;
  }

  if (
    reportFilters.game &&
    drawing.game.name !== reportFilters.game
  ) {
    return false;
  }

  if (
    reportFilters.status &&
    drawing.status !== reportFilters.status
  ) {
    return false;
  }

  return true;
});

  const rows = [
    [
      "Drawing ID",
      "State",
      "Game",
      "Draw Date",
      "Draw Time",
      "Status",
      "Max Bet",
      "Max Total Handle",
      "Max Total Liability",
      "Total Handle",
      "Potential Payout",
      "Worst Case Liability",
      "House Position",
      "Most Exposed Numbers",
      "Most Exposed Amount",
    ],
    ...filteredDrawings.map((drawing: any) => {
      const mostExposed = getExposureByNumbers(drawing)[0];

      return [
        drawing.id,
        drawing.game.state,
        drawing.game.name,
        drawing.drawDate,
        drawing.drawTime,
        drawing.status === "settled" ? "settled" : getDrawingStatus(drawing),
        formatMoney(drawing.maxBet),
        formatMoney(drawing.maxTotalHandle),
        formatMoney(drawing.maxTotalLiability),
        formatMoney(drawing.totalHandle),
        formatMoney(drawing.totalPotentialPayout),
        formatMoney(drawing.worstCaseLiability),
        formatMoney(drawing.housePosition),
        mostExposed?.numbers || "",
        formatMoney(mostExposed?.payout || 0),
      ];
    }),
  ];

  const csvContent = rows
    .map((row) =>
      row
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  const blob = new Blob([csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "lottery-risk-exposure.csv";
  link.click();

  URL.revokeObjectURL(url);
}
function deleteDrawing(index: number) {
  const drawing = drawings[index];

  if (drawing.bets && drawing.bets.length > 0) {
    alert("Delete blocked. This drawing has bets attached.");
    return;
  }

  const confirmed = confirm("Delete this drawing? This cannot be undone.");

  if (!confirmed) return;

  setDrawings(drawings.filter((_: any, drawingIndex: number) => drawingIndex !== index));
}

function cancelDrawing(index: number) {
  const confirmed = confirm("Cancel this drawing? Existing bets will remain for audit.");

  if (!confirmed) return;

  setDrawings(
    drawings.map((drawing: any, drawingIndex: number) =>
      drawingIndex === index
        ? { ...drawing, status: "canceled" }
        : drawing
    )
  );
}

function archiveDrawing(index: number) {
  const confirmed = confirm("Archive this drawing? It will remain in records.");

  if (!confirmed) return;

  setDrawings(
    drawings.map((drawing: any, drawingIndex: number) =>
      drawingIndex === index
        ? { ...drawing, status: "archived" }
        : drawing
    )
  );
}

function restoreDrawing(index: number) {
  const confirmed = confirm("Restore this archived drawing?");

  if (!confirmed) return;

  setDrawings(
    drawings.map((drawing: any, drawingIndex: number) =>
      drawingIndex === index
        ? { ...drawing, status: "scheduled" }
        : drawing
    )
  );
}

function editDrawing(index: number) {
  const drawing = drawings[index];

  if (drawing.bets && drawing.bets.length > 0) {
    alert("Edit blocked. This drawing has bets attached.");
    return;
  }

  setEditingDrawingIndex(index);

  const gameIndex = games.findIndex(
    (game: any) =>
      game.state === drawing.game.state &&
      game.name === drawing.game.name
  );

  setDrawingForm({
    gameIndex: String(gameIndex),
    drawDate: drawing.drawDate || "",
    drawTime: drawing.drawTime || "",
    cutoffTime: drawing.cutoffTime || "",
    timeZone: drawing.timeZone || "America/New_York",
    status: drawing.status || "scheduled",
    maxBet: drawing.maxBet || "",
    maxTotalHandle: drawing.maxTotalHandle || "",
    maxTotalLiability: drawing.maxTotalLiability || "",
  });

  document
    .getElementById("create-drawing-section")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function getStatusLabel(status: string) {
return (status || "active").toUpperCase();
}

function getGameCardClass(game: any) {
const status = game.status || "active";

if (status === "disabled" || status === "archived") {
return "rounded border p-4 cursor-pointer bg-gray-300 opacity-80";
}

return "rounded border p-4 cursor-pointer bg-white";
}

function getDrawingCardClass(drawing: any) {
const status = drawing.status || getDrawingStatus(drawing);

if (
status === "closed" ||
status === "settled" ||
status === "canceled" ||
status === "archived"
) {
return "rounded border p-4 cursor-pointer bg-gray-300 opacity-80";
}

return "rounded border p-4 cursor-pointer bg-white";
}
function drawingHasBets(drawing: any) {
return drawing.bets && drawing.bets.length > 0;
}

function canEditDrawing(drawing: any) {
return !drawingHasBets(drawing) &&
drawing.status !== "settled" &&
drawing.status !== "canceled" &&
drawing.status !== "archived";
}

function canDeleteDrawing(drawing: any) {
return !drawingHasBets(drawing) &&
drawing.status !== "settled" &&
drawing.status !== "canceled" &&
drawing.status !== "archived";
}

function canCancelDrawing(drawing: any) {
return drawing.status !== "settled" &&
drawing.status !== "canceled" &&
drawing.status !== "archived";
}

function canArchiveDrawing(drawing: any) {
return drawing.status !== "archived";
}
function clearAllLocalData() {
  const confirmed = confirm("Clear ALL local lottery data? This cannot be undone.");

  if (!confirmed) return;

  setGames([]);
  setDrawings([]);
  setPayTables([]);
  setWagerTypes([]);
  setWagerOptions([]);
  setPlayerAccounts([]);
  setLedgerTransactions([]);
  setTickets([]);
  setTicketLines([]);
  setExpandedTicketIds([]);
  setDraftTicketLines([]);
  setSettlementRuns([]);
  setSettlementRecords([]);
  setExpandedSettlementRunIds([]);
  setSettlementForm({
    drawingId: "",
    notes: "",
  });
  setTicketForm({
    accountId: "",
    marketId: "",
    gameId: "",
    drawingId: "",
    fundingType: "cash",
    notes: "",
  });
  setTicketLineForm({
    wagerTypeId: "",
    wagerOptionId: "",
    selectedNumbers: "",
    stake: "",
    potentialPayout: "",
  });
  setLedgerForm({
    accountId: "",
    category: "accounting",
    transactionType: "deposit",
    amount: "",
    description: "",
    referenceId: "",
    createdBy: "",
  });
  setExpandedDrawingIds([]);
  setEditingGameIndex(null);
  setEditingDrawingIndex(null);
  setEditingWagerOptionId(null);
  setEditingPlayerAccountId(null);

  alert("All local demo data cleared.");
}
function exportLocalDataJSON() {
  const backup = {
    games,
    drawings,
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "lottery-local-backup.json";
  link.click();

  URL.revokeObjectURL(url);
}

function generateDemoData() {
  const confirmed = confirm(
    "Generate demo games, drawings, and bets? This will replace current local data."
  );

  if (!confirmed) return;

  const demoGames = [
    {
      state: "FL",
      name: "Pick 3 Midday",
      status: "active",
      gameType: "pick_n",
      mainNumbersCount: "3",
      mainNumbersMin: "0",
      mainNumbersMax: "9",
      bonusNumbersCount: "",
      bonusNumbersMin: "",
      bonusNumbersMax: "",
      ticketPrice: "1.00",
      payoutMultiplier: "500",
      maxPayout: "5000",
      defaultMaxBet: "100",
      defaultMaxTotalHandle: "25000",
      defaultMaxTotalLiability: "50000",
      scheduleType: "recurring",
      recurringFrequency: "daily",
      defaultDrawTime: "13:30",
      defaultCutoffTime: "13:15",
      defaultTimeZone: "America/New_York",
    },
    {
      state: "NY",
      name: "Pick 4 Evening",
      status: "active",
      gameType: "pick_n",
      mainNumbersCount: "4",
      mainNumbersMin: "0",
      mainNumbersMax: "9",
      bonusNumbersCount: "",
      bonusNumbersMin: "",
      bonusNumbersMax: "",
      ticketPrice: "1.00",
      payoutMultiplier: "5000",
      maxPayout: "25000",
      defaultMaxBet: "50",
      defaultMaxTotalHandle: "40000",
      defaultMaxTotalLiability: "100000",
      scheduleType: "recurring",
      recurringFrequency: "daily",
      defaultDrawTime: "19:30",
      defaultCutoffTime: "19:15",
      defaultTimeZone: "America/New_York",
    },
    {
      state: "CA",
      name: "Daily Derby Demo",
      status: "archived",
      gameType: "pick_n",
      mainNumbersCount: "3",
      mainNumbersMin: "1",
      mainNumbersMax: "12",
      bonusNumbersCount: "1",
      bonusNumbersMin: "1",
      bonusNumbersMax: "12",
      ticketPrice: "2.00",
      payoutMultiplier: "1000",
      maxPayout: "10000",
      defaultMaxBet: "25",
      defaultMaxTotalHandle: "15000",
      defaultMaxTotalLiability: "30000",
      scheduleType: "one_time",
      recurringFrequency: "daily",
      defaultDrawTime: "18:00",
      defaultCutoffTime: "17:45",
      defaultTimeZone: "America/Los_Angeles",
    },
  ];

  const demoDrawings = [
    {
      id: "FL-PICK-3-MIDDAY-2026-05-16-DEMO",
      game: demoGames[0],
      drawDate: "2026-05-16",
      drawTime: "13:30",
      cutoffTime: "13:15",
      timeZone: "America/New_York",
      status: "scheduled",
      maxBet: "100",
      maxTotalHandle: "25000",
      maxTotalLiability: "50000",
      totalHandle: 0,
      totalPotentialPayout: 0,
      worstCaseLiability: 0,
      housePosition: 0,
      winningNumbers: "",
      winningBonus: "",
      resultSource: "",
      settledAt: "",
      actualPayout: 0,
      bets: [],
    },
    {
      id: "NY-PICK-4-EVENING-2026-05-15-DEMO",
      game: demoGames[1],
      drawDate: "2026-05-15",
      drawTime: "19:30",
      cutoffTime: "19:15",
      timeZone: "America/New_York",
      status: "closed",
      maxBet: "50",
      maxTotalHandle: "40000",
      maxTotalLiability: "100000",
      totalHandle: 30,
      totalPotentialPayout: 60000,
      worstCaseLiability: 50000,
      housePosition: -59970,
      winningNumbers: "",
      winningBonus: "",
      resultSource: "",
      settledAt: "",
      actualPayout: 0,
      bets: [
        {
          id: "BET-DEMO-1001",
          drawingId: "NY-PICK-4-EVENING-2026-05-15-DEMO",
          numbers: "1-2-3-4",
          betType: "straight",
          amount: 10,
          potentialPayout: 25000,
          placedAt: "2026-05-15T18:20:00.000Z",
          status: "accepted",
        },
        {
          id: "BET-DEMO-1002",
          drawingId: "NY-PICK-4-EVENING-2026-05-15-DEMO",
          numbers: "1-2-3-4",
          betType: "box",
          amount: 10,
          potentialPayout: 25000,
          placedAt: "2026-05-15T18:35:00.000Z",
          status: "accepted",
        },
        {
          id: "BET-DEMO-1003",
          drawingId: "NY-PICK-4-EVENING-2026-05-15-DEMO",
          numbers: "5-6-7-8",
          betType: "straight",
          amount: 10,
          potentialPayout: 10000,
          placedAt: "2026-05-15T18:50:00.000Z",
          status: "accepted",
        },
      ],
    },
    {
      id: "FL-PICK-3-MIDDAY-2026-05-14-DEMO",
      game: demoGames[0],
      drawDate: "2026-05-14",
      drawTime: "13:30",
      cutoffTime: "13:15",
      timeZone: "America/New_York",
      status: "settled",
      maxBet: "100",
      maxTotalHandle: "25000",
      maxTotalLiability: "50000",
      totalHandle: 25,
      totalPotentialPayout: 12500,
      worstCaseLiability: 10000,
      housePosition: -9975,
      winningNumbers: "4-5-6",
      winningBonus: "",
      resultSource: "Florida Lottery",
      settledAt: "2026-05-14T18:00:00.000Z",
      actualPayout: 10000,
      overrideReason: "Corrected result source after operator review.",
      reopenedAt: "2026-05-14T17:45:00.000Z",
      bets: [
        {
          id: "BET-DEMO-2001",
          drawingId: "FL-PICK-3-MIDDAY-2026-05-14-DEMO",
          numbers: "4-5-6",
          betType: "straight",
          amount: 20,
          potentialPayout: 10000,
          placedAt: "2026-05-14T16:30:00.000Z",
          status: "winner",
          settledAt: "2026-05-14T18:00:00.000Z",
        },
        {
          id: "BET-DEMO-2002",
          drawingId: "FL-PICK-3-MIDDAY-2026-05-14-DEMO",
          numbers: "1-2-3",
          betType: "straight",
          amount: 5,
          potentialPayout: 2500,
          placedAt: "2026-05-14T16:45:00.000Z",
          status: "loser",
          settledAt: "2026-05-14T18:00:00.000Z",
        },
      ],
    },
    {
      id: "CA-DAILY-DERBY-DEMO-2026-05-13-DEMO",
      game: demoGames[2],
      drawDate: "2026-05-13",
      drawTime: "18:00",
      cutoffTime: "17:45",
      timeZone: "America/Los_Angeles",
      status: "archived",
      maxBet: "25",
      maxTotalHandle: "15000",
      maxTotalLiability: "30000",
      totalHandle: 12,
      totalPotentialPayout: 6000,
      worstCaseLiability: 6000,
      housePosition: 12,
      winningNumbers: "",
      winningBonus: "",
      resultSource: "",
      settledAt: "",
      actualPayout: 0,
      bets: [
        {
          id: "BET-DEMO-3001",
          drawingId: "CA-DAILY-DERBY-DEMO-2026-05-13-DEMO",
          numbers: "2-4-6",
          betType: "straight",
          amount: 6,
          potentialPayout: 6000,
          placedAt: "2026-05-13T23:00:00.000Z",
          status: "accepted",
        },
        {
          id: "BET-DEMO-3002",
          drawingId: "CA-DAILY-DERBY-DEMO-2026-05-13-DEMO",
          numbers: "1-3-5",
          betType: "box",
          amount: 6,
          potentialPayout: 1000,
          placedAt: "2026-05-13T23:15:00.000Z",
          status: "accepted",
        },
      ],
    },
  ];

  setGames(demoGames);
  setDrawings(demoDrawings);
  setPayTables([]);
  setWagerTypes([]);
  setWagerOptions([]);
  setPlayerAccounts([]);
  setLedgerTransactions([]);
  setTickets([]);
  setTicketLines([]);
  setExpandedTicketIds([]);
  setDraftTicketLines([]);
  setSettlementRuns([]);
  setSettlementRecords([]);
  setExpandedSettlementRunIds([]);
  setSettlementForm({
    drawingId: "",
    notes: "",
  });
  setTicketForm({
    accountId: "",
    marketId: "",
    gameId: "",
    drawingId: "",
    fundingType: "cash",
    notes: "",
  });
  setTicketLineForm({
    wagerTypeId: "",
    wagerOptionId: "",
    selectedNumbers: "",
    stake: "",
    potentialPayout: "",
  });
  setLedgerForm({
    accountId: "",
    category: "accounting",
    transactionType: "deposit",
    amount: "",
    description: "",
    referenceId: "",
    createdBy: "",
  });
  setExpandedDrawingIds([]);
  setExpandedGameIds([]);
  setEditingGameIndex(null);
  setEditingDrawingIndex(null);
}

function importLocalDataJSON(event: React.ChangeEvent<HTMLInputElement>) {
  const file = event.target.files?.[0];

  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));

      if (!Array.isArray(parsed.games) || !Array.isArray(parsed.drawings)) {
        alert("Invalid backup file.");
        return;
      }

      setGames(parsed.games);
      setDrawings(parsed.drawings);
      alert("Local data restored.");
    } catch {
      alert("Invalid backup file.");
    }
  };

	  reader.readAsText(file);
	  event.target.value = "";
	}
	const ticketLookupRows = drawings.flatMap((drawing: any, drawingIndex: number) =>
	  (drawing.bets || []).map((bet: any, betIndex: number) => ({
	    drawing,
	    drawingIndex,
	    bet,
	    betIndex,
	  }))
	);
	const filteredTickets = ticketLookupRows
	  .filter((row: any) => {
	    const ticketId = String(row.bet.id || "").toLowerCase();
	    const numbers = String(row.bet.numbers || "").toLowerCase();
	    const betType = String(row.bet.betType || "");
	    const status = String(row.bet.status || "");

	    if (
	      ticketLookupDrawingId &&
	      String(row.drawing.id || "") !== ticketLookupDrawingId
	    ) {
	      return false;
	    }

	    if (
	      ticketLookupTicketId &&
	      !ticketId.includes(ticketLookupTicketId.trim().toLowerCase())
	    ) {
	      return false;
	    }

	    if (
	      ticketLookupNumbers &&
	      !numbers.includes(ticketLookupNumbers.trim().toLowerCase())
	    ) {
	      return false;
	    }

	    if (ticketLookupBetType !== "all" && betType !== ticketLookupBetType) {
	      return false;
	    }

	    if (ticketLookupStatus !== "all" && status !== ticketLookupStatus) {
	      return false;
	    }

	    return true;
	  })
	  .sort((a: any, b: any) => {
	    const aTime = Date.parse(a.bet.placedAt || "");
	    const bTime = Date.parse(b.bet.placedAt || "");

	    if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
	      return bTime - aTime;
	    }

	    if (a.drawingIndex !== b.drawingIndex) {
	      return b.drawingIndex - a.drawingIndex;
	    }

	    return b.betIndex - a.betIndex;
	  });
	const visibleTicketLookupRows = showAllTicketLookupResults
	  ? filteredTickets
	  : filteredTickets.slice(0, 50);
	return (

    <main className="min-h-screen bg-gray-100 p-8 text-gray-900">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-3xl font-bold">Lottery Admin Dashboard</h1>
        <p className="mb-6 text-sm text-gray-600" suppressHydrationWarning>
  Default app time zone: Eastern Time (
  {new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(currentTime)}
  )
</p>
<div className="mb-6 flex flex-wrap gap-2">
  {[
    { label: "Dashboard", value: "dashboard" },
    { label: "Games", value: "games" },
    { label: "Drawings", value: "drawings" },
    { label: "Reports", value: "reports" },
    { label: "Mock Betting", value: "mockBetting" },
    { label: "Wager Types", value: "wagerTypes" },
    { label: "Pay Tables", value: "payTables" },
    { label: "Keno Operations", value: "hotspotAdmin" },
    { label: "Markets", value: "markets" },
    { label: "Accounts", value: "accounts" },
    { label: "Tickets", value: "tickets" },
    { label: "Settlement", value: "settlement" },
    { label: "Financial Ledger", value: "financialLedger" },
    { label: "Admin Access", value: "adminAccess" },
    { label: "Utilities", value: "utilities" },
  ].map((tab) => (
    <button
      key={tab.value}
      onClick={() => setActiveTab(tab.value)}
      className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
        activeTab === tab.value
          ? "bg-blue-700 text-white"
          : "bg-white text-gray-700 hover:bg-gray-50"
      }`}
    >
      {tab.label}
    </button>
  ))}
</div>
{activeTab === "dashboard" && (
<>
<section className="mt-6 rounded-xl bg-white p-4 shadow">
  <h2 className="mb-4 text-xl font-semibold">Reporting Filters</h2>

	  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
    <label className="grid gap-1">
      <span className="text-sm font-medium">From Date</span>
      <input
        type="date"
        name="fromDate"
        value={reportFilters.fromDate}
        onChange={handleReportFilterChange}
	        className="w-full rounded border p-2 text-gray-900"
      />
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">To Date</span>
      <input
        type="date"
        name="toDate"
        value={reportFilters.toDate}
        onChange={handleReportFilterChange}
	        className="w-full rounded border p-2 text-gray-900"
      />
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">State</span>
      <select
        name="state"
        value={reportFilters.state}
        onChange={handleReportFilterChange}
	        className="w-full rounded border p-2 text-gray-900"
      >
        <option value="">All States</option>
        {states.map((state) => (
          <option key={state.code} value={state.code}>
            {state.name}
          </option>
        ))}
      </select>
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">Game</span>
      <select
        name="game"
        value={reportFilters.game}
        onChange={handleReportFilterChange}
	        className="w-full rounded border p-2 text-gray-900"
      >
        <option value="">All Games</option>
        {games.map((game: any, index: number) => (
          <option key={index} value={game.name}>
            {game.state} — {game.name}
          </option>
        ))}
      </select>
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">Status</span>
      <select
        name="status"
        value={reportFilters.status}
        onChange={handleReportFilterChange}
	        className="w-full rounded border p-2 text-gray-900"
      >
        <option value="">All Statuses</option>
        <option value="scheduled">Scheduled</option>
        <option value="open">Open</option>
        <option value="closed">Closed</option>
        <option value="settled">Settled</option>
      </select>
    </label>
  </div>
</section>
<section className="mt-6 grid gap-4 md:grid-cols-4">
  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Total Games</p>
    <p className="text-2xl font-bold">{metrics.totalGames}</p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Total Drawings</p>
    <p className="text-2xl font-bold">{metrics.totalDrawings}</p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Open Drawings</p>
    <p className="text-2xl font-bold text-green-600">
      {metrics.openDrawings}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Closed Drawings</p>
    <p className="text-2xl font-bold text-red-600">
      {metrics.closedDrawings}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Settled Drawings</p>
    <p className="text-2xl font-bold text-black">
      {metrics.settledDrawings}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Total Handle</p>
    <p className="text-2xl font-bold">
      {formatMoney(metrics.totalHandle)}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Potential Payout</p>
    <p className="text-2xl font-bold text-orange-600">
      {formatMoney(metrics.totalPotentialPayout)}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">House Result</p>
    <p
      className={`text-2xl font-bold ${
        metrics.houseResult >= 0
          ? "text-green-700"
          : "text-red-700"
      }`}
    >
      {formatMoney(metrics.houseResult)}
    </p>
  </div>
</section>
  </>
)}
{activeTab === "reports" && (
<>
<section className="mt-6 rounded-xl bg-white p-6 shadow">
  <div className="mb-4 flex items-center justify-between">
  <button
    onClick={() => setShowPrintableReport(!showPrintableReport)}
    className="text-left text-xl font-semibold"
  >
    {showPrintableReport ? "▼" : "▶"} Printable Report
  </button>
<div className="flex gap-2">
  <button
    onClick={printReport}
    className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
  >
    Print Report
  </button>

  <button
    onClick={exportReportToCSV}
    className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
  >
    Export CSV
  </button>
  <button
onClick={exportTicketAuditCSV}
className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"

>

Export Ticket Audit </button>
  <button
onClick={exportSettlementSummaryCSV}
className="rounded-md bg-purple-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-800"

>

Export Settlement Summary </button>
  <button
onClick={exportRiskExposureCSV}
className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-800"

>

Export Risk Exposure </button>
</div>
				  </div>

{showPrintableReport && (
<>
	  <div className="text-sm text-gray-700">
	    <p>
	      <span className="font-semibold">Report Period:</span>{" "}
      {reportFilters.fromDate || "Beginning"} to{" "}
      {reportFilters.toDate || "Today"}
    </p>

    <p>
      <span className="font-semibold">State:</span>{" "}
      {reportFilters.state || "All"}
    </p>

    <p>
      <span className="font-semibold">Game:</span>{" "}
      {reportFilters.game || "All"}
    </p>

    <p>
      <span className="font-semibold">Status:</span>{" "}
      {reportFilters.status || "All"}
    </p>
  </div>

  <div className="mt-4 grid gap-2 text-sm">
    <p>Total Games: {metrics.totalGames}</p>
    <p>Total Drawings: {metrics.totalDrawings}</p>
    <p>Open Drawings: {metrics.openDrawings}</p>
    <p>Closed Drawings: {metrics.closedDrawings}</p>
    <p>Settled Drawings: {metrics.settledDrawings}</p>
    <p>Total Handle: {formatMoney(metrics.totalHandle)}</p>
    <p>Potential Payout: {formatMoney(metrics.totalPotentialPayout)}</p>
	    <p>Actual Payout: {formatMoney(metrics.actualPayout)}</p>
	    <p>House Result: {formatMoney(metrics.houseResult)}</p>
	  </div>
</>
	)}
	</section>
	<section className="mt-6 rounded-xl bg-white p-6 shadow">
	  <h2 className="mb-4 text-xl font-semibold">Ticket Lookup</h2>
	  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
	    <label className="grid gap-1">
	      <span className="text-sm font-medium">Drawing</span>
	      <select
	        value={ticketLookupDrawingId}
	        onChange={(e) => setTicketLookupDrawingId(e.target.value)}
	        className="w-full rounded border p-2 text-gray-900"
	      >
	        <option value="">All Drawings</option>
	        {drawings.map((drawing: any, index: number) => (
	          <option key={drawing.id || index} value={drawing.id}>
	            {drawing.id}
	          </option>
	        ))}
	      </select>
	    </label>

	    <label className="grid gap-1">
	      <span className="text-sm font-medium">Ticket ID</span>
	      <input
	        value={ticketLookupTicketId}
	        onChange={(e) => setTicketLookupTicketId(e.target.value)}
	        placeholder="Search ticket ID"
	        className="w-full rounded border p-2 text-gray-900"
	      />
	    </label>

	    <label className="grid gap-1">
	      <span className="text-sm font-medium">Numbers</span>
	      <input
	        value={ticketLookupNumbers}
	        onChange={(e) => setTicketLookupNumbers(e.target.value)}
	        placeholder="Search numbers"
	        className="w-full rounded border p-2 text-gray-900"
	      />
	    </label>

	    <label className="grid gap-1">
	      <span className="text-sm font-medium">Bet Type</span>
	      <select
	        value={ticketLookupBetType}
	        onChange={(e) => setTicketLookupBetType(e.target.value)}
	        className="w-full rounded border p-2 text-gray-900"
	      >
	        <option value="all">All Types</option>
	        <option value="straight">Straight</option>
	        <option value="box">Box</option>
	        <option value="straight_box">Straight + Box</option>
	      </select>
	    </label>

	    <label className="grid gap-1">
	      <span className="text-sm font-medium">Status</span>
	      <select
	        value={ticketLookupStatus}
	        onChange={(e) => setTicketLookupStatus(e.target.value)}
	        className="w-full rounded border p-2 text-gray-900"
	      >
	        <option value="all">All Statuses</option>
	        <option value="accepted">Accepted</option>
	        <option value="winner">Winner</option>
	        <option value="loser">Loser</option>
	      </select>
	    </label>
	  </div>

	  <div className="mt-4 border-t pt-3">
	    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
	      <p className="text-sm font-semibold text-gray-700">
	        Matching Tickets: {filteredTickets.length}
	      </p>
	      {filteredTickets.length > 50 && (
	        <button
	          type="button"
	          onClick={() =>
	            setShowAllTicketLookupResults(!showAllTicketLookupResults)
	          }
	          className="rounded-md bg-gray-200 px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-300"
	        >
	          {showAllTicketLookupResults
	            ? "Collapse Results"
	            : "Show All Results"}
	        </button>
	      )}
	    </div>

	    <div className="space-y-1">
	      {visibleTicketLookupRows.map((row: any) => (
	        <div
	          key={`${row.drawing.id}-${row.bet.id}`}
	          className="text-xs text-gray-600"
	        >
	          #{row.bet.id} | {row.bet.playerId || "No Player"} |{" "}
	          {row.bet.numbers} | {row.bet.betType} |{" "}
	          {formatMoney(row.bet.amount)} →{" "}
	          {formatMoney(row.bet.potentialPayout)} | {row.bet.status}
	        </div>
	      ))}
	      {visibleTicketLookupRows.length === 0 && (
	        <p className="text-sm text-gray-500">No matching tickets found.</p>
	      )}
	    </div>
	  </div>
	</section>
	  </>
	)}
{activeTab === "games" && (
<>
<section className="mt-8 rounded-xl bg-white p-6 shadow">
  <button
    onClick={() => setShowCreateGame(!showCreateGame)}
    className="mb-4 flex w-full items-center justify-between text-left text-xl font-semibold text-gray-900"
  >
    <span>{showCreateGame ? "▼" : "▶"} Create Lottery Game</span>
  </button>

  {showCreateGame && (
    <form onSubmit={handleSubmit} className="grid gap-4">
  <div className="grid gap-4 md:grid-cols-2">
    {form.gameType !== "keno_style" && (
      <label className="grid gap-1">
        <span className="font-medium">State</span>
        <select
          name="state"
          value={form.state}
          onChange={handleChange}
          className="rounded border p-2 text-gray-900"
          required
        >
          <option value="">Select a state</option>
          {states.map((state) => (
            <option key={state.code} value={state.code}>
              {state.name}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-500">
          Choose the state this lottery game belongs to.
        </span>
      </label>
    )}

    <label className="grid gap-1">
      <span className="font-medium">Game Name</span>
      <input
        name="name"
        value={form.name}
        onChange={handleChange}
        placeholder="Example: Pick 4 Evening"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
        required
      />
      <span className="text-sm text-gray-500">
        Example: Pick 3 Midday, Pick 4 Evening, Fantasy 5.
      </span>
    </label>
  </div>

  <label className="grid gap-1">
    <span className="font-medium">Game Type</span>
    <select
      name="gameType"
      value={form.gameType}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    >
      <option value="numbers_lottery">Numbers Lottery</option>
      <option value="pick_n">Pick N</option>
      <option value="powerball_style">Powerball Style</option>
      <option value="keno_style">Keno Style</option>
    </select>
    <span className="text-sm text-gray-500">
      Pick N works for games like Pick 3, Pick 4, Pick 5.
    </span>
  </label>

  {form.gameType !== "keno_style" && (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="grid gap-1">
          <span className="font-medium">Main Numbers Count</span>
          <input
            name="mainNumbersCount"
            value={form.mainNumbersCount}
            onChange={handleChange}
            placeholder="Example: 4"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
            required
          />
          <span className="text-sm text-gray-500">How many numbers users pick.</span>
        </label>

        <label className="grid gap-1">
          <span className="font-medium">Main Min</span>
          <input
            name="mainNumbersMin"
            value={form.mainNumbersMin}
            onChange={handleChange}
            placeholder="Example: 0"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
            required
          />
          <span className="text-sm text-gray-500">Lowest allowed number.</span>
        </label>

        <label className="grid gap-1">
          <span className="font-medium">Main Max</span>
          <input
            name="mainNumbersMax"
            value={form.mainNumbersMax}
            onChange={handleChange}
            placeholder="Example: 9"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
            required
          />
          <span className="text-sm text-gray-500">Highest allowed number.</span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="grid gap-1">
          <span className="font-medium">Bonus Count</span>
          <input
            name="bonusNumbersCount"
            value={form.bonusNumbersCount}
            onChange={handleChange}
            placeholder="Example: 1"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          />
          <span className="text-sm text-gray-500">Leave blank if no bonus ball.</span>
        </label>

        <label className="grid gap-1">
          <span className="font-medium">Bonus Min</span>
          <input
            name="bonusNumbersMin"
            value={form.bonusNumbersMin}
            onChange={handleChange}
            placeholder="Example: 1"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          />
          <span className="text-sm text-gray-500">Lowest bonus number.</span>
        </label>

        <label className="grid gap-1">
          <span className="font-medium">Bonus Max</span>
          <input
            name="bonusNumbersMax"
            value={form.bonusNumbersMax}
            onChange={handleChange}
            placeholder="Example: 26"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          />
          <span className="text-sm text-gray-500">Highest bonus number.</span>
        </label>
      </div>
    </>
  )}

  {form.gameType === "keno_style" && (
    <div className="grid gap-4 rounded border bg-gray-50 p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="grid gap-1">
          <span className="font-medium">Number Range Min</span>
          <input
            name="numberRangeMin"
            value={form.numberRangeMin}
            onChange={handleChange}
            placeholder="Example: 1"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
            required
          />
          <span className="text-sm text-gray-500">Lowest number in the Keno pool.</span>
        </label>

        <label className="grid gap-1">
          <span className="font-medium">Number Range Max</span>
          <input
            name="numberRangeMax"
            value={form.numberRangeMax}
            onChange={handleChange}
            placeholder="Example: 80"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
            required
          />
          <span className="text-sm text-gray-500">Highest number in the Keno pool.</span>
        </label>

        <label className="grid gap-1">
          <span className="font-medium">Numbers Drawn Per Drawing</span>
          <input
            name="numbersDrawn"
            value={form.numbersDrawn}
            onChange={handleChange}
            placeholder="Example: 20"
            className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
            required
          />
          <span className="text-sm text-gray-500">How many numbers are drawn.</span>
        </label>
      </div>

      <label className="grid gap-1">
        <span className="font-medium">Available Spot Levels</span>
        <input
          name="availableSpots"
          value={
            Array.isArray(form.availableSpots)
              ? form.availableSpots.join(",")
              : form.availableSpots
          }
          onChange={handleChange}
          placeholder="Example: 1,2,3,4,5,6,7,8,9,10"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Comma-separated spot levels players may choose.
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          name="bullseyeEnabled"
          checked={Boolean(form.bullseyeEnabled)}
          onChange={handleChange}
          className="mt-1"
        />
        <span>
          <span className="block font-medium text-gray-900">Bullseye Available</span>
          Bullseye is one of the normal drawn numbers, not a bonus ball or extra
          number. Players may add a Bullseye wager, and that wager must equal the
          base wager amount.
        </span>
      </label>

      <div className="grid gap-4 border-t pt-4">
        <p className="text-sm text-gray-600">
          Keno games can generate drawings frequently, such as every 4 minutes,
          30 seconds, or 20 seconds. Each draw should receive a unique draw ID.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Draw Frequency Type</span>
            <select
              name="drawFrequencyType"
              value={form.drawFrequencyType}
              onChange={handleChange}
              className="h-10 w-full rounded border p-2 text-gray-900"
            >
              <option value="recurring">Recurring</option>
              <option value="manual">Manual</option>
            </select>
            <span className="min-h-10 text-sm text-gray-500">
              Recurring prepares this game for frequent draw generation.
            </span>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Draw Interval Seconds</span>
            <input
              name="drawIntervalSeconds"
              value={form.drawIntervalSeconds}
              onChange={handleChange}
              placeholder="Example: 240"
              className="h-10 w-full rounded border p-2 text-gray-900 placeholder:text-gray-400"
              required
            />
            <span className="min-h-10 text-sm text-gray-500">
              240 = every 4 minutes, 30 = every 30 seconds.
            </span>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Draw ID Prefix</span>
            <input
              name="drawIdPrefix"
              value={form.drawIdPrefix}
              onChange={handleChange}
              placeholder="Example: HS"
              className="h-10 w-full rounded border p-2 text-gray-900 placeholder:text-gray-400"
              required
            />
            <span className="min-h-10 text-sm text-gray-500">
              Used for future draw codes like HS-20260608-0001.
            </span>
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            name="autoGenerateDraws"
            checked={Boolean(form.autoGenerateDraws)}
            onChange={handleChange}
            className="mt-1"
          />
          <span>
            <span className="block font-medium text-gray-900">
              Auto Generate Draws
            </span>
            Prepares this game for automatic recurring draw creation.
          </span>
        </label>
      </div>
    </div>
  )}

  <label className="grid gap-1">
    <span className="font-medium">Ticket Price</span>

    <input
      name="ticketPrice"
      value={form.ticketPrice}
      onChange={handleChange}
      placeholder="Example: 1.00"
      className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
      required
    />
    <span className="text-sm text-gray-500">
      Price per ticket.
    </span>
    <div className="grid gap-4 md:grid-cols-2">
  {form.gameType !== "keno_style" && (
    <label className="grid gap-1">
      <span className="font-medium">Payout Multiplier</span>
      <input
        name="payoutMultiplier"
        value={form.payoutMultiplier}
        onChange={handleChange}
        placeholder="Example: 5000"
        className="rounded border p-2 text-gray-900"
        required
      />
      <span className="text-sm text-gray-500">
        Multiplier applied to winning bets.
      </span>
    </label>
  )}

  <label className="grid gap-1">
    <span className="font-medium">Max Payout</span>
    <input
      name="maxPayout"
      value={form.maxPayout}
      onChange={handleChange}
      placeholder="Example: 100000"
      className="rounded border p-2 text-gray-900"
      required
    />
    <span className="text-sm text-gray-500">
      Maximum allowed payout per bet.
    </span>
  </label>
  </div>
  <div className="grid gap-4 md:grid-cols-3">
  <label className="flex flex-col gap-1">
    <span className="font-medium">Default Max Bet</span>
    <input
      name="defaultMaxBet"
      value={form.defaultMaxBet}
      onChange={handleChange}
      placeholder="Example: 100"
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Default max bet inherited by generated drawings.
    </span>
  </label>

  <label className="flex flex-col gap-1">
    <span className="font-medium">Default Max Total Handle</span>
    <input
      name="defaultMaxTotalHandle"
      value={form.defaultMaxTotalHandle}
      onChange={handleChange}
      placeholder="Example: 25000"
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Default handle cap inherited by generated drawings.
    </span>
  </label>

  <label className="flex flex-col gap-1">
    <span className="font-medium">Default Max Total Liability</span>
    <input
      name="defaultMaxTotalLiability"
      value={form.defaultMaxTotalLiability}
      onChange={handleChange}
      placeholder="Example: 100000"
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Default liability cap inherited by generated drawings.
    </span>
  </label>
</div>
  </label>
  {form.gameType !== "keno_style" && (
    <>
      <div className="grid gap-4 md:grid-cols-2">
      <label className="grid gap-1">
        <span className="font-medium">Schedule Type</span>
        <select
          name="scheduleType"
          value={form.scheduleType}
          onChange={handleChange}
          className="rounded border p-2 text-gray-900"
        >
          <option value="one_time">One-Time / Manual Drawings</option>
          <option value="recurring">Recurring Drawings</option>
        </select>
        <span className="text-sm text-gray-500">
          Recurring games can generate daily drawing instances automatically.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Recurring Frequency</span>
        <select
          name="recurringFrequency"
          value={form.recurringFrequency}
          onChange={handleChange}
          className="rounded border p-2 text-gray-900"
          disabled={form.scheduleType !== "recurring"}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="custom">Custom</option>
        </select>
        <span className="text-sm text-gray-500">
          Used only when schedule type is recurring.
        </span>
      </label>
    </div>

    <div className="grid gap-4 md:grid-cols-3">
      <label className="grid gap-1">
        <span className="font-medium">Default Draw Time</span>
        <input
          type="time"
          name="defaultDrawTime"
          value={form.defaultDrawTime}
          onChange={handleChange}
          className="rounded border p-2 text-gray-900"
        />
        <span className="text-sm text-gray-500">
          Standard draw time for recurring drawings.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Default Cutoff Time</span>
        <input
          type="time"
          name="defaultCutoffTime"
          value={form.defaultCutoffTime}
          onChange={handleChange}
          className="rounded border p-2 text-gray-900"
        />
        <span className="text-sm text-gray-500">
          Standard last-call time for accepting wagers.
        </span>
      </label>
    </div>
    </>
  )}

  <label className="grid gap-1">
    <span className="font-medium">Default Time Zone</span>
    <select
      name="defaultTimeZone"
      value={form.defaultTimeZone}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    >
      <option value="America/New_York">Eastern (ET)</option>
      <option value="America/Chicago">Central (CT)</option>
      <option value="America/Denver">Mountain (MT)</option>
      <option value="America/Los_Angeles">Pacific (PT)</option>
      <option value="America/Anchorage">Alaska (AKT)</option>
      <option value="Pacific/Honolulu">Hawaii (HST)</option>
    </select>
  <span className="text-sm text-gray-500">
    Default timezone inherited by generated drawings.
  </span>
</label>

        <button className="rounded bg-blue-600 px-4 py-2 font-semibold text-white">
        {editingGameIndex !== null ? "Update Game" : "Save Game"}
      </button>
    </form>
  )}
</section>


        <section className="mt-8 rounded-xl bg-white p-6 shadow">
  <h2 className="mb-4 text-xl font-semibold">Created Games</h2>

  <div className="mb-4 grid gap-3 rounded border bg-gray-50 p-4">
    <label className="grid gap-1">
      <span className="font-medium">Game to Generate Drawings For</span>
      <select
        value={selectedGameIndex}
        onChange={(e) => setSelectedGameIndex(e.target.value)}
        className="rounded border p-2 text-gray-900"
      >
        <option value="">All Recurring Games</option>
        {games.map((game: any, index: number) =>
          (game.status || "").toLowerCase() === "active" &&
          game.scheduleType === "recurring" ? (
          <option key={index} value={index}>
            {game.state} — {game.name}{" "}({getStatusLabel(game.status || "active")})

          </option>
        ) : null)}
      </select>
      <span className="text-sm text-gray-500">
        Choose one game, or leave as all recurring games.
      </span>
    </label>

    <div className="flex gap-2">
      <button
        onClick={generateTodayDrawings}
        className="rounded bg-purple-600 px-4 py-2 font-semibold text-white transition hover:bg-purple-700 active:scale-95 active:bg-purple-800"
      >
        Generate Today
      </button>

      <button
        onClick={generateNext7Days}
        className="rounded bg-indigo-600 px-4 py-2 font-semibold text-white transition hover:bg-indigo-700 active:scale-95 active:bg-indigo-800"
      >
        Generate Next 7 Days
      </button>
    </div>
  </div>

	  {games.length === 0 ? (
	    <p className="text-gray-500">No games created yet.</p>
	  ) : (
	    <>
	      <label className="mb-3 flex items-center gap-2 text-sm text-gray-700">
	        <input
	          type="checkbox"
	          checked={showInactiveGames}
	          onChange={(e) => setShowInactiveGames(e.target.checked)}
	        />
	        Show inactive games
	      </label>

	    <div className="space-y-3">
	      {games.map((game: any, index: number) => {
	        if (
	          !showInactiveGames &&
	          (game.status === "disabled" || game.status === "archived")
	        ) {
	          return null;
	        }

	        return (
	        <div
  key={index}
  className={getGameCardClass(game)}
  onClick={() => toggleGameDetails(index)}
>
          <p className="font-semibold">
  {expandedGameIds.includes(index) ? "▼" : "▶"}{" "}
  {game.state} — {game.name}{" "}
  <span className="text-xs font-bold text-gray-700">
    ({getStatusLabel(game.status || "active")})
  </span>
</p>
          <p className="text-sm text-gray-600">
  {game.gameType === "keno_style"
    ? `Keno | Draw ${game.numbersDrawn || game.drawCount || 20} from ${
        game.numberRangeMin || game.numberPoolMin || 1
      }–${game.numberRangeMax || game.numberPoolMax || 80}`
    : `${game.gameType} | Pick ${game.mainNumbersCount} from ${game.mainNumbersMin}–${game.mainNumbersMax}${
        game.bonusNumbersCount
          ? ` and Bonus ${game.bonusNumbersCount} from ${game.bonusNumbersMin}–${game.bonusNumbersMax}`
          : ""
      }`}
  {" "} | Ticket: {formatMoney(game.ticketPrice)}
</p>
          {(game.requiresPaytable || game.gameType === "keno_style") && (
            <p className="mt-1 text-sm font-semibold text-gray-700">
              Pay Table Status:{" "}
              {getActivePayTableForGame(game, index)
                ? "Active Pay Table Assigned"
                : "⚠ No Active Pay Table"}
            </p>
          )}
          {expandedGameIds.includes(index) && (
  <div className="mt-3 border-t pt-3 text-sm text-gray-700 space-y-1">
    <p>
  <span className="font-semibold">Status:</span>{" "}
  {getStatusLabel(game.status || "active")}
</p>
    <p>

      <span className="font-semibold">Payout Multiplier:</span>{" "}
      {game.payoutMultiplier}
    </p>

    {game.gameType === "keno_style" ? (
      <>
        <p>
          <span className="font-semibold">Number Range:</span>{" "}
          {game.numberRangeMin || game.numberPoolMin || 1}–
          {game.numberRangeMax || game.numberPoolMax || 80}
        </p>
        <p>
          <span className="font-semibold">Numbers Drawn:</span>{" "}
          {game.numbersDrawn || game.drawCount || 20}
        </p>
        <p>
          <span className="font-semibold">Available Spots:</span>{" "}
          {Array.isArray(game.availableSpots)
            ? game.availableSpots.join(", ")
            : game.availableSpots ||
              (Array.isArray(game.allowedSpotCounts)
                ? game.allowedSpotCounts.join(", ")
                : "1, 2, 3, 4, 5, 6, 7, 8, 9, 10")}
        </p>
        <p>
          <span className="font-semibold">Bullseye Available:</span>{" "}
          {game.bullseyeEnabled ? "Yes" : "No"}
        </p>
        <p>
          <span className="font-semibold">Draw Schedule:</span>{" "}
          Every {game.drawIntervalSeconds || 240} seconds
        </p>
        <p>
          <span className="font-semibold">Draw ID Prefix:</span>{" "}
          {game.drawIdPrefix || "HS"}
        </p>
        <p>
          <span className="font-semibold">Auto Generate:</span>{" "}
          {game.autoGenerateDraws ? "Yes" : "No"}
        </p>
      </>
    ) : (
      <>
        <p>
      <span className="font-semibold">Bonus Count:</span>{" "}
      {game.bonusNumbersCount || "None"}
    </p>

    {game.bonusNumbersCount && (
      <p>
        <span className="font-semibold">Bonus Range:</span>{" "}
        {game.bonusNumbersMin}–{game.bonusNumbersMax}
      </p>
    )}
      </>
    )}

    <p>
      <span className="font-semibold">Max Payout:</span>{" "}
      {formatMoney(game.maxPayout)}
    </p>

    <p>
      <span className="font-semibold">Default Max Bet:</span>{" "}
      {formatMoney(game.defaultMaxBet)}
    </p>

    <p>
      <span className="font-semibold">Default Max Handle:</span>{" "}
      {formatMoney(game.defaultMaxTotalHandle)}
    </p>

    <p>
      <span className="font-semibold">Default Max Liability:</span>{" "}
      {formatMoney(game.defaultMaxTotalLiability)}
    </p>

    {game.gameType !== "keno_style" && (
      <>
        <p>
          <span className="font-semibold">Schedule Type:</span>{" "}
          {game.scheduleType}
        </p>

        <p>
          <span className="font-semibold">Recurring Frequency:</span>{" "}
          {game.recurringFrequency}
        </p>

        <p>
          <span className="font-semibold">Default Draw Time:</span>{" "}
          {game.defaultDrawTime || "N/A"}
        </p>

        <p>
          <span className="font-semibold">Default Cutoff Time:</span>{" "}
          {game.defaultCutoffTime || "N/A"}
        </p>
      </>
    )}

    <p>
      <span className="font-semibold">Time Zone:</span>{" "}
      {game.defaultTimeZone}
    </p>
    <div className="mt-4 flex gap-2">
<button
  onClick={(e) => {
    e.stopPropagation();
    editGame(index);
  }}
  className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700"
>
  Edit
</button>
  <button
    onClick={(e) => {
      e.stopPropagation();
      disableGame(index);
    }}

  className="rounded bg-yellow-500 px-3 py-1 text-sm font-semibold text-white hover:bg-yellow-600"

>
    Disable
  </button>

  <button
    onClick={(e) => {
      e.stopPropagation();
      archiveGame(index);
    }}
    className="rounded bg-gray-600 px-3 py-1 text-sm font-semibold text-white hover:bg-gray-700"
  >
    Archive
  </button>

  <button
    onClick={(e) => {
      e.stopPropagation();
      deleteGame(index);
    }}
    className="rounded bg-red-600 px-3 py-1 text-sm font-semibold text-white hover:bg-red-700"
  >
    Delete
  </button>
  {game.status === "archived" && (
    <button
      onClick={(e) => {
        e.stopPropagation();
        restoreGame(index);
      }}
      className="rounded bg-green-600 px-3 py-1 text-sm font-semibold text-white hover:bg-green-700"
    >
      Restore
    </button>
  )}
</div>
  </div>
)}
	        </div>
	      );
	      })}
	    </div>
	    </>
		  )}
	</section>
  </>
)}
{activeTab === "drawings" && (
<>

	        <section
          id="create-drawing-section"
          className="mt-8 rounded-xl bg-white p-6 shadow"
        >
          <button
  onClick={() => setShowCreateDrawing(!showCreateDrawing)}
  className="mb-4 flex w-full items-center justify-between text-left text-xl font-semibold"
>
  <span> {showCreateDrawing ? "▼" : "▶"} Create Drawing</span>
</button>


          {showCreateDrawing && (
  <>
    {games.length === 0 ? (
  <p className="text-gray-500">
    Create a lottery game first before adding drawings.
  </p>
) : (
  <form onSubmit={handleDrawingSubmit} className="grid gap-4">
    <label className="grid gap-1">
  <span className="font-medium">Time Zone</span>
  <select
    name="timeZone"
    value={drawingForm.timeZone}
    onChange={handleDrawingChange}
    className="rounded border p-2 text-gray-900"
  >
    <option value="America/New_York">Eastern (ET)</option>
    <option value="America/Chicago">Central (CT)</option>
    <option value="America/Denver">Mountain (MT)</option>
    <option value="America/Los_Angeles">Pacific (PT)</option>
    <option value="America/Anchorage">Alaska (AKT)</option>
    <option value="Pacific/Honolulu">Hawaii (HST)</option>
  </select>
  <span className="text-sm text-gray-500">
    Default is Eastern Time for U.S. lottery drawings.
  </span>
</label>
    <label className="grid gap-1">
      <span className="font-medium">Lottery Game</span>
      <select
        name="gameIndex"
        value={drawingForm.gameIndex}
        onChange={handleDrawingChange}
        className="rounded border p-2 text-gray-900"
        required
      >
        <option value="">Select a game</option>
        {games.map((game, index) =>
          (game.status || "").toLowerCase() === "active" ? (
          <option key={index} value={index}>
            {game.state} — {game.name}
          </option>
        ) : null)}
      </select>
      <span className="text-sm text-gray-500">
        Choose which configured lottery game this drawing belongs to.
      </span>
    </label>

    {games[Number(drawingForm.gameIndex)]?.gameType === "keno_style" &&
      games[Number(drawingForm.gameIndex)]?.autoGenerateDraws && (
        <p className="rounded border bg-yellow-50 p-3 text-sm font-medium text-yellow-800">
          This Keno game is configured for recurring draw generation. Manual
          drawing creation is optional/admin-only.
        </p>
      )}

    <div className="grid gap-4 md:grid-cols-3">
      <label className="grid gap-1">
        <span className="font-medium">Draw Date</span>
        <input
          type="date"
          name="drawDate"
          value={drawingForm.drawDate}
          onChange={handleDrawingChange}
          className="rounded border p-2 text-gray-900"
          required
        />
        <span className="text-sm text-gray-500">
          Date the drawing will take place.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Draw Time</span>
        <input
          type="time"
          name="drawTime"
          value={drawingForm.drawTime}
          onChange={handleDrawingChange}
          className="rounded border p-2 text-gray-900"
          required
        />
        <span className="text-sm text-gray-500">
          Official drawing time.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Cutoff Time</span>
        <input
          type="time"
          name="cutoffTime"
          value={drawingForm.cutoffTime}
          onChange={handleDrawingChange}
          className="rounded border p-2 text-gray-900"
          required
        />
        <span className="text-sm text-gray-500">
          Last time users can place wagers.
        </span>
      </label>
    </div>
<label className="grid gap-1">
  <span className="font-medium">Drawing Status</span>
  <select
    name="status"
    value={drawingForm.status}
    onChange={handleDrawingChange}
    className="rounded border p-2 text-gray-900"
  >
    <option value="scheduled">Scheduled</option>
    <option value="open">Open</option>
    <option value="closed">Closed</option>
    <option value="resulted">Resulted</option>
    <option value="settled">Settled</option>
  </select>
  <span className="text-sm text-gray-500">
    Controls where the drawing is in its lifecycle.
  </span>
</label>
    <div className="grid gap-4 md:grid-cols-3">
      <label className="grid gap-1">
        <span className="font-medium">Max Bet</span>
        <input
          name="maxBet"
          value={drawingForm.maxBet}
          onChange={handleDrawingChange}
          placeholder="Example: 100"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Maximum wager allowed per ticket.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Max Total Handle</span>
        <input
          name="maxTotalHandle"
          value={drawingForm.maxTotalHandle}
          onChange={handleDrawingChange}
          placeholder="Example: 25000"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Maximum total wagers accepted for this drawing.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Max Total Liability</span>
        <input
          name="maxTotalLiability"
          value={drawingForm.maxTotalLiability}
          onChange={handleDrawingChange}
          placeholder="Example: 100000"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Maximum possible payout exposure for this drawing.
        </span>
      </label>
    </div>

        <button className="rounded bg-green-600 px-4 py-2 font-semibold text-white">
      {editingDrawingIndex !== null ? "Update Drawing" : "Save Drawing"}
    </button>
    </form>
  )}
	</>
		  )}
		</section>

		        <section className="mt-8 rounded-xl bg-white p-6 shadow">
  <h2 className="mb-4 text-xl font-semibold">Created Drawings</h2>

	  {drawings.length === 0 ? (
	    <p className="text-gray-500">No drawings created yet.</p>
	  ) : (
	    <>
	      <label className="mb-3 flex items-center gap-2 text-sm text-gray-700">
	        <input
	          type="checkbox"
	          checked={showInactiveDrawings}
	          onChange={(e) => setShowInactiveDrawings(e.target.checked)}
	        />
	        Show inactive drawings
	      </label>

	    <div className="space-y-3">
	      {drawings.map((drawing: any, index: number) => {
	        if (
	          !showInactiveDrawings &&
	          (drawing.status === "canceled" ||
	            drawing.status === "archived" ||
	            drawing.status === "settled")
	        ) {
	          return null;
	        }

	        const drawDateTime = new Date(`${drawing.drawDate}T${drawing.drawTime}`);
	        const cutoffDateTime = new Date(`${drawing.drawDate}T${drawing.cutoffTime}`);

        const drawingTime = new Intl.DateTimeFormat("en-US", {
          timeZone:
  drawing.timeZone &&
  drawing.timeZone !== "DEFAULT_TIME_ZONE"
    ? drawing.timeZone
    : "America/New_York",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(drawDateTime);

        const cutoffTime = new Intl.DateTimeFormat("en-US", {
          timeZone:
  drawing.timeZone &&
  drawing.timeZone !== "DEFAULT_TIME_ZONE"
    ? drawing.timeZone
    : "America/New_York",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(cutoffDateTime);

	        const userLocalDrawTime = new Intl.DateTimeFormat("en-US", {
	          dateStyle: "medium",
	          timeStyle: "short",
	        }).format(drawDateTime);

	        const allBets = drawing.bets || [];
	        const drawingId = String(drawing.id || "");
	        const isBetListExpanded = expandedBetLists.includes(drawingId);
	        const betSearchTerm = betSearchTerms[drawingId] || "";
	        const betStatusFilter = betStatusFilters[drawingId] || "";
	        const betTypeFilter = betTypeFilters[drawingId] || "";
	        const normalizedBetSearchTerm = betSearchTerm.trim().toLowerCase();
	        const hasActiveBetFilters =
	          Boolean(normalizedBetSearchTerm) ||
	          Boolean(betStatusFilter) ||
	          Boolean(betTypeFilter);
	        const sortedBets = allBets
	          .map((bet: any, betIndex: number) => ({ bet, betIndex }))
	          .sort((a: any, b: any) => {
	            const aTime = Date.parse(a.bet.placedAt || "");
	            const bTime = Date.parse(b.bet.placedAt || "");

	            if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
	              return bTime - aTime;
	            }

	            return b.betIndex - a.betIndex;
	          })
	          .map((item: any) => item.bet);
	        const filteredBets = sortedBets.filter((bet: any) => {
	          const matchesSearch = normalizedBetSearchTerm
	            ? [
	                bet.id,
	                bet.numbers,
	                bet.betType,
	                bet.status,
	              ]
	                .map((value) => String(value || "").toLowerCase())
	                .some((value) => value.includes(normalizedBetSearchTerm))
	            : true;
	          const matchesStatus = betStatusFilter
	            ? bet.status === betStatusFilter
	            : true;
	          const matchesType = betTypeFilter
	            ? bet.betType === betTypeFilter
	            : true;

	          return matchesSearch && matchesStatus && matchesType;
	        });
	        const visibleBets = hasActiveBetFilters
	          ? filteredBets
	          : isBetListExpanded
	            ? filteredBets
	            : filteredBets.slice(0, MAX_VISIBLE_BETS);

	        return (
          <div
            key={drawing.id || index}
            className={getDrawingCardClass(drawing)}
            onClick={() => toggleDrawingDetails(drawing.id)}
          >
            <p className="font-semibold">
              {expandedDrawingIds.includes(drawing.id) ? "▼" : "▶"}{" "}
              {drawing.game.state} — {drawing.game.name}
            </p>

            <p className="text-xs text-gray-500">ID: {drawing.id}</p>

            <p className="text-sm text-gray-600">
              Draw: {drawingTime} (
              {drawing.timeZone.replace("America/", "").replace("_", " ")}) |
              Cutoff: {cutoffTime} |Status:{" "}
<span className="font-bold text-black">
  {getStatusLabel(drawing.status === "settled" ? "settled" : getDrawingStatus(drawing))}
</span>
              <br />
              Your local draw time: {userLocalDrawTime}
            </p>

            <p className="text-sm text-gray-600">
              Max bet: {formatMoney(drawing.maxBet)} | Max handle:{" "}
              {formatMoney(drawing.maxTotalHandle)} | Max liability:{" "}
              {formatMoney(drawing.maxTotalLiability)}
            </p>

            <p className="text-sm font-medium text-blue-700">
              Handle: {formatMoney(drawing.totalHandle)} | Potential Payout:{" "}
              {formatMoney(drawing.totalPotentialPayout)}
            </p>

            <p className="text-sm text-red-600">
              Worst Case Liability: {formatMoney(drawing.worstCaseLiability)}
            </p>

            <p className="text-sm text-green-700">
              House Position: {formatMoney(drawing.housePosition)}
            </p>

            {expandedDrawingIds.includes(drawing.id) && (
              <>
                {drawing.bets && drawing.bets.length > 0 && (
                  <>
	                    <div className="mt-3 border-t pt-2">
	                      <p className="text-sm font-semibold text-gray-700">
	                        Bets:
	                      </p>
		                      <p className="text-xs text-gray-500">
		                        Total Bets: {allBets.length}
		                      </p>
			                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
			                        <input
			                          value={betSearchTerm}
			                          onClick={(e) => e.stopPropagation()}
			                          onChange={(e) =>
			                            updateBetSearchTerm(drawingId, e.target.value)
			                          }
			                          placeholder="Search bets by ID, numbers, type, or status"
			                          className="w-full rounded border p-2 text-xs text-gray-900"
			                        />
			                        <select
			                          value={betStatusFilter}
			                          onClick={(e) => e.stopPropagation()}
			                          onChange={(e) =>
			                            updateBetStatusFilter(drawingId, e.target.value)
			                          }
			                          className="w-full rounded border p-2 text-xs text-gray-900"
			                        >
			                          <option value="">All Statuses</option>
			                          <option value="accepted">Accepted</option>
			                          <option value="winner">Winner</option>
			                          <option value="loser">Loser</option>
			                        </select>
			                        <select
			                          value={betTypeFilter}
			                          onClick={(e) => e.stopPropagation()}
			                          onChange={(e) =>
			                            updateBetTypeFilter(drawingId, e.target.value)
			                          }
			                          className="w-full rounded border p-2 text-xs text-gray-900"
			                        >
			                          <option value="">All Types</option>
			                          <option value="straight">Straight</option>
			                          <option value="box">Box</option>
			                          <option value="straight_box">Straight + Box</option>
			                        </select>
			                      </div>
			                      {hasActiveBetFilters && (
			                        <p className="mt-1 text-xs text-gray-500">
			                          Showing {visibleBets.length} matching bets
			                        </p>
			                      )}
			                      {!hasActiveBetFilters &&
			                        allBets.length > MAX_VISIBLE_BETS && (
		                        <button
		                          type="button"
		                          onClick={(e) => {
	                            e.stopPropagation();
	                            toggleExpandedBetList(drawingId);
	                          }}
	                          className="mt-1 rounded-md bg-gray-200 px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-300"
		                        >
		                          {isBetListExpanded ? "Collapse Bets" : "Show All Bets"}
		                        </button>
		                      )}

			                      {visibleBets.map((bet: any) => {
	                        const betId = String(bet.id || "");
	                        const betType = String(bet.betType || "");
	                        const isExpanded = expandedBetIds.includes(betId);
	                        const isBoxBet = betType.includes("box");
	                        const boxWays = isBoxBet ? getBoxWayCount(bet.numbers) : 0;
	                        const amountPerCombination =
	                          isBoxBet && boxWays > 0
	                            ? Number(bet.amount || 0) / boxWays
	                            : null;

	                        return (
	                          <div
	                            key={bet.id}
	                            className="text-xs text-gray-600"
	                            onClick={(e) => {
	                              e.stopPropagation();
	                              toggleBetDetails(betId);
	                            }}
	                          >
		                            <div className="cursor-pointer">
		                              {isExpanded ? "▼" : "▶"} #{bet.id} |{" "}
		                              {bet.playerId || "No Player"} | {bet.numbers} | {bet.betType} |{" "}
		                              {formatMoney(bet.amount)} →{" "}
		                              {formatMoney(bet.potentialPayout)} | {bet.status}
		                            </div>
		                            {isExpanded && (
		                              <div className="mt-1 space-y-0.5 pl-4 text-gray-700">
		                                <p>Bet ID: {bet.id}</p>
		                                <p>Player ID: {bet.playerId || ""}</p>
		                                <p>Player Name: {bet.playerName || ""}</p>
		                                <p>Agent ID: {bet.agentId || ""}</p>
		                                <p>Numbers: {bet.numbers}</p>
	                                <p>Bet Type: {bet.betType}</p>
	                                <p>Amount: {formatMoney(bet.amount)}</p>
	                                <p>
	                                  Potential Payout:{" "}
	                                  {formatMoney(bet.potentialPayout)}
	                                </p>
	                                <p>Status: {bet.status}</p>
	                                {isBoxBet && <p>Box Ways: {boxWays}</p>}
	                                {isBoxBet && bet.boxStakeMode && (
	                                  <p className="uppercase">
	                                    Box Stake Mode: {bet.boxStakeMode}
	                                  </p>
	                                )}
	                                {amountPerCombination !== null && (
	                                  <p>
	                                    Amount Per Combination:{" "}
	                                    {formatMoney(amountPerCombination)}
	                                  </p>
	                                )}
	                                <p>Placed At: {bet.placedAt}</p>
	                                {bet.settledAt && (
	                                  <p>Settled At: {bet.settledAt}</p>
	                                )}
	                              </div>
	                            )}
	                          </div>
	                        );
	                      })}
                    </div>

                    <div
  className="mt-3 border-t pt-2"
  onClick={(e) => e.stopPropagation()}
>
                      <p className="text-sm font-semibold text-red-700">
                        Exposure by Number Combination:
                      </p>

                      {getExposureByNumbers(drawing).map((item) => (
                        <div key={item.numbers} className="text-xs text-gray-700">
                          {item.numbers} → {formatMoney(item.payout)}
                        </div>


))}
</div>

<div
  className="mt-3 border-t pt-2"
  onClick={(e) => e.stopPropagation()}
>
  <p className="text-sm font-semibold text-gray-700">
    Enter Result:
  </p>

  <input
    placeholder="Winning numbers, example: 1-2-3-4"
    value={drawing.winningNumbers || ""}
    disabled={drawing.status === "settled"}
    onChange={(e) =>
      updateDrawingResult(index, "winningNumbers", e.target.value)
    }
    className={`mt-2 w-full rounded border p-2 ${
  drawing.status === "settled"
    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
    : "text-gray-900"
}`}
  />

  <input
    placeholder="Bonus number, if any"
    value={drawing.winningBonus || ""}
    disabled={drawing.status === "settled"}
    onChange={(e) =>
      updateDrawingResult(index, "winningBonus", e.target.value)
    }
    className={`mt-2 w-full rounded border p-2 ${
  drawing.status === "settled"
    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
    : "text-gray-900"
}`}
  />

  <input
    placeholder="Result source, example: Florida Lottery"
    value={drawing.resultSource || ""}
    disabled={drawing.status === "settled"}
    onChange={(e) =>
      updateDrawingResult(index, "resultSource", e.target.value)
    }
    className={`mt-2 w-full rounded border p-2 ${
  drawing.status === "settled"
    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
    : "text-gray-900"
}`}
  />
  <button
  onClick={(e) => {
    e.stopPropagation();
    settleDrawing(index);
  }}
  className="mt-3 rounded bg-green-600 px-4 py-2 font-semibold text-white hover:bg-green-700"
>
  Settle Drawing
</button>
</div>
{drawing.status === "settled" && drawing.bets && drawing.bets.length > 0 && (
  <div className="mt-4 border-t pt-3">
    <p className="text-lg font-bold text-black">Ticket Results</p>

    {drawing.bets.map((bet: any) => (
      <div
        key={bet.id}
        className="mt-2 rounded border p-2 text-sm text-gray-800"
      >

        <p className="font-semibold">
          #{bet.id} — {bet.status === "winner" ? "WINNER" : "LOSER"}
        </p>
        <p>Numbers: {bet.numbers}</p>
        <p>Bet Type: {bet.betType}</p>
        <p>Amount: {formatMoney(bet.amount)}</p>
        <p>Potential Payout: {formatMoney(bet.potentialPayout)}</p>
      </div>

    ))}
    {drawing.overrideReason && (
  <div className="mt-4 rounded border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-900">
    <p className="font-bold">Override / Reopen Audit</p>
    <p>Reason: {drawing.overrideReason}</p>
    <p>
      Reopened At:{" "}
      {drawing.reopenedAt
        ? new Date(drawing.reopenedAt).toLocaleString()
        : "N/A"}
    </p>
  </div>
)}
    {drawing.status === "settled" && (
  <div className="mt-4 border-t pt-3">
    <p className="text-sm font-semibold text-gray-700">
      Reopen / Override
    </p>

    <input
      placeholder="Override reason required"
      value={overrideReason}
      onChange={(e) => setOverrideReason(e.target.value)}
      className="mt-2 w-full rounded border p-2 text-gray-900"
      onClick={(e) => e.stopPropagation()}
    />

    <button
      onClick={(e) => {
        e.stopPropagation();
        reopenDrawing(index);
      }}
      className="mt-3 rounded bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800"
    >
      Reopen Drawing
    </button>
  </div>
)}
	  </div>
)}
	                  </>
	                )}
		                <div className="mt-4 flex gap-2 border-t pt-3">
		                  <button
		                    disabled={!canEditDrawing(drawing)}
		                    onClick={(e) => {
		                      e.stopPropagation();
		                      if (!canEditDrawing(drawing)) return;
		                      editDrawing(index);
		                    }}
		                    className={
		                      canEditDrawing(drawing)
		                        ? "rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
		                        : "rounded-md bg-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-500 cursor-not-allowed"
		                    }
		                  >
		                    Edit Drawing
		                  </button>

		                  <button
		                    disabled={!canCancelDrawing(drawing)}
		                    onClick={(e) => {
		                      e.stopPropagation();
		                      if (!canCancelDrawing(drawing)) return;
		                      cancelDrawing(index);
		                    }}
		                    className={
		                      canCancelDrawing(drawing)
		                        ? "rounded-md bg-yellow-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-yellow-700"
		                        : "rounded-md bg-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-500 cursor-not-allowed"
		                    }
		                  >
		                    Cancel Drawing
		                  </button>

		                  <button
		                    disabled={!canArchiveDrawing(drawing)}
		                    onClick={(e) => {
		                      e.stopPropagation();
		                      if (!canArchiveDrawing(drawing)) return;
		                      archiveDrawing(index);
		                    }}
		                    className={
		                      canArchiveDrawing(drawing)
		                        ? "rounded-md bg-gray-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-800"
		                        : "rounded-md bg-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-500 cursor-not-allowed"
		                    }
		                  >
		                    Archive Drawing
		                  </button>

		                  <button
		                    disabled={!canDeleteDrawing(drawing)}
		                    onClick={(e) => {
		                      e.stopPropagation();
		                      if (!canDeleteDrawing(drawing)) return;
		                      deleteDrawing(index);
		                    }}
		                    className={
		                      canDeleteDrawing(drawing)
		                        ? "rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-800"
		                        : "rounded-md bg-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-500 cursor-not-allowed"
		                    }
			                  >
			                    Delete Drawing
			                  </button>
			                  {drawing.status === "archived" && (
			                    <button
			                      onClick={(e) => {
			                        e.stopPropagation();
			                        restoreDrawing(index);
			                      }}
			                      className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-800"
			                    >
			                      Restore Drawing
			                    </button>
			                  )}
		                </div>
	              </>
	            )}
	          </div>
        );
	      })}
	    </div>
	    </>
	  )}
	</section>
  </>
)}
{activeTab === "mockBetting" && (
<>

	        <section className="mt-8 rounded-xl bg-white p-6 shadow">
  <h2 className="mb-4 text-xl font-semibold">Mock Bet (Admin Test)</h2>

  {drawings.length === 0 ? (
    <p className="text-gray-500">Create drawings first to place mock bets.</p>
  ) : (
    <form onSubmit={handleMockBetSubmit} className="grid gap-4">
      <label className="grid gap-1">
        <span className="font-medium">Select Drawing</span>
        <select
          name="drawingId"
          value={mockBetForm.drawingId}
          onChange={handleMockBetChange}
          className="rounded border p-2 text-gray-900"
          required
        >
          <option value="">Select a drawing</option>
          {drawings.map((drawing: any, index: number) =>
  drawing.status === "scheduled" || drawing.status === "open" ? (
  <option key={drawing.id || index} value={drawing.id}>
    {drawing.id}
  </option>
) : null)}


	        </select>
	      </label>
	<label className="grid gap-1">
	  <span className="font-medium">Player ID</span>
	  <input
	    name="playerId"
	    value={mockBetForm.playerId}
	    onChange={handleMockBetChange}
	    placeholder="Example: PLAYER-1001"
	    className="rounded border p-2 text-gray-900"
	  />
	</label>
	<label className="grid gap-1">
	  <span className="font-medium">Player Name</span>
	  <input
	    name="playerName"
	    value={mockBetForm.playerName}
	    onChange={handleMockBetChange}
	    placeholder="Example: John Smith"
	    className="rounded border p-2 text-gray-900"
	  />
	</label>
	<label className="grid gap-1">
	  <span className="font-medium">Agent ID</span>
	  <input
	    name="agentId"
	    value={mockBetForm.agentId}
	    onChange={handleMockBetChange}
	    placeholder="Example: AGENT-01"
	    className="rounded border p-2 text-gray-900"
	  />
	</label>
	<label className="grid gap-1">
	  <span className="font-medium">Bet Type</span>
  <select
    name="betType"
    value={mockBetForm.betType}
    onChange={handleMockBetChange}
    className="rounded border p-2 text-gray-900"
    required
  >
    <option value="straight">Straight</option>
    <option value="box">Box</option>
    <option value="straight_box">Straight + Box</option>
  </select>
  <span className="text-sm text-gray-500">
    Straight pays full multiplier. Box pays reduced multiplier.
  </span>
	</label>
	{(mockBetForm.betType === "box" ||
	  mockBetForm.betType === "straight_box") && (
	  <label className="grid gap-1">
	    <span className="font-medium">Box Stake Mode</span>
	    <select
	      name="boxStakeMode"
	      value={mockBetForm.boxStakeMode}
	      onChange={handleMockBetChange}
	      className="rounded border p-2 text-gray-900"
	    >
	      <option value="total">Total ticket amount</option>
	      <option value="per_combo">Amount per combination</option>
	    </select>
	    <span className="text-sm text-gray-500">
	      Total ticket amount divides the wager across all box combinations.
	      Amount per combination charges the amount for each box combination.
	    </span>
	  </label>
	)}
	      <label className="grid gap-1">
	        <span className="font-medium">Numbers</span>
        <input
                name="numbers"
                value={mockBetForm.numbers}
                onChange={handleMockBetChange}
                placeholder="Use hyphens: 1-2-3-4 or 10-23-45-52-69"
                pattern="^\d+(-\d+)*$"
                title="Enter numbers separated by hyphens (e.g., 1-2-3-4)"
                className="rounded border p-2 text-gray-900"
  required
/>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Bet Amount</span>
        <input
          name="amount"
          value={mockBetForm.amount}
          onChange={handleMockBetChange}
          placeholder="Example: 1"
          className="rounded border p-2 text-gray-900"
          required
        />
      </label>



      <button className="rounded bg-orange-600 px-4 py-2 font-semibold text-white transition active:scale-95 active:bg-orange-800 hover:bg-orange-700">
        Submit Mock Bet
      </button>
    </form>
	  )}
		</section>
  </>
	)}
{activeTab === "wagerTypes" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Wager Types</h2>

      <form onSubmit={saveWagerType} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Game</span>
            <select
              value={wagerTypeForm.gameId}
              onChange={(e) =>
                setWagerTypeForm({
                  ...wagerTypeForm,
                  gameId: e.target.value,
                  payTableId: "",
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            >
              <option value="">Select a Keno game</option>
              {getKenoGames().map((game: any) => {
                const gameIndex = games.findIndex(
                  (createdGame: any) => createdGame === game
                );

                return (
                  <option key={getGameLocalId(game, gameIndex)} value={getGameLocalId(game, gameIndex)}>
                    {game.name}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Wager Type Name</span>
            <input
              value={wagerTypeForm.name}
              onChange={(e) =>
                setWagerTypeForm({
                  ...wagerTypeForm,
                  name: e.target.value,
                })
              }
              placeholder="Example: Standard Spots"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Wager Type Code</span>
            <input
              value={wagerTypeForm.code}
              onChange={(e) =>
                setWagerTypeForm({
                  ...wagerTypeForm,
                  code: e.target.value,
                })
              }
              placeholder="Example: standard_spots"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Settlement Method</span>
            <select
              value={wagerTypeForm.settlementMethod}
              onChange={(e) =>
                setWagerTypeForm({
                  ...wagerTypeForm,
                  settlementMethod: e.target.value,
                  metricKey: "",
                  comparisonOperator: "",
                  thresholdValue: "",
                  payTableId: "",
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            >
              <option value="hit_count">Hit Count</option>
              <option value="hit_count_bullseye">Hit Count + Bullseye</option>
              <option value="metric_comparison">Metric Comparison</option>
              <option value="metric_threshold">Metric Threshold</option>
              <option value="element_count">Element Count</option>
              <option value="dragon_tiger">Dragon / Tiger</option>
              <option value="selection_match">Selection Match</option>
            </select>
          </label>

          {methodNeedsMetricKey(wagerTypeForm.settlementMethod) && (
            <label className="grid gap-1">
              <span className="font-medium">Metric Key</span>
              <select
                value={wagerTypeForm.metricKey}
                onChange={(e) =>
                  setWagerTypeForm({
                    ...wagerTypeForm,
                    metricKey: e.target.value,
                  })
                }
                className="rounded border p-2 text-gray-900"
                required
              >
                <option value="">Select metric</option>
                {KENO_METRIC_KEYS.map((metricKey) => (
                  <option key={metricKey} value={metricKey}>
                    {metricKey}
                  </option>
                ))}
              </select>
            </label>
          )}

          {methodNeedsOperator(wagerTypeForm.settlementMethod) && (
            <label className="grid gap-1">
              <span className="font-medium">Comparison Operator</span>
              <select
                value={wagerTypeForm.comparisonOperator}
                onChange={(e) =>
                  setWagerTypeForm({
                    ...wagerTypeForm,
                    comparisonOperator: e.target.value,
                  })
                }
                className="rounded border p-2 text-gray-900"
                required
              >
                <option value="">Select operator</option>
                {COMPARISON_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            </label>
          )}

          {methodNeedsThreshold(wagerTypeForm.settlementMethod) && (
            <label className="grid gap-1">
              <span className="font-medium">Threshold Value</span>
              <input
                value={wagerTypeForm.thresholdValue}
                onChange={(e) =>
                  setWagerTypeForm({
                    ...wagerTypeForm,
                    thresholdValue: e.target.value,
                  })
                }
                placeholder="Example: 810"
                className="rounded border p-2 text-gray-900"
                required
              />
            </label>
          )}

          {methodUsesPayTable(wagerTypeForm.settlementMethod) && (
            <label className="grid gap-1">
              <span className="font-medium">Pay Table</span>
              <select
                value={wagerTypeForm.payTableId}
                onChange={(e) =>
                  setWagerTypeForm({
                    ...wagerTypeForm,
                    payTableId: e.target.value,
                  })
                }
                className="rounded border p-2 text-gray-900"
              >
                <option value="">No pay table assigned</option>
                {getPayTablesForGame(wagerTypeForm.gameId).map((payTable) => (
                  <option key={payTable.id} value={payTable.id}>
                    {payTable.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={wagerTypeForm.active}
            onChange={(e) =>
              setWagerTypeForm({
                ...wagerTypeForm,
                active: e.target.checked,
              })
            }
          />
          Active
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {editingWagerTypeId ? "Update Wager Type" : "Save Wager Type"}
          </button>
          <button
            type="button"
            onClick={addDefaultKenoWagerTypes}
            className="rounded bg-purple-700 px-4 py-2 font-semibold text-white hover:bg-purple-800"
          >
            Add Default Keno Wager Types
          </button>
          <button
            type="button"
            onClick={resetWagerTypeForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
          {editingWagerTypeId && (
            <button
              type="button"
              onClick={resetWagerTypeForm}
              className="rounded bg-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel Edit
            </button>
          )}
        </div>
      </form>
    </section>

    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Created Wager Types</h2>

      {wagerTypes.length === 0 ? (
        <p className="text-sm text-gray-500">No wager types created yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-3">Game Name</th>
                <th className="py-2 pr-3">Wager Type</th>
                <th className="py-2 pr-3">Option Count</th>
                <th className="py-2 pr-3">Settlement Method</th>
                <th className="py-2 pr-3">Pay Table</th>
                <th className="py-2 pr-3">Active</th>
                <th className="min-w-[130px] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {wagerTypes.map((wagerType) => {
                const game = games.find(
                  (createdGame: any, index: number) =>
                    getGameLocalId(createdGame, index) === wagerType.gameId
                );
                const payTable = payTables.find(
                  (createdPayTable) => createdPayTable.id === wagerType.payTableId
                );
                const optionCount = getOptionsForWagerType(wagerType.id).length;

                return (
                  <tr key={wagerType.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{game?.name || wagerType.gameId}</td>
                    <td className="py-2 pr-3">
                      <div>
                        <p className="font-medium">{wagerType.name}</p>
                        <p className="text-xs text-gray-500">{wagerType.code}</p>
                      </div>
                    </td>
                    <td className="py-2 pr-3">{optionCount}</td>
                    <td className="py-2 pr-3">{wagerType.settlementMethod}</td>
                    <td className="py-2 pr-3">{payTable?.name || ""}</td>
                    <td className="py-2 pr-3">
                      {wagerType.active ? "Active" : "Inactive"}
                    </td>
                    <td className="min-w-[130px] py-2 pr-3">
                      <div className="flex flex-nowrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => editWagerType(wagerType)}
                          className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteWagerType(wagerType.id)}
                          className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Wager Options</h2>

      <form onSubmit={saveWagerOption} className="mb-6 grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Wager Type</span>
            <select
              value={wagerOptionForm.wagerTypeId}
              onChange={(e) =>
                setWagerOptionForm({
                  ...wagerOptionForm,
                  wagerTypeId: e.target.value,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            >
              <option value="">Select wager type</option>
              {wagerTypes.map((wagerType) => {
                const game = games.find(
                  (createdGame: any, index: number) =>
                    getGameLocalId(createdGame, index) === wagerType.gameId
                );

                return (
                  <option key={wagerType.id} value={wagerType.id}>
                    {game?.name || wagerType.gameId} - {wagerType.name}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Option Name</span>
            <input
              value={wagerOptionForm.name}
              onChange={(e) =>
                setWagerOptionForm({
                  ...wagerOptionForm,
                  name: e.target.value,
                })
              }
              placeholder="Example: Dragon"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Option Code</span>
            <input
              value={wagerOptionForm.code}
              onChange={(e) =>
                setWagerOptionForm({
                  ...wagerOptionForm,
                  code: e.target.value,
                })
              }
              placeholder="Example: dragon"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={wagerOptionForm.active}
            onChange={(e) =>
              setWagerOptionForm({
                ...wagerOptionForm,
                active: e.target.checked,
              })
            }
          />
          Active
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {editingWagerOptionId ? "Update Option" : "Add Option"}
          </button>
          <button
            type="button"
            onClick={resetWagerOptionForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
          {editingWagerOptionId && (
            <button
              type="button"
              onClick={resetWagerOptionForm}
              className="rounded bg-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel Edit
            </button>
          )}
        </div>
      </form>

      {wagerOptions.length === 0 ? (
        <p className="text-sm text-gray-500">No wager options created yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-3">Wager Type</th>
                <th className="py-2 pr-3">Option</th>
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Active</th>
                <th className="min-w-[130px] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {wagerOptions.map((option) => {
                const wagerType = wagerTypes.find(
                  (createdWagerType) => createdWagerType.id === option.wagerTypeId
                );

                return (
                  <tr key={option.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      {wagerType?.name || option.wagerTypeId}
                    </td>
                    <td className="py-2 pr-3">{option.name}</td>
                    <td className="py-2 pr-3">{option.code}</td>
                    <td className="py-2 pr-3">
                      {option.active ? "Active" : "Inactive"}
                    </td>
                    <td className="min-w-[130px] py-2 pr-3">
                      <div className="flex flex-nowrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => editWagerOption(option)}
                          className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteWagerOption(option.id)}
                          className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </>
)}
{activeTab === "payTables" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Pay Tables</h2>

      <form onSubmit={savePayTable} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Game</span>
            <select
              value={payTableForm.gameId}
              onChange={(e) =>
                setPayTableForm({
                  ...payTableForm,
                  gameId: e.target.value,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            >
              <option value="">Select a game</option>
              {games.map((game: any, index: number) => (
                <option key={getGameLocalId(game, index)} value={getGameLocalId(game, index)}>
                  {game.state} — {game.name}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Pay Table Name</span>
            <input
              value={payTableForm.name}
              onChange={(e) =>
                setPayTableForm({
                  ...payTableForm,
                  name: e.target.value,
                })
              }
              placeholder="Example: Standard Pay Table"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Effective Date</span>
            <input
              type="date"
              value={payTableForm.effectiveDate}
              onChange={(e) =>
                setPayTableForm({
                  ...payTableForm,
                  effectiveDate: e.target.value,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>
        </div>

        <div className="grid gap-3 rounded border bg-gray-50 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-gray-900">Pay Table Rows</h3>
            <button
              type="button"
              onClick={addPayTableRow}
              className="rounded-md bg-gray-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-800"
            >
              Add Row
            </button>
          </div>

          {payTableRows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-1 items-end gap-4 rounded border bg-white p-4 md:grid-cols-[1fr_1fr_1fr_1fr_auto]"
            >
              <label className="grid gap-1">
                <span className="text-sm font-medium">Spot Count</span>
                <input
                  value={row.spotCount}
                  onChange={(e) =>
                    updatePayTableRow(row.id, "spotCount", e.target.value)
                  }
                  className="h-10 w-full rounded border p-2 text-gray-900"
                  required
                />
              </label>

              <label className="grid gap-1">
                <span className="text-sm font-medium">Hit Count</span>
                <input
                  value={row.hitCount}
                  onChange={(e) =>
                    updatePayTableRow(row.id, "hitCount", e.target.value)
                  }
                  className="h-10 w-full rounded border p-2 text-gray-900"
                  required
                />
              </label>

              <label className="grid gap-1">
                <span className="text-sm font-medium">Bullseye Required</span>
                <span className="flex h-10 items-center gap-2 rounded border bg-white px-3 text-sm font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={row.bullseyeRequired}
                    onChange={(e) =>
                      updatePayTableRow(
                        row.id,
                        "bullseyeRequired",
                        e.target.checked
                      )
                    }
                  />
                  Required
                </span>
              </label>

              <label className="grid gap-1">
                <span className="text-sm font-medium">Payout</span>
                <input
                  value={row.payout}
                  onChange={(e) =>
                    updatePayTableRow(row.id, "payout", e.target.value)
                  }
                  className="h-10 w-full rounded border p-2 text-gray-900"
                  required
                />
              </label>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => removePayTableRow(row.id)}
                  className="h-10 w-full rounded-md bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 md:w-auto"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            Save Pay Table
          </button>
          <button
            type="button"
            onClick={resetPayTableForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
        </div>
      </form>
    </section>

    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Created Pay Tables</h2>

      {payTables.length === 0 ? (
        <p className="text-sm text-gray-500">No pay tables created yet.</p>
      ) : (
        <div className="space-y-3">
          {payTables.map((payTable) => {
            const game = games.find(
              (createdGame: any, index: number) =>
                getGameLocalId(createdGame, index) === payTable.gameId
            );

            return (
              <div key={payTable.id} className="rounded border bg-white p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-gray-900">{payTable.name}</p>
                    <p className="text-sm text-gray-600">
                      {game ? `${game.state} — ${game.name}` : payTable.gameId}{" "}
                      | Effective {payTable.effectiveDate} |{" "}
                      {payTable.active ? "Active" : "Inactive"}
                    </p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-xs uppercase text-gray-500">
                      <tr>
                        <th className="py-2 pr-3">Spot Count</th>
                        <th className="py-2 pr-3">Hit Count</th>
                        <th className="py-2 pr-3">Bullseye Required</th>
                        <th className="py-2 pr-3">Payout</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payTable.rows.map((row) => (
                        <tr key={row.id} className="border-b last:border-0">
                          <td className="py-2 pr-3">{row.spotCount}</td>
                          <td className="py-2 pr-3">{row.hitCount}</td>
                          <td className="py-2 pr-3">
                            {row.bullseyeRequired ? "Yes" : "No"}
                          </td>
                          <td className="py-2 pr-3">{formatMoney(row.payout)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  </>
)}
{activeTab === "hotspotAdmin" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Keno Operations</h2>

      <div className="grid gap-4">
        <div className="rounded border bg-gray-50 p-4">
          <h3 className="mb-3 font-semibold text-gray-900">Draw Generator</h3>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1">
              <span className="font-medium">Select Keno Game</span>
              <select
                value={selectedKenoGameId}
                onChange={(e) => setSelectedKenoGameId(e.target.value)}
                className="rounded border p-2 text-gray-900"
              >
                <option value="">Select a Keno game</option>
                {getKenoGames().map((game: any) => {
                  const gameIndex = games.findIndex(
                    (createdGame: any) => createdGame === game
                  );

                  return (
                    <option key={getGameLocalId(game, gameIndex)} value={getGameLocalId(game, gameIndex)}>
                      {game.name}
                    </option>
                  );
                })}
              </select>
            </label>

            <div className="grid gap-2 rounded border bg-white p-3 text-sm text-gray-700">
              <p>
                <span className="font-semibold">Draw Interval:</span>{" "}
                {getSelectedKenoGame()?.drawIntervalSeconds
                  ? `${getSelectedKenoGame()?.drawIntervalSeconds} seconds`
                  : selectedKenoGameId
                    ? "240 seconds"
                    : "Select a game"}
              </p>
              <p>
                <span className="font-semibold">Draw ID Prefix:</span>{" "}
                {getSelectedKenoGame()?.drawIdPrefix || "Select a game"}
              </p>
              <p>
                <span className="font-semibold">Last Generated Draw:</span>{" "}
                {lastGeneratedKenoDraw?.drawCode || "None"}
              </p>
              <p>
                <span className="font-semibold">Next Draw Preview:</span>{" "}
                {getNextKenoDrawPreview()?.drawCode || "Select a game"}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => generateKenoDraws(1)}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Generate Next Draw
            </button>
            <button
              type="button"
              onClick={() => generateKenoDraws(10)}
              className="rounded-md bg-indigo-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-800"
            >
              Generate Next 10 Draws
            </button>
            <button
              type="button"
              onClick={generateTodaysKenoDraws}
              className="rounded-md bg-purple-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-800"
            >
              Generate Today's Draws
            </button>
          </div>
        </div>

        <div className="rounded border bg-gray-50 p-4">
          <h3 className="mb-3 font-semibold text-gray-900">Keno Draw Metrics</h3>

          {kenoDrawMetrics.length === 0 ? (
            <p className="text-sm text-gray-500">
              No Keno draw metrics calculated yet.
            </p>
          ) : (
            <div className="grid gap-3">
              {kenoDrawMetrics.map((metrics) => {
                const drawing = drawings.find(
                  (createdDrawing: any) =>
                    String(createdDrawing.id || createdDrawing.drawCode || "") ===
                    metrics.drawingId
                );

                return (
                  <div key={metrics.id} className="rounded border bg-white p-4 text-sm text-gray-700">
                    <div className="mb-2">
                      <p className="font-semibold text-gray-900">
                        {drawing?.drawCode || metrics.drawingId}
                      </p>
                      <p className="text-gray-500">
                        {drawing?.game?.name || metrics.gameId}
                      </p>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <p>
                        <span className="font-semibold">Sum:</span>{" "}
                        {metrics.drawSum}
                      </p>
                      <p>
                        <span className="font-semibold">Odd / Even:</span>{" "}
                        {metrics.oddCount} / {metrics.evenCount}
                      </p>
                      <p>
                        <span className="font-semibold">Low Count:</span>{" "}
                        {metrics.lowCount}
                      </p>
                      <p>
                        <span className="font-semibold">High Count:</span>{" "}
                        {metrics.highCount}
                      </p>
                      <p>
                        <span className="font-semibold">Up/Down Result:</span>{" "}
                        {metrics.upDownResult.toUpperCase()}
                      </p>
                      <p>
                        <span className="font-semibold">
                          First Half / Second Half:
                        </span>{" "}
                        {metrics.firstHalfCount} / {metrics.secondHalfCount}
                      </p>
                      <p>
                        <span className="font-semibold">Dragon Digit:</span>{" "}
                        {metrics.dragonDigit}
                      </p>
                      <p>
                        <span className="font-semibold">Tiger Digit:</span>{" "}
                        {metrics.tigerDigit}
                      </p>
                      <p>
                        <span className="font-semibold">
                          Dragon/Tiger Result:
                        </span>{" "}
                        {metrics.dragonTigerResult.toUpperCase()}
                      </p>
                      <p>
                        <span className="font-semibold">Bullseye:</span>{" "}
                        {metrics.bullseyeNumber || "N/A"}
                      </p>
                    </div>

                    <p className="mt-2">
                      <span className="font-semibold">Element Counts:</span>{" "}
                      Wood {metrics.woodCount}, Fire {metrics.fireCount}, Earth{" "}
                      {metrics.earthCount}, Metal {metrics.metalCount}, Water{" "}
                      {metrics.waterCount}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  </>
)}
{activeTab === "tickets" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Tickets</h2>

      {(() => {
        const pendingTickets = tickets.filter((ticket) => ticket.status === "pending");
        const acceptedTickets = tickets.filter((ticket) => ticket.status === "accepted");
        const settledTickets = tickets.filter((ticket) => ticket.status === "settled");
        const voidTickets = tickets.filter((ticket) => ticket.status === "void");
        const totalPendingExposure = playerAccounts.reduce(
          (total, account) => total + calculatePendingExposureForAccount(account.id),
          0
        );

        return (
          <div className="grid gap-6">
            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">Ticket Summary</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <div className="rounded border bg-white p-3">
                  <p className="text-xs uppercase text-gray-500">Total Tickets</p>
                  <p className="text-lg font-semibold">{tickets.length}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="text-xs uppercase text-gray-500">Pending</p>
                  <p className="text-lg font-semibold">{pendingTickets.length}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="text-xs uppercase text-gray-500">Accepted</p>
                  <p className="text-lg font-semibold">{acceptedTickets.length}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="text-xs uppercase text-gray-500">Settled</p>
                  <p className="text-lg font-semibold">{settledTickets.length}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="text-xs uppercase text-gray-500">Void</p>
                  <p className="text-lg font-semibold">{voidTickets.length}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="text-xs uppercase text-gray-500">
                    Pending Exposure
                  </p>
                  <p className="text-lg font-semibold">
                    {formatMoney(totalPendingExposure)}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Create Test Ticket
              </h3>

              <form onSubmit={saveTestTicket} className="grid gap-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Account</span>
                    <select
                      value={ticketForm.accountId}
                      onChange={(e) =>
                        setTicketForm({
                          ...ticketForm,
                          accountId: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                      required
                    >
                      <option value="">Select account</option>
                      {playerAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.displayName} ({account.username})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Market</span>
                    <select
                      value={ticketForm.marketId}
                      onChange={(e) =>
                        setTicketForm({
                          ...ticketForm,
                          marketId: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                    >
                      <option value="">No market assigned</option>
                      {markets.map((market) => (
                        <option key={market.id} value={market.id}>
                          {market.name} ({market.code})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Game</span>
                    <select
                      value={ticketForm.gameId}
                      onChange={(e) =>
                        setTicketForm({
                          ...ticketForm,
                          gameId: e.target.value,
                          drawingId: "",
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                      required
                    >
                      <option value="">Select game</option>
                      {games.map((game: any, index: number) => (
                        <option key={getGameLocalId(game, index)} value={getGameLocalId(game, index)}>
                          {game.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Drawing</span>
                    <select
                      value={ticketForm.drawingId}
                      onChange={(e) =>
                        setTicketForm({
                          ...ticketForm,
                          drawingId: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                      required
                    >
                      <option value="">Select drawing</option>
                      {drawings
                        .filter((drawing: any) => {
                          if (!ticketForm.gameId) return true;
                          return (
                            drawing.gameId === ticketForm.gameId ||
                            getGameLocalId(
                              drawing.game,
                              games.findIndex(
                                (createdGame: any) => createdGame === drawing.game
                              )
                            ) === ticketForm.gameId
                          );
                        })
                        .map((drawing: any, index: number) => (
                          <option key={drawing.id || index} value={drawing.id}>
                            {drawing.drawCode || drawing.id}
                          </option>
                        ))}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Funding Type</span>
                    <select
                      value={ticketForm.fundingType}
                      onChange={(e) =>
                        setTicketForm({
                          ...ticketForm,
                          fundingType: e.target.value as TicketFundingType,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                      required
                    >
                      <option value="cash">Cash</option>
                      <option value="credit">Credit</option>
                      <option value="freeplay">Free Play</option>
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Notes</span>
                    <input
                      value={ticketForm.notes}
                      onChange={(e) =>
                        setTicketForm({
                          ...ticketForm,
                          notes: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                    />
                  </label>
                </div>

                <div className="rounded border bg-white p-4">
                  <h4 className="mb-3 font-semibold text-gray-900">
                    Ticket Line Builder
                  </h4>

                  <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1.35fr)_repeat(4,minmax(0,1fr))_auto]">
                    <label className="grid gap-1">
                      <span className="text-sm font-medium">Wager Type</span>
                      <select
                        value={ticketLineForm.wagerTypeId}
                        onChange={(e) =>
                          setTicketLineForm({
                            ...ticketLineForm,
                            wagerTypeId: e.target.value,
                            wagerOptionId: "",
                          })
                        }
                        className="h-10 w-full rounded border p-2 text-gray-900"
                      >
                        <option value="">Select wager type</option>
                        {wagerTypes.map((wagerType) => (
                          <option key={wagerType.id} value={wagerType.id}>
                            {wagerType.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="grid gap-1">
                      <span className="text-sm font-medium">Wager Option</span>
                      <select
                        value={ticketLineForm.wagerOptionId}
                        onChange={(e) =>
                          setTicketLineForm({
                            ...ticketLineForm,
                            wagerOptionId: e.target.value,
                          })
                        }
                        className="h-10 w-full rounded border p-2 text-gray-900"
                      >
                        <option value="">No option</option>
                        {wagerOptions
                          .filter(
                            (option) =>
                              option.wagerTypeId === ticketLineForm.wagerTypeId
                          )
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                      </select>
                    </label>

                    <label className="grid gap-1">
                      <span className="text-sm font-medium">Selected Numbers</span>
                      <input
                        value={ticketLineForm.selectedNumbers}
                        onChange={(e) =>
                          setTicketLineForm({
                            ...ticketLineForm,
                            selectedNumbers: e.target.value,
                          })
                        }
                        placeholder="1,2,3,4"
                        className="h-10 w-full rounded border p-2 text-gray-900"
                      />
                    </label>

                    <label className="grid gap-1">
                      <span className="text-sm font-medium">Stake</span>
                      <input
                        value={ticketLineForm.stake}
                        onChange={(e) =>
                          setTicketLineForm({
                            ...ticketLineForm,
                            stake: e.target.value,
                          })
                        }
                        className="h-10 w-full rounded border p-2 text-gray-900"
                      />
                    </label>

                    <label className="grid gap-1">
                      <span className="text-sm font-medium">Potential Payout</span>
                      <input
                        value={ticketLineForm.potentialPayout}
                        onChange={(e) =>
                          setTicketLineForm({
                            ...ticketLineForm,
                            potentialPayout: e.target.value,
                          })
                        }
                        className="h-10 w-full rounded border p-2 text-gray-900"
                      />
                    </label>

                    <div>
                      <button
                        type="button"
                        onClick={addDraftTicketLine}
                        className="h-10 w-full whitespace-nowrap rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-800 lg:w-auto"
                      >
                        Add Line
                      </button>
                    </div>
                  </div>

                  {draftTicketLines.length > 0 && (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b text-xs uppercase text-gray-500">
                          <tr>
                            <th className="py-2 pr-3">Wager Type</th>
                            <th className="py-2 pr-3">Option</th>
                            <th className="py-2 pr-3">Numbers</th>
                            <th className="py-2 pr-3">Stake</th>
                            <th className="py-2 pr-3">Potential Payout</th>
                            <th className="py-2 pr-3">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftTicketLines.map((line, index) => {
                            const wagerType = wagerTypes.find(
                              (createdWagerType) =>
                                createdWagerType.id === line.wagerTypeId
                            );
                            const wagerOption = wagerOptions.find(
                              (createdOption) =>
                                createdOption.id === line.wagerOptionId
                            );

                            return (
                              <tr key={`${line.wagerTypeId}-${index}`} className="border-b last:border-0">
                                <td className="py-2 pr-3">{wagerType?.name || ""}</td>
                                <td className="py-2 pr-3">{wagerOption?.name || ""}</td>
                                <td className="py-2 pr-3">
                                  {line.selectedNumbers?.join(", ") || ""}
                                </td>
                                <td className="py-2 pr-3">{formatMoney(line.stake)}</td>
                                <td className="py-2 pr-3">
                                  {formatMoney(line.potentialPayout)}
                                </td>
                                <td className="py-2 pr-3">
                                  <button
                                    type="button"
                                    onClick={() => removeDraftTicketLine(index)}
                                    className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div>
                  <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
                    Save Test Ticket
                  </button>
                </div>
              </form>
            </section>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Created Tickets
              </h3>

              {tickets.length === 0 ? (
                <p className="text-sm text-gray-500">No tickets created yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-xs uppercase text-gray-500">
                      <tr>
                        <th className="py-2 pr-3">Ticket Number</th>
                        <th className="py-2 pr-3">Account</th>
                        <th className="py-2 pr-3">Game</th>
                        <th className="py-2 pr-3">Drawing</th>
                        <th className="py-2 pr-3">Total Stake</th>
                        <th className="py-2 pr-3">Potential Payout</th>
                        <th className="py-2 pr-3">Funding</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Created At</th>
                        <th className="py-2 pr-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.map((ticket) => {
                        const account = playerAccounts.find(
                          (createdAccount) => createdAccount.id === ticket.accountId
                        );
                        const game = games.find(
                          (createdGame: any, index: number) =>
                            getGameLocalId(createdGame, index) === ticket.gameId
                        );
                        const drawing = drawings.find(
                          (createdDrawing: any) =>
                            createdDrawing.id === ticket.drawingId
                        );
                        const isExpanded = expandedTicketIds.includes(ticket.id);

                        return (
                          <Fragment key={ticket.id}>
                            <tr key={ticket.id} className="border-b">
                              <td className="py-2 pr-3">
                                <button
                                  type="button"
                                  onClick={() => toggleTicketExpanded(ticket.id)}
                                  className="font-semibold text-blue-700 hover:underline"
                                >
                                  {isExpanded ? "▼" : "▶"} {ticket.ticketNumber}
                                </button>
                              </td>
                              <td className="py-2 pr-3">{account?.username || ""}</td>
                              <td className="py-2 pr-3">{game?.name || ticket.gameId}</td>
                              <td className="py-2 pr-3">
                                {drawing?.drawCode || ticket.drawingId}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(calculateTicketTotalStake(ticket.id))}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(calculateTicketPotentialPayout(ticket.id))}
                              </td>
                              <td className="py-2 pr-3">{ticket.fundingType}</td>
                              <td className="py-2 pr-3">{ticket.status}</td>
                              <td className="py-2 pr-3">
                                {new Date(ticket.createdAt).toLocaleString()}
                              </td>
                              <td className="py-2 pr-3">
                                <div className="flex flex-wrap gap-2">
                                  {ticket.status === "pending" && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateTicketStatus(ticket.id, "accepted")
                                      }
                                      className="rounded-md bg-green-700 px-3 py-1 text-xs font-semibold text-white hover:bg-green-800"
                                    >
                                      Accept
                                    </button>
                                  )}
                                  {ticket.status === "pending" && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateTicketStatus(ticket.id, "cancelled")
                                      }
                                      className="rounded-md bg-yellow-700 px-3 py-1 text-xs font-semibold text-white hover:bg-yellow-800"
                                    >
                                      Cancel
                                    </button>
                                  )}
                                  {(ticket.status === "pending" ||
                                    ticket.status === "accepted") && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateTicketStatus(ticket.id, "void")
                                      }
                                      className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                                    >
                                      Void
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${ticket.id}-lines`} className="border-b bg-white">
                                <td colSpan={10} className="p-3">
                                  <div className="overflow-x-auto rounded border bg-gray-50 p-3">
                                    <table className="w-full text-left text-sm">
                                      <thead className="border-b text-xs uppercase text-gray-500">
                                        <tr>
                                          <th className="py-2 pr-3">Wager Type</th>
                                          <th className="py-2 pr-3">Wager Option</th>
                                          <th className="py-2 pr-3">Selected Numbers</th>
                                          <th className="py-2 pr-3">Stake</th>
                                          <th className="py-2 pr-3">Potential Payout</th>
                                          <th className="py-2 pr-3">Line Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {getTicketLines(ticket.id).map((line) => {
                                          const wagerType = wagerTypes.find(
                                            (createdWagerType) =>
                                              createdWagerType.id === line.wagerTypeId
                                          );
                                          const wagerOption = wagerOptions.find(
                                            (createdOption) =>
                                              createdOption.id === line.wagerOptionId
                                          );

                                          return (
                                            <tr key={line.id} className="border-b last:border-0">
                                              <td className="py-2 pr-3">
                                                {wagerType?.name || line.wagerTypeId}
                                              </td>
                                              <td className="py-2 pr-3">
                                                {wagerOption?.name || ""}
                                              </td>
                                              <td className="py-2 pr-3">
                                                {line.selectedNumbers?.join(", ") || ""}
                                              </td>
                                              <td className="py-2 pr-3">
                                                {formatMoney(line.stake)}
                                              </td>
                                              <td className="py-2 pr-3">
                                                {formatMoney(line.potentialPayout)}
                                              </td>
                                              <td className="py-2 pr-3">
                                                {line.status}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        );
      })()}
    </section>
  </>
)}
{activeTab === "settlement" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Settlement</h2>

      {(() => {
        const selectedSettlementDrawing = drawings.find(
          (drawing: any) => drawing.id === settlementForm.drawingId
        );
        const selectedDrawingRuns = settlementForm.drawingId
          ? getSettlementRunsForDrawing(settlementForm.drawingId)
          : [];

        return (
          <div className="grid gap-6">
            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-2 font-semibold text-gray-900">
                Settlement TODO / Architecture Note
              </h3>
              <p className="text-sm text-gray-700">
                Future weekly close process must respect account.creditMode =
                zero_balance or carry. Zero-balance accounts receive automatic
                zero_balance_credit/debit entries at the configured market reset
                time. Carry accounts remain unchanged until manual
                deposit/withdrawal occurs.
              </p>
              <p className="mt-2 text-sm text-gray-700">
                Production resettlement will require override authorization,
                reason code, approving admin, and audit log entry.
              </p>
              <p className="mt-2 text-sm text-gray-700">
                Resettlement requires an approved override, dual-control
                approval, and is allowed only for open accounting periods.
              </p>
            </section>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Create Settlement Run
              </h3>

              <form onSubmit={createSettlementRun} className="grid gap-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Drawing</span>
                    <select
                      value={settlementForm.drawingId}
                      onChange={(e) =>
                        setSettlementForm({
                          ...settlementForm,
                          drawingId: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                      required
                    >
                      <option value="">Select drawing</option>
                      {drawings.map((drawing: any, index: number) => (
                        <option key={drawing.id || index} value={drawing.id}>
                          {drawing.drawCode || drawing.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm font-medium">Notes</span>
                    <input
                      value={settlementForm.notes}
                      onChange={(e) =>
                        setSettlementForm({
                          ...settlementForm,
                          notes: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded border p-2 text-gray-900"
                    />
                  </label>
                </div>

                {settlementForm.drawingId && selectedDrawingRuns.length > 0 && (
                  <p className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                    Warning: {selectedDrawingRuns.length} settlement run
                    {selectedDrawingRuns.length === 1 ? "" : "s"} already exist
                    for this drawing.
                  </p>
                )}

                {settlementForm.drawingId &&
                  hasExistingCompletedSettlementForDrawing(
                    settlementForm.drawingId
                  ) && (
                    <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                      A completed settlement run already exists for this
                      drawing. Creating another completed settlement is blocked
                      until explicit resettlement authorization exists.
                    </p>
                  )}

                <div>
                  <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
                    Create Settlement Run
                  </button>
                </div>
              </form>

              {selectedSettlementDrawing && (
                <p className="mt-3 text-sm text-gray-600">
                  Selected drawing:{" "}
                  {selectedSettlementDrawing.drawCode ||
                    selectedSettlementDrawing.id}
                </p>
              )}
            </section>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Settlement Runs
              </h3>

              {settlementRuns.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No settlement runs created yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-xs uppercase text-gray-500">
                      <tr>
                        <th className="py-2 pr-3">Run ID</th>
                        <th className="py-2 pr-3">Drawing</th>
                        <th className="py-2 pr-3">Game</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Tickets</th>
                        <th className="py-2 pr-3">Lines</th>
                        <th className="py-2 pr-3">Stake</th>
                        <th className="py-2 pr-3">Payout</th>
                        <th className="py-2 pr-3">Net</th>
                        <th className="py-2 pr-3">Created</th>
                        <th className="py-2 pr-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settlementRuns.map((run) => {
                        const drawing = drawings.find(
                          (createdDrawing: any) =>
                            createdDrawing.id === run.drawingId
                        );
                        const game = games.find(
                          (createdGame: any, index: number) =>
                            getGameLocalId(createdGame, index) === run.gameId
                        );
                        const isExpanded = expandedSettlementRunIds.includes(run.id);
                        const records = getSettlementRecordsForRun(run.id);

                        return (
                          <Fragment key={run.id}>
                            <tr className="border-b">
                              <td className="py-2 pr-3">
                                <button
                                  type="button"
                                  onClick={() =>
                                    toggleSettlementRunExpanded(run.id)
                                  }
                                  className="font-semibold text-blue-700 hover:underline"
                                >
                                  {isExpanded ? "▼" : "▶"} {run.id}
                                </button>
                              </td>
                              <td className="py-2 pr-3">
                                {drawing?.drawCode || run.drawingId}
                              </td>
                              <td className="py-2 pr-3">
                                {game?.name || run.gameId || "Unknown"}
                              </td>
                              <td className="py-2 pr-3">{run.status}</td>
                              <td className="py-2 pr-3">
                                {run.processedTicketCount}
                              </td>
                              <td className="py-2 pr-3">
                                {run.processedLineCount}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(run.totalStake)}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(run.totalPayout)}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(run.totalNet)}
                              </td>
                              <td className="py-2 pr-3">
                                {new Date(run.createdAt).toLocaleString()}
                              </td>
                              <td className="py-2 pr-3">
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      generatePlaceholderSettlementRecords(run.id)
                                    }
                                    className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                                  >
                                    Generate Records
                                  </button>
                                  {run.status === "pending" && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateSettlementRunStatus(
                                          run.id,
                                          "running"
                                        )
                                      }
                                      className="rounded-md bg-green-700 px-3 py-1 text-xs font-semibold text-white hover:bg-green-800"
                                    >
                                      Start
                                    </button>
                                  )}
                                  {run.status === "running" && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateSettlementRunStatus(
                                          run.id,
                                          "completed"
                                        )
                                      }
                                      className="rounded-md bg-blue-700 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-800"
                                    >
                                      Complete
                                    </button>
                                  )}
                                  {(run.status === "pending" ||
                                    run.status === "running") && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateSettlementRunStatus(run.id, "failed")
                                      }
                                      className="rounded-md bg-yellow-700 px-3 py-1 text-xs font-semibold text-white hover:bg-yellow-800"
                                    >
                                      Fail
                                    </button>
                                  )}
                                  {run.status === "completed" && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateSettlementRunStatus(
                                          run.id,
                                          "reversed"
                                        )
                                      }
                                      className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                                    >
                                      Reverse
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="border-b bg-white">
                                <td colSpan={11} className="p-3">
                                  <div className="rounded border bg-gray-50 p-3">
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                      <p className="font-semibold text-gray-900">
                                        Settlement Records Detail
                                      </p>
                                      <p className="text-sm text-gray-500">
                                        Records: {records.length}
                                      </p>
                                    </div>

                                    {records.length === 0 ? (
                                      <p className="text-sm text-gray-500">
                                        No settlement records generated yet.
                                      </p>
                                    ) : (
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-left text-sm">
                                          <thead className="border-b text-xs uppercase text-gray-500">
                                            <tr>
                                              <th className="py-2 pr-3">Ticket</th>
                                              <th className="py-2 pr-3">
                                                Ticket Line
                                              </th>
                                              <th className="py-2 pr-3">Account</th>
                                              <th className="py-2 pr-3">
                                                Wager Type
                                              </th>
                                              <th className="py-2 pr-3">
                                                Wager Option
                                              </th>
                                              <th className="py-2 pr-3">Stake</th>
                                              <th className="py-2 pr-3">Payout</th>
                                              <th className="py-2 pr-3">Net</th>
                                              <th className="py-2 pr-3">
                                                Outcome
                                              </th>
                                              <th className="py-2 pr-3">Status</th>
                                              <th className="py-2 pr-3">Version</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {records.map((record) => {
                                              const ticket = tickets.find(
                                                (createdTicket) =>
                                                  createdTicket.id === record.ticketId
                                              );
                                              const account = playerAccounts.find(
                                                (createdAccount) =>
                                                  createdAccount.id ===
                                                  record.accountId
                                              );
                                              const wagerType = wagerTypes.find(
                                                (createdWagerType) =>
                                                  createdWagerType.id ===
                                                  record.wagerTypeId
                                              );
                                              const wagerOption = wagerOptions.find(
                                                (createdOption) =>
                                                  createdOption.id ===
                                                  record.wagerOptionId
                                              );

                                              return (
                                                <tr
                                                  key={record.id}
                                                  className="border-b last:border-0"
                                                >
                                                  <td className="py-2 pr-3">
                                                    {ticket?.ticketNumber ||
                                                      record.ticketId}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {record.ticketLineId}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {account?.username ||
                                                      record.accountId}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {wagerType?.name ||
                                                      record.wagerTypeId}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {wagerOption?.name || ""}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {formatMoney(record.stake)}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {formatMoney(record.payout)}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {formatMoney(record.netAmount)}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {record.outcome}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {record.status}
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                    {record.version}
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        );
      })()}
    </section>
  </>
)}
{activeTab === "financialLedger" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Financial Ledger</h2>

      {(() => {
        const selectedLedgerAccountId =
          ledgerForm.accountId || selectedAccountId || playerAccounts[0]?.id || "";
        const selectedLedgerAccount = playerAccounts.find(
          (account) => account.id === selectedLedgerAccountId
        );
        const financialSummary = selectedLedgerAccountId
          ? getAccountFinancialSummary(selectedLedgerAccountId)
          : null;
        const selectedAccountTransactions = selectedLedgerAccountId
          ? getAccountLedgerTransactions(selectedLedgerAccountId)
          : [];

        return (
          <div className="grid gap-6">
            <div className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Financial Summary
              </h3>

              <label className="mb-4 grid gap-1">
                <span className="font-medium">Account</span>
                <select
                  value={selectedLedgerAccountId}
                  onChange={(e) =>
                    setLedgerForm({
                      ...ledgerForm,
                      accountId: e.target.value,
                    })
                  }
                  className="rounded border p-2 text-gray-900"
                >
                  <option value="">Select account</option>
                  {playerAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName} ({account.username}) -{" "}
                      {getAccountTypeLabel(account.accountType)}
                    </option>
                  ))}
                </select>
              </label>

              {!financialSummary ? (
                <p className="text-sm text-gray-500">
                  Select or create an account to view financial summary.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded border bg-white p-3">
                    <p className="text-xs uppercase text-gray-500">
                      Accounting Balance
                    </p>
                    <p className="text-lg font-semibold">
                      {formatMoney(financialSummary.accountingBalance)}
                    </p>
                  </div>
                  <div className="rounded border bg-white p-3">
                    <p className="text-xs uppercase text-gray-500">
                      Weekly Figure
                    </p>
                    <p className="text-lg font-semibold">
                      {formatMoney(financialSummary.weeklyFigure)}
                    </p>
                  </div>
                  <div className="rounded border bg-white p-3">
                    <p className="text-xs uppercase text-gray-500">
                      Free Play Balance
                    </p>
                    <p className="text-lg font-semibold">
                      {formatMoney(financialSummary.freeplayBalance)}
                    </p>
                  </div>
                  <div className="rounded border bg-white p-3">
                    <p className="text-xs uppercase text-gray-500">
                      Pending Exposure
                    </p>
                    <p className="text-lg font-semibold">
                      {formatMoney(financialSummary.pendingExposure)}
                    </p>
                  </div>
                  <div className="rounded border bg-white p-3">
                    <p className="text-xs uppercase text-gray-500">
                      Available Credit
                    </p>
                    <p className="text-lg font-semibold">
                      {formatMoney(financialSummary.availableCredit)}
                    </p>
                  </div>
                </div>
              )}

              <p className="mt-3 text-xs text-gray-500">
                Weekly reset placeholders: weeklyResetDay, weeklyResetTime,
                weeklyResetTimeZone. Future scheduler: Monday 02:00 market time
                creates zero-balance accounting transactions instead of mutating
                balances.
              </p>
            </div>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Transaction Entry (Admin Testing Only)
              </h3>

              <form onSubmit={saveLedgerTransaction} className="grid gap-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <label className="grid gap-1">
                    <span className="font-medium">Account</span>
                    <select
                      value={ledgerForm.accountId}
                      onChange={(e) =>
                        setLedgerForm({
                          ...ledgerForm,
                          accountId: e.target.value,
                        })
                      }
                      className="rounded border p-2 text-gray-900"
                      required
                    >
                      <option value="">Select account</option>
                      {playerAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.displayName} ({account.username})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="font-medium">Category</span>
                    <select
                      value={ledgerForm.category}
                      onChange={(e) => {
                        const category = e.target.value as LedgerCategory;
                        const transactionTypes =
                          getTransactionTypesForCategory(category);

                        setLedgerForm({
                          ...ledgerForm,
                          category,
                          transactionType: transactionTypes[0],
                        });
                      }}
                      className="rounded border p-2 text-gray-900"
                    >
                      <option value="accounting">Accounting</option>
                      <option value="operational">Operational</option>
                      <option value="freeplay">Free Play</option>
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="font-medium">Transaction Type</span>
                    <select
                      value={ledgerForm.transactionType}
                      onChange={(e) =>
                        setLedgerForm({
                          ...ledgerForm,
                          transactionType: e.target.value as TransactionType,
                        })
                      }
                      className="rounded border p-2 text-gray-900"
                    >
                      {getTransactionTypesForCategory(ledgerForm.category).map(
                        (transactionType) => (
                          <option key={transactionType} value={transactionType}>
                            {getTransactionTypeLabel(transactionType)}
                          </option>
                        )
                      )}
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="font-medium">Amount</span>
                    <input
                      value={ledgerForm.amount}
                      onChange={(e) =>
                        setLedgerForm({
                          ...ledgerForm,
                          amount: e.target.value,
                        })
                      }
                      className="rounded border p-2 text-gray-900"
                      required
                    />
                  </label>

                  <label className="grid gap-1 md:col-span-2">
                    <span className="font-medium">Description</span>
                    <input
                      value={ledgerForm.description}
                      onChange={(e) =>
                        setLedgerForm({
                          ...ledgerForm,
                          description: e.target.value,
                        })
                      }
                      className="rounded border p-2 text-gray-900"
                      required
                    />
                  </label>

                  <label className="grid gap-1">
                    <span className="font-medium">Reference</span>
                    <input
                      value={ledgerForm.referenceId}
                      onChange={(e) =>
                        setLedgerForm({
                          ...ledgerForm,
                          referenceId: e.target.value,
                        })
                      }
                      className="rounded border p-2 text-gray-900"
                    />
                  </label>

                  <label className="grid gap-1">
                    <span className="font-medium">Created By</span>
                    <input
                      value={ledgerForm.createdBy}
                      onChange={(e) =>
                        setLedgerForm({
                          ...ledgerForm,
                          createdBy: e.target.value,
                        })
                      }
                      className="rounded border p-2 text-gray-900"
                    />
                  </label>
                </div>

                <div>
                  <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
                    Save Transaction
                  </button>
                </div>
              </form>
            </section>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Transaction History
              </h3>

              {ledgerTransactions.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No ledger transactions created yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-xs uppercase text-gray-500">
                      <tr>
                        <th className="py-2 pr-3">Date</th>
                        <th className="py-2 pr-3">Account</th>
                        <th className="py-2 pr-3">Category</th>
                        <th className="py-2 pr-3">Type</th>
                        <th className="py-2 pr-3">Description</th>
                        <th className="py-2 pr-3">Amount</th>
                        <th className="py-2 pr-3">Reference</th>
                        <th className="py-2 pr-3">Parent Transaction</th>
                        <th className="py-2 pr-3">Created By</th>
                        <th className="py-2 pr-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...ledgerTransactions]
                        .sort(
                          (a, b) =>
                            new Date(b.createdAt).getTime() -
                            new Date(a.createdAt).getTime()
                        )
                        .map((transaction) => {
                          const account = playerAccounts.find(
                            (createdAccount) =>
                              createdAccount.id === transaction.accountId
                          );
                          const hasReversal = ledgerTransactions.some(
                            (createdTransaction) =>
                              createdTransaction.parentTransactionId ===
                              transaction.id
                          );

                          return (
                            <tr key={transaction.id} className="border-b last:border-0">
                              <td className="py-2 pr-3">
                                {new Date(transaction.createdAt).toLocaleString()}
                              </td>
                              <td className="py-2 pr-3">
                                {account?.username || transaction.accountId}
                              </td>
                              <td className="py-2 pr-3">{transaction.category}</td>
                              <td className="py-2 pr-3">
                                {getTransactionTypeLabel(transaction.transactionType)}
                              </td>
                              <td className="py-2 pr-3">
                                {transaction.description}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(transaction.amount)}
                              </td>
                              <td className="py-2 pr-3">
                                {transaction.referenceId || ""}
                              </td>
                              <td className="py-2 pr-3">
                                {transaction.parentTransactionId || ""}
                              </td>
                              <td className="py-2 pr-3">
                                {transaction.createdBy || ""}
                              </td>
                              <td className="py-2 pr-3">
                                {transaction.transactionType !== "reversal" &&
                                  !hasReversal && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        reverseLedgerTransaction(transaction)
                                      }
                                      className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                                    >
                                      Reverse Transaction
                                    </button>
                                  )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">
                Statement Prototype
              </h3>

              {!selectedLedgerAccount ? (
                <p className="text-sm text-gray-500">
                  Select an account to view statement details.
                </p>
              ) : (
                <div className="grid gap-4">
                  <div className="rounded border bg-white p-3">
                    <p className="font-semibold text-gray-900">
                      {selectedLedgerAccount.displayName} (
                      {selectedLedgerAccount.username})
                    </p>
                    <p className="text-sm text-gray-500">
                      Free play wallet transactions are excluded from this normal
                      statement except freeplay wins.
                    </p>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b text-xs uppercase text-gray-500">
                        <tr>
                          <th className="py-2 pr-3">Date</th>
                          <th className="py-2 pr-3">Type</th>
                          <th className="py-2 pr-3">Description</th>
                          <th className="py-2 pr-3">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {getStatementTransactions(selectedLedgerAccount.id).map(
                          (transaction) => (
                            <tr key={transaction.id} className="border-b last:border-0">
                              <td className="py-2 pr-3">
                                {new Date(transaction.createdAt).toLocaleString()}
                              </td>
                              <td className="py-2 pr-3">
                                {getTransactionTypeLabel(transaction.transactionType)}
                              </td>
                              <td className="py-2 pr-3">
                                {transaction.description}
                              </td>
                              <td className="py-2 pr-3">
                                {formatMoney(transaction.amount)}
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>

                  {financialSummary && (
                    <div className="grid gap-2 rounded border bg-white p-3 text-sm sm:grid-cols-3">
                      <p>
                        <span className="font-semibold">Accounting:</span>{" "}
                        {formatMoney(financialSummary.accountingBalance)}
                      </p>
                      <p>
                        <span className="font-semibold">Weekly Figure:</span>{" "}
                        {formatMoney(financialSummary.weeklyFigure)}
                      </p>
                      <p>
                        <span className="font-semibold">Available Credit:</span>{" "}
                        {formatMoney(financialSummary.availableCredit)}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        );
      })()}
    </section>
  </>
)}
{activeTab === "accounts" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Accounts</h2>
        <button
          type="button"
          onClick={addSampleAgentHierarchy}
          className="rounded-md bg-purple-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-800"
        >
          Add Sample Agent Hierarchy
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,1fr)_minmax(360px,1.25fr)]">
        <div className="rounded border bg-gray-50 p-4">
          <div className="mb-4 grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-gray-900">Network Tree</h3>
              <button
                type="button"
                onClick={startCreateRootAccount}
                className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
              >
                Add House
              </button>
            </div>

            <input
              value={accountSearchTerm}
              onChange={(e) => setAccountSearchTerm(e.target.value)}
              placeholder="Search accounts"
              className="rounded border p-2 text-gray-900"
            />

            <select
              value={accountTreeFilter}
              onChange={(e) => setAccountTreeFilter(e.target.value)}
              className="rounded border p-2 text-gray-900"
            >
              <option value="all">All</option>
              <option value="super_master">Super Masters</option>
              <option value="master_agent">Master Agents</option>
              <option value="agent">Agents</option>
              <option value="player">Players</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          {getRootNetworkAccounts().filter((account) =>
            shouldShowAccountInTree(account)
          ).length === 0 ? (
            <p className="text-sm text-gray-500">No matching accounts.</p>
          ) : (
            <div className="grid gap-1">
              {getRootNetworkAccounts().map((account) =>
                renderNetworkTreeNode(account)
              )}
            </div>
          )}
        </div>

        <div className="rounded border bg-white p-4">
          {(() => {
            const selectedAccount = getSelectedAccount();
            const selectedMarket = markets.find(
              (market) => market.id === selectedAccount?.marketId
            );
            const childCount = selectedAccount
              ? getChildAccounts(selectedAccount.id).length
              : 0;
            const descendantCount = selectedAccount
              ? getDescendantAccountIds(selectedAccount.id).length
              : 0;
            const canCreateChildren =
              selectedAccount &&
              getAllowedChildAccountTypes(selectedAccount.accountType).length > 0;

            if (accountPanelMode) {
              return (
                <form onSubmit={savePlayerAccount} className="grid gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {accountPanelMode === "move"
                        ? "Move Account"
                        : accountPanelMode === "edit"
                          ? "Edit Account"
                          : "Create Account"}
                    </h3>
                    <p className="text-sm text-gray-500">
                      Network changes stay local until backend persistence is added.
                    </p>
                  </div>

                  {accountPanelMode !== "move" && (
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="grid gap-1">
                        <span className="font-medium">Account Type</span>
                        <select
                          value={playerAccountForm.accountType}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              accountType: e.target.value as AccountType,
                              parentId: "",
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                          required
                        >
                          <option value="super_master">House / Super Master</option>
                          <option value="master_agent">Master Agent</option>
                          <option value="agent">Agent</option>
                          <option value="player">Player</option>
                        </select>
                      </label>

                      {playerAccountForm.accountType !== "super_master" && (
                        <label className="grid gap-1">
                          <span className="font-medium">Parent Account</span>
                          <select
                            value={playerAccountForm.parentId}
                            onChange={(e) =>
                              setPlayerAccountForm({
                                ...playerAccountForm,
                                parentId: e.target.value,
                              })
                            }
                            className="rounded border p-2 text-gray-900"
                            required
                          >
                            <option value="">Select parent account</option>
                            {getParentOptionsForAccountType(
                              playerAccountForm.accountType
                            ).map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.displayName} ({account.username})
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      <label className="grid gap-1">
                        <span className="font-medium">Username</span>
                        <input
                          value={playerAccountForm.username}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              username: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                          required
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Display Name</span>
                        <input
                          value={playerAccountForm.displayName}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              displayName: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                          required
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Email</span>
                        <input
                          value={playerAccountForm.email}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              email: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Phone</span>
                        <input
                          value={playerAccountForm.phone}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              phone: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Market</span>
                        <select
                          value={playerAccountForm.marketId}
                          onChange={(e) => {
                            const market = markets.find(
                              (createdMarket) => createdMarket.id === e.target.value
                            );

                            setPlayerAccountForm({
                              ...playerAccountForm,
                              marketId: e.target.value,
                              language:
                                playerAccountForm.language || market?.language || "",
                              currency:
                                playerAccountForm.currency || market?.currency || "USD",
                            });
                          }}
                          className="rounded border p-2 text-gray-900"
                        >
                          <option value="">No market assigned</option>
                          {markets.map((market) => (
                            <option key={market.id} value={market.id}>
                              {market.name} ({market.code})
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Language</span>
                        <input
                          value={playerAccountForm.language}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              language: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Currency</span>
                        <input
                          value={playerAccountForm.currency}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              currency: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Status</span>
                        <select
                          value={playerAccountForm.status}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              status: e.target.value as AccountStatus,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        >
                          <option value="active">Active</option>
                          <option value="suspended">Suspended</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Cash Balance</span>
                        <input
                          value={playerAccountForm.cashBalance}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              cashBalance: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Credit Limit</span>
                        <input
                          value={playerAccountForm.creditLimit}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              creditLimit: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Current Exposure</span>
                        <input
                          value={playerAccountForm.currentExposure}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              currentExposure: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <div className="grid gap-1">
                        <span className="font-medium">Available Credit</span>
                        <div className="rounded border bg-gray-50 p-2 text-gray-900">
                          {Number(playerAccountForm.creditLimit || 0) -
                            Number(playerAccountForm.currentExposure || 0)}
                        </div>
                      </div>

                      <label className="grid gap-1">
                        <span className="font-medium">Max Bet</span>
                        <input
                          value={playerAccountForm.maxBet}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              maxBet: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>

                      <label className="grid gap-1">
                        <span className="font-medium">Max Payout</span>
                        <input
                          value={playerAccountForm.maxPayout}
                          onChange={(e) =>
                            setPlayerAccountForm({
                              ...playerAccountForm,
                              maxPayout: e.target.value,
                            })
                          }
                          className="rounded border p-2 text-gray-900"
                        />
                      </label>
                    </div>
                  )}

                  {accountPanelMode === "move" && (
                    <label className="grid gap-1">
                      <span className="font-medium">New Parent Account</span>
                      <select
                        value={playerAccountForm.parentId}
                        onChange={(e) =>
                          setPlayerAccountForm({
                            ...playerAccountForm,
                            parentId: e.target.value,
                          })
                        }
                        className="rounded border p-2 text-gray-900"
                        required
                      >
                        <option value="">Select parent account</option>
                        {getParentOptionsForAccountType(
                          playerAccountForm.accountType
                        ).map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.displayName} ({account.username})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {accountPanelMode !== "move" && (
                    <label className="grid gap-1">
                      <span className="font-medium">Notes</span>
                      <textarea
                        value={playerAccountForm.notes}
                        onChange={(e) =>
                          setPlayerAccountForm({
                            ...playerAccountForm,
                            notes: e.target.value,
                          })
                        }
                        className="rounded border p-2 text-gray-900"
                        rows={3}
                      />
                    </label>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
                      {accountPanelMode === "move"
                        ? "Move Account"
                        : accountPanelMode === "edit"
                          ? "Update Account"
                          : "Create Account"}
                    </button>
                    <button
                      type="button"
                      onClick={resetPlayerAccountForm}
                      className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              );
            }

            if (!selectedAccount) {
              return (
                <div className="grid gap-3 text-sm text-gray-600">
                  <h3 className="text-lg font-semibold text-gray-900">
                    Account Details
                  </h3>
                  <p>Select an account in the network tree to view details.</p>
                  <p>
                    Future Wallet Metrics: Balance, Exposure, Available Credit.
                  </p>
                  <p>Future Reporting: Weekly Handle, Open Tickets, Active Players.</p>
                </div>
              );
            }

            return (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold text-gray-900">
                      {selectedAccount.displayName}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {selectedAccount.username} |{" "}
                      {getAccountTypeLabel(selectedAccount.accountType)}
                    </p>
                  </div>
                  <span
                    className={`rounded px-2 py-1 text-xs font-semibold ${
                      selectedAccount.status === "active"
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-200 text-gray-700"
                    }`}
                  >
                    {selectedAccount.status}
                  </span>
                </div>

                <div className="grid gap-2 rounded border bg-gray-50 p-3 text-sm sm:grid-cols-2">
                  <p>
                    <span className="font-semibold">Direct Children:</span>{" "}
                    {childCount}
                  </p>
                  <p>
                    <span className="font-semibold">Descendants:</span>{" "}
                    {descendantCount}
                  </p>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <p><span className="font-semibold">Username:</span> {selectedAccount.username}</p>
                  <p><span className="font-semibold">Display Name:</span> {selectedAccount.displayName}</p>
                  <p><span className="font-semibold">Account Type:</span> {getAccountTypeLabel(selectedAccount.accountType)}</p>
                  <p><span className="font-semibold">Parent:</span> {getAccountDisplayName(selectedAccount.parentId) || "None"}</p>
                  <p><span className="font-semibold">Market:</span> {selectedMarket?.name || ""}</p>
                  <p><span className="font-semibold">Language:</span> {selectedAccount.language || ""}</p>
                  <p><span className="font-semibold">Currency:</span> {selectedAccount.currency || ""}</p>
                  <p><span className="font-semibold">Cash Balance:</span> {Number(selectedAccount.cashBalance || 0).toFixed(2)}</p>
                  <p><span className="font-semibold">Credit Limit:</span> {Number(selectedAccount.creditLimit || 0).toFixed(2)}</p>
                  <p><span className="font-semibold">Current Exposure:</span> {Number(selectedAccount.currentExposure || 0).toFixed(2)}</p>
                  <p><span className="font-semibold">Available Credit:</span> {Number(selectedAccount.availableCredit || 0).toFixed(2)}</p>
                  <p><span className="font-semibold">Max Bet:</span> {selectedAccount.maxBet ?? ""}</p>
                  <p><span className="font-semibold">Max Payout:</span> {selectedAccount.maxPayout ?? ""}</p>
                  <p className="sm:col-span-2"><span className="font-semibold">Notes:</span> {selectedAccount.notes || ""}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => startEditSelectedAccount(selectedAccount)}
                    className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
                  >
                    Edit
                  </button>
                  {selectedAccount.accountType !== "super_master" && (
                    <button
                      type="button"
                      onClick={() => startMoveSelectedAccount(selectedAccount)}
                      className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
                    >
                      Move
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => deletePlayerAccount(selectedAccount.id)}
                    className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-800"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleSelectedAccountStatus(selectedAccount)}
                    className="rounded-md bg-gray-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-800"
                  >
                    {selectedAccount.status === "active" ? "Deactivate" : "Activate"}
                  </button>
                </div>

                {canCreateChildren && (
                  <div className="border-t pt-4">
                    <p className="mb-2 text-sm font-semibold text-gray-700">
                      Add Downline
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {getAllowedChildAccountTypes(selectedAccount.accountType).map(
                        (accountType) => (
                          <button
                            key={accountType}
                            type="button"
                            onClick={() =>
                              startCreateChildAccount(selectedAccount, accountType)
                            }
                            className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-800"
                          >
                            Add {getAccountTypeLabel(accountType)}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      <form onSubmit={savePlayerAccount} className="hidden">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Account Type</span>
            <select
              value={playerAccountForm.accountType}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  accountType: e.target.value as AccountType,
                  parentId: "",
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            >
              <option value="super_master">House / Super Master</option>
              <option value="master_agent">Master Agent</option>
              <option value="agent">Agent</option>
              <option value="player">Player</option>
            </select>
          </label>

          {playerAccountForm.accountType !== "super_master" && (
            <label className="grid gap-1">
              <span className="font-medium">Parent Account</span>
              <select
                value={playerAccountForm.parentId}
                onChange={(e) =>
                  setPlayerAccountForm({
                    ...playerAccountForm,
                    parentId: e.target.value,
                  })
                }
                className="rounded border p-2 text-gray-900"
                required
              >
                <option value="">Select parent account</option>
                {getParentOptionsForAccountType(playerAccountForm.accountType).map(
                  (account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName} ({account.username})
                    </option>
                  )
                )}
              </select>
            </label>
          )}

          <label className="grid gap-1">
            <span className="font-medium">Username</span>
            <input
              value={playerAccountForm.username}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  username: e.target.value,
                })
              }
              placeholder="Example: agent1"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Display Name</span>
            <input
              value={playerAccountForm.displayName}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  displayName: e.target.value,
                })
              }
              placeholder="Example: Agent 1"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Email</span>
            <input
              value={playerAccountForm.email}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  email: e.target.value,
                })
              }
              placeholder="account@example.com"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Phone</span>
            <input
              value={playerAccountForm.phone}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  phone: e.target.value,
                })
              }
              placeholder="Optional"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Market</span>
            <select
              value={playerAccountForm.marketId}
              onChange={(e) => {
                const selectedMarket = markets.find(
                  (market) => market.id === e.target.value
                );

                setPlayerAccountForm({
                  ...playerAccountForm,
                  marketId: e.target.value,
                  language:
                    playerAccountForm.language || selectedMarket?.language || "",
                  currency:
                    playerAccountForm.currency || selectedMarket?.currency || "USD",
                });
              }}
              className="rounded border p-2 text-gray-900"
            >
              <option value="">No market assigned</option>
              {markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.name} ({market.code})
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Language</span>
            <input
              value={playerAccountForm.language}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  language: e.target.value,
                })
              }
              placeholder="Example: en"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Currency</span>
            <input
              value={playerAccountForm.currency}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  currency: e.target.value,
                })
              }
              placeholder="Example: USD"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Status</span>
            <select
              value={playerAccountForm.status}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  status: e.target.value as AccountStatus,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            >
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Cash Balance</span>
            <input
              value={playerAccountForm.cashBalance}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  cashBalance: e.target.value,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Credit Limit</span>
            <input
              value={playerAccountForm.creditLimit}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  creditLimit: e.target.value,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Current Exposure</span>
            <input
              value={playerAccountForm.currentExposure}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  currentExposure: e.target.value,
                })
              }
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Max Bet</span>
            <input
              value={playerAccountForm.maxBet}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  maxBet: e.target.value,
                })
              }
              placeholder="Optional"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Max Payout</span>
            <input
              value={playerAccountForm.maxPayout}
              onChange={(e) =>
                setPlayerAccountForm({
                  ...playerAccountForm,
                  maxPayout: e.target.value,
                })
              }
              placeholder="Optional"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <div className="grid gap-1">
            <span className="font-medium">Available Credit</span>
            <div className="rounded border bg-gray-50 p-2 text-gray-900">
              {Number(playerAccountForm.creditLimit || 0) -
                Number(playerAccountForm.currentExposure || 0)}
            </div>
          </div>
        </div>

        <label className="grid gap-1">
          <span className="font-medium">Notes</span>
          <textarea
            value={playerAccountForm.notes}
            onChange={(e) =>
              setPlayerAccountForm({
                ...playerAccountForm,
                notes: e.target.value,
              })
            }
            className="rounded border p-2 text-gray-900"
            rows={3}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {editingPlayerAccountId ? "Update Account" : "Create Account"}
          </button>
          <button
            type="button"
            onClick={resetPlayerAccountForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
          {editingPlayerAccountId && (
            <button
              type="button"
              onClick={resetPlayerAccountForm}
              className="rounded bg-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel Edit
            </button>
          )}
        </div>
      </form>

      <div className="hidden">
      {playerAccounts.length === 0 ? (
        <p className="text-sm text-gray-500">No accounts created yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-3">Username</th>
                <th className="py-2 pr-3">Display Name</th>
                <th className="py-2 pr-3">Account Type</th>
                <th className="py-2 pr-3">Parent</th>
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3">Currency</th>
                <th className="py-2 pr-3">Cash Balance</th>
                <th className="py-2 pr-3">Credit Limit</th>
                <th className="py-2 pr-3">Current Exposure</th>
                <th className="py-2 pr-3">Available Credit</th>
                <th className="py-2 pr-3">Status</th>
                <th className="min-w-[130px] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {playerAccounts.map((account) => {
                const market = markets.find(
                  (createdMarket) => createdMarket.id === account.marketId
                );

                return (
                  <tr key={account.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{account.username}</td>
                    <td className="py-2 pr-3">{account.displayName}</td>
                    <td className="py-2 pr-3">
                      {getAccountTypeLabel(account.accountType)}
                    </td>
                    <td className="py-2 pr-3">
                      {getParentAccount(account.id)
                        ? getAccountDisplayName(account.parentId)
                        : ""}
                    </td>
                    <td className="py-2 pr-3">{market?.name || ""}</td>
                    <td className="py-2 pr-3">{account.currency || ""}</td>
                    <td className="py-2 pr-3">
                      {Number(account.cashBalance || 0).toFixed(2)}
                    </td>
                    <td className="py-2 pr-3">
                      {Number(account.creditLimit || 0).toFixed(2)}
                    </td>
                    <td className="py-2 pr-3">
                      {Number(account.currentExposure || 0).toFixed(2)}
                    </td>
                    <td className="py-2 pr-3">
                      {Number(account.availableCredit || 0).toFixed(2)}
                    </td>
                    <td className="py-2 pr-3">{account.status}</td>
                    <td className="min-w-[130px] py-2 pr-3">
                      <div className="flex flex-nowrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => editPlayerAccount(account)}
                          className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deletePlayerAccount(account.id)}
                          className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </section>

    <section className="hidden">
      <h2 className="mb-4 text-xl font-semibold">Account Hierarchy</h2>

      {playerAccounts.filter(
        (account) => account.accountType === "super_master" || !account.parentId
      ).length === 0 ? (
        <p className="text-sm text-gray-500">No hierarchy to display yet.</p>
      ) : (
        <div className="grid gap-4">
          {playerAccounts
            .filter(
              (account) =>
                account.accountType === "super_master" || !account.parentId
            )
            .map((account) => renderAccountHierarchyNode(account))}
        </div>
      )}
    </section>
  </>
)}
{activeTab === "markets" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Markets</h2>
        <button
          type="button"
          onClick={addDefaultMarkets}
          className="rounded-md bg-purple-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-800"
        >
          Add Default Markets
        </button>
      </div>

      <form onSubmit={saveMarket} className="mb-6 grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Market Name</span>
            <input
              value={marketForm.name}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  name: e.target.value,
                })
              }
              placeholder="Example: Costa Rica"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Market Code</span>
            <input
              value={marketForm.code}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  code: e.target.value,
                })
              }
              placeholder="Example: CR"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Language</span>
            <input
              value={marketForm.language}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  language: e.target.value,
                })
              }
              placeholder="Example: es"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Currency</span>
            <input
              value={marketForm.currency}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  currency: e.target.value,
                })
              }
              placeholder="Example: USD"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Time Zone</span>
            <input
              value={marketForm.timeZone}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  timeZone: e.target.value,
                })
              }
              placeholder="Example: America/Costa_Rica"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Date Format</span>
            <input
              value={marketForm.dateFormat}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  dateFormat: e.target.value,
                })
              }
              placeholder="Example: DD/MM/YYYY"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Number Format</span>
            <input
              value={marketForm.numberFormat}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  numberFormat: e.target.value,
                })
              }
              placeholder="Example: es-CR"
              className="rounded border p-2 text-gray-900"
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Default Brand</span>
            <input
              value={marketForm.defaultBrand}
              onChange={(e) =>
                setMarketForm({
                  ...marketForm,
                  defaultBrand: e.target.value,
                })
              }
              placeholder="Example: Default"
              className="rounded border p-2 text-gray-900"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={marketForm.active}
            onChange={(e) =>
              setMarketForm({
                ...marketForm,
                active: e.target.checked,
              })
            }
          />
          Active
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {editingMarketId ? "Update Market" : "Create Market"}
          </button>
          <button
            type="button"
            onClick={resetMarketForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
          {editingMarketId && (
            <button
              type="button"
              onClick={resetMarketForm}
              className="rounded bg-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel Edit
            </button>
          )}
        </div>
      </form>

      {markets.length === 0 ? (
        <p className="text-sm text-gray-500">No markets created yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-3">Market Name</th>
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Language</th>
                <th className="py-2 pr-3">Currency</th>
                <th className="py-2 pr-3">Time Zone</th>
                <th className="py-2 pr-3">Default Brand</th>
                <th className="py-2 pr-3">Active</th>
                <th className="min-w-[130px] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((market) => (
                <tr key={market.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium">{market.name}</td>
                  <td className="py-2 pr-3">{market.code}</td>
                  <td className="py-2 pr-3">{market.language}</td>
                  <td className="py-2 pr-3">{market.currency}</td>
                  <td className="py-2 pr-3">{market.timeZone}</td>
                  <td className="py-2 pr-3">{market.defaultBrand}</td>
                  <td className="py-2 pr-3">
                    {market.active ? "Active" : "Inactive"}
                  </td>
                  <td className="min-w-[130px] py-2 pr-3">
                    <div className="flex flex-nowrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => editMarket(market)}
                        className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteMarket(market.id)}
                        className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </>
)}
{activeTab === "adminAccess" && (
  <>
    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Admin Roles</h2>
        <button
          type="button"
          onClick={addDefaultAdminRoles}
          className="rounded-md bg-purple-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-800"
        >
          Add Default Admin Roles
        </button>
      </div>

      <form onSubmit={saveAdminRole} className="mb-6 grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1">
            <span className="font-medium">Role Name</span>
            <input
              value={adminRoleForm.name}
              onChange={(e) =>
                setAdminRoleForm({
                  ...adminRoleForm,
                  name: e.target.value,
                })
              }
              placeholder="Example: Risk Manager"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Description</span>
            <input
              value={adminRoleForm.description}
              onChange={(e) =>
                setAdminRoleForm({
                  ...adminRoleForm,
                  description: e.target.value,
                })
              }
              placeholder="Short role purpose"
              className="rounded border p-2 text-gray-900"
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ADMIN_PERMISSION_GROUPS.map((group) => (
            <div key={group.name} className="rounded border bg-gray-50 p-4">
              <h3 className="mb-3 font-semibold text-gray-900">{group.name}</h3>
              <div className="grid gap-2">
                {group.permissions.map((permission) => (
                  <label
                    key={permission}
                    className="flex items-center gap-2 text-sm text-gray-700"
                  >
                    <input
                      type="checkbox"
                      checked={adminRoleForm.permissions.includes(permission)}
                      onChange={() => toggleAdminRolePermission(permission)}
                    />
                    {permission}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={adminRoleForm.active}
            onChange={(e) =>
              setAdminRoleForm({
                ...adminRoleForm,
                active: e.target.checked,
              })
            }
          />
          Active
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {editingAdminRoleId ? "Update Role" : "Save Role"}
          </button>
          <button
            type="button"
            onClick={resetAdminRoleForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
          {editingAdminRoleId && (
            <button
              type="button"
              onClick={resetAdminRoleForm}
              className="rounded bg-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel Edit
            </button>
          )}
        </div>
      </form>

      {adminRoles.length === 0 ? (
        <p className="text-sm text-gray-500">No admin roles created yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Description</th>
                <th className="py-2 pr-3">Permissions</th>
                <th className="py-2 pr-3">Active</th>
                <th className="min-w-[130px] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {adminRoles.map((role) => (
                <tr key={role.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium">{role.name}</td>
                  <td className="py-2 pr-3">{role.description}</td>
                  <td className="py-2 pr-3">{role.permissions.length}</td>
                  <td className="py-2 pr-3">
                    {role.active ? "Active" : "Inactive"}
                  </td>
                  <td className="min-w-[130px] py-2 pr-3">
                    <div className="flex flex-nowrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => editAdminRole(role)}
                        className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteAdminRole(role.id)}
                        className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section className="mt-8 rounded-xl bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-semibold">Admin Users</h2>

      <form onSubmit={saveAdminUser} className="mb-6 grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="font-medium">Name</span>
            <input
              value={adminUserForm.name}
              onChange={(e) =>
                setAdminUserForm({
                  ...adminUserForm,
                  name: e.target.value,
                })
              }
              placeholder="Example: Jane Operator"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Email</span>
            <input
              value={adminUserForm.email}
              onChange={(e) =>
                setAdminUserForm({
                  ...adminUserForm,
                  email: e.target.value,
                })
              }
              placeholder="admin@example.com"
              className="rounded border p-2 text-gray-900"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="font-medium">Status</span>
            <select
              value={adminUserForm.status}
              onChange={(e) =>
                setAdminUserForm({
                  ...adminUserForm,
                  status: e.target.value as AdminUser["status"],
                })
              }
              className="rounded border p-2 text-gray-900"
            >
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>

        <div className="rounded border bg-gray-50 p-4">
          <h3 className="mb-3 font-semibold text-gray-900">Assigned Roles</h3>
          {adminRoles.length === 0 ? (
            <p className="text-sm text-gray-500">
              Create admin roles before assigning users.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {adminRoles.map((role) => (
                <label
                  key={role.id}
                  className="flex items-center gap-2 text-sm text-gray-700"
                >
                  <input
                    type="checkbox"
                    checked={adminUserForm.roleIds.includes(role.id)}
                    onChange={() => toggleAdminUserRole(role.id)}
                  />
                  {role.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {editingAdminUserId ? "Update User" : "Save User"}
          </button>
          <button
            type="button"
            onClick={resetAdminUserForm}
            className="rounded bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Reset
          </button>
          {editingAdminUserId && (
            <button
              type="button"
              onClick={resetAdminUserForm}
              className="rounded bg-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-300"
            >
              Cancel Edit
            </button>
          )}
        </div>
      </form>

      {adminUsers.length === 0 ? (
        <p className="text-sm text-gray-500">No admin users created yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Assigned Roles</th>
                <th className="py-2 pr-3">Status</th>
                <th className="min-w-[130px] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {adminUsers.map((user) => {
                const assignedRoles = adminRoles
                  .filter((role) => user.roleIds.includes(role.id))
                  .map((role) => role.name)
                  .join(", ");

                return (
                  <tr key={user.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{user.name}</td>
                    <td className="py-2 pr-3">{user.email}</td>
                    <td className="py-2 pr-3">{assignedRoles}</td>
                    <td className="py-2 pr-3">{user.status}</td>
                    <td className="min-w-[130px] py-2 pr-3">
                      <div className="flex flex-nowrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => editAdminUser(user)}
                          className="rounded-md bg-slate-700 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteAdminUser(user.id)}
                          className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </>
)}
{activeTab === "utilities" && (
	<>
	        <section className="mt-8 rounded-xl bg-white p-6 shadow">
          <h2 className="mb-4 text-xl font-semibold">Admin Utilities</h2>

	          <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={generateDemoData}
            className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-800"
          >
            Generate Demo Data
          </button>

	          <button
	            onClick={exportLocalDataJSON}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Export Backup JSON
          </button>

          <label>
            <span className="inline-block cursor-pointer rounded-md bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800">
              Import Backup JSON
            </span>
            <input
              type="file"
              accept="application/json"
              onChange={importLocalDataJSON}
              className="hidden"
            />
          </label>

          <button
            onClick={clearAllLocalData}
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-800"
          >
            Clear All Data
          </button>
	          </div>
	        </section>
  </>
)}
	      </div>
	    </main>
  );
}
