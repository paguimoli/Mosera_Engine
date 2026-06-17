import { getPlayerCreditSummary } from "../credit/credit-reservation.service";
import {
  completeReconciliationRun,
  createReconciliationFindings,
  createReconciliationRun,
  findReconciliationRunById,
  listCommissionRunDetails,
  listCreditReservations,
  listCreditSettlementApplications,
  listRecentReconciliationRuns,
  listReconciliationFindings,
  listTicketsSafely,
  listWeeklyAccountingSnapshots,
  recordReconciliationOutboxEvent,
} from "./reconciliation.repository";
import type {
  CreateReconciliationFindingInput,
  ListReconciliationFindingsInput,
  ReconciliationFinding,
  ReconciliationRun,
  RunReconciliationInput,
} from "./reconciliation.types";
import {
  validateListReconciliationFindingsInput,
  validateRunReconciliationInput,
} from "./reconciliation.validation";

export class ReconciliationValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "ReconciliationValidationError";
    this.errors = errors;
  }
}

export class ReconciliationBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationBusinessRuleError";
  }
}

function toAmount(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function groupSum<T>(
  rows: T[],
  getKey: (row: T) => string,
  getAmount: (row: T) => number
) {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const key = getKey(row);
    totals.set(key, (totals.get(key) ?? 0) + getAmount(row));
  }

  return totals;
}

function passFinding(input: Omit<CreateReconciliationFindingInput, "severity">) {
  return { ...input, severity: "PASS" as const };
}

function warningFinding(
  input: Omit<CreateReconciliationFindingInput, "severity">
) {
  return { ...input, severity: "WARNING" as const };
}

function failFinding(input: Omit<CreateReconciliationFindingInput, "severity">) {
  return { ...input, severity: "FAIL" as const };
}

function filterByWeek<T extends { created_at?: string; week_start?: string; week_end?: string }>(
  rows: T[],
  input: RunReconciliationInput
) {
  if (!input.weekStart || !input.weekEnd) {
    return rows;
  }

  const startMs = new Date(input.weekStart).getTime();
  const endMs = new Date(input.weekEnd).getTime();

  return rows.filter((row) => {
    const timestamp = row.created_at ?? row.week_start;
    const rowMs = timestamp ? new Date(timestamp).getTime() : Number.NaN;

    if (Number.isNaN(rowMs)) {
      return row.week_start === input.weekStart && row.week_end === input.weekEnd;
    }

    return rowMs >= startMs && rowMs < endMs;
  });
}

function filterByCurrency<T extends { currency?: string | null }>(
  rows: T[],
  input: RunReconciliationInput
) {
  if (!input.currency) {
    return rows;
  }

  return rows.filter((row) => row.currency === input.currency);
}

async function runCreditExposureChecks(
  input: RunReconciliationInput
): Promise<CreateReconciliationFindingInput[]> {
  const reservations = filterByCurrency(await listCreditReservations(), input);
  const activeReservations = reservations.filter((reservation) =>
    ["RESERVED", "PARTIALLY_RELEASED"].includes(reservation.status)
  );
  const pendingByPlayerCurrency = groupSum(
    activeReservations,
    (reservation) => `${reservation.player_id}:${reservation.currency}`,
    (reservation) => toAmount(reservation.remaining_exposure)
  );
  const findings: CreateReconciliationFindingInput[] = [];

  if (pendingByPlayerCurrency.size === 0) {
    findings.push(
      passFinding({
        checkCode: "CREDIT_PENDING_EXPOSURE",
        entityType: "credit_reservations",
        entityId: "none",
        message: "No active credit exposure found.",
        metadata: {},
      })
    );
  }

  for (const [key, pendingExposure] of pendingByPlayerCurrency.entries()) {
    const [playerId, currency] = key.split(":");
    const summary = await getPlayerCreditSummary(playerId);
    const findingInput = {
      checkCode: "CREDIT_PENDING_EXPOSURE",
      entityType: "account",
      entityId: playerId,
      expectedAmount: pendingExposure,
      actualAmount: summary.pendingExposure,
      currency,
      metadata: {
        availableCredit: summary.availableCredit,
        creditLimit: summary.creditLimit,
        balance: summary.balance,
      },
    };

    findings.push(
      pendingExposure === summary.pendingExposure
        ? passFinding({
            ...findingInput,
            message: "Pending exposure matches credit summary.",
          })
        : failFinding({
            ...findingInput,
            message: "Pending exposure does not match credit summary.",
          })
    );
  }

  return findings;
}

async function runReservationSettlementChecks(
  input: RunReconciliationInput
): Promise<CreateReconciliationFindingInput[]> {
  const reservations = filterByCurrency(await listCreditReservations(), input);

  return reservations
    .filter(
      (reservation) =>
        toAmount(reservation.released_amount) > 0 ||
        reservation.status === "PARTIALLY_RELEASED" ||
        reservation.status === "RELEASED" ||
        reservation.status === "SETTLED"
    )
    .map((reservation) => {
      const expected = toAmount(reservation.reserved_amount);
      const actual =
        toAmount(reservation.released_amount) +
        toAmount(reservation.remaining_exposure);
      const base = {
        checkCode: "RESERVATION_RELEASE_BALANCE",
        entityType: "credit_reservation",
        entityId: reservation.id,
        expectedAmount: expected,
        actualAmount: actual,
        currency: reservation.currency,
        metadata: {
          ticketId: reservation.ticket_id,
          status: reservation.status,
        },
      };

      return expected === actual
        ? passFinding({
            ...base,
            message: "Reservation release and remaining exposure reconcile.",
          })
        : failFinding({
            ...base,
            message: "Reservation release and remaining exposure do not reconcile.",
          });
    });
}

async function runTicketReservationChecks(): Promise<
  CreateReconciliationFindingInput[]
> {
  const [{ rows: tickets, unavailableReason }, reservations] = await Promise.all([
    listTicketsSafely(),
    listCreditReservations(),
  ]);

  if (unavailableReason) {
    return [
      warningFinding({
        checkCode: "TICKET_RESERVATION_LINK",
        entityType: "tickets",
        entityId: "unavailable",
        message: "Ticket table is unavailable for reconciliation.",
        metadata: { reason: unavailableReason },
      }),
    ];
  }

  const reservationsById = new Map(reservations.map((row) => [row.id, row]));
  const findings: CreateReconciliationFindingInput[] = [];

  for (const ticket of tickets) {
    if (!ticket.credit_reservation_id) {
      findings.push(
        failFinding({
          checkCode: "TICKET_RESERVATION_LINK",
          entityType: "ticket",
          entityId: ticket.id,
          expectedAmount: toAmount(ticket.total_amount),
          actualAmount: null,
          currency: ticket.currency ?? null,
          message: "Credit-backed ticket is missing reservation id.",
          metadata: { status: ticket.status ?? null },
        })
      );
      continue;
    }

    const reservation = reservationsById.get(ticket.credit_reservation_id);
    const matchesTicket = reservation?.ticket_id === ticket.id;

    findings.push(
      reservation && matchesTicket
        ? passFinding({
            checkCode: "TICKET_RESERVATION_LINK",
            entityType: "ticket",
            entityId: ticket.id,
            currency: ticket.currency ?? reservation.currency,
            message: "Ticket reservation link is valid.",
            metadata: { reservationId: ticket.credit_reservation_id },
          })
        : failFinding({
            checkCode: "TICKET_RESERVATION_LINK",
            entityType: "ticket",
            entityId: ticket.id,
            currency: ticket.currency ?? null,
            message: "Ticket reservation link is invalid.",
            metadata: {
              reservationId: ticket.credit_reservation_id,
              reservationTicketId: reservation?.ticket_id ?? null,
            },
          })
    );
  }

  return findings.length > 0
    ? findings
    : [
        passFinding({
          checkCode: "TICKET_RESERVATION_LINK",
          entityType: "tickets",
          entityId: "none",
          message: "No credit-backed tickets found.",
          metadata: {},
        }),
      ];
}

async function runSettlementApplicationChecks(): Promise<
  CreateReconciliationFindingInput[]
> {
  const [{ rows: tickets, unavailableReason }, applications] = await Promise.all([
    listTicketsSafely(),
    listCreditSettlementApplications(),
  ]);

  if (unavailableReason) {
    return [
      warningFinding({
        checkCode: "SETTLEMENT_APPLICATION_EXISTS",
        entityType: "tickets",
        entityId: "unavailable",
        message: "Ticket table is unavailable for settlement reconciliation.",
        metadata: { reason: unavailableReason },
      }),
    ];
  }

  const applicationsByTicketId = new Map(
    applications.map((application) => [application.ticket_id, application])
  );
  const settledCreditTickets = tickets.filter(
    (ticket) =>
      ticket.credit_reservation_id &&
      (ticket.status === "settled" || ticket.status === "SETTLED")
  );

  if (settledCreditTickets.length === 0) {
    return [
      passFinding({
        checkCode: "SETTLEMENT_APPLICATION_EXISTS",
        entityType: "tickets",
        entityId: "none",
        message: "No settled credit tickets found.",
        metadata: {},
      }),
    ];
  }

  return settledCreditTickets.map((ticket) => {
    const application = applicationsByTicketId.get(ticket.id);

    return application
      ? passFinding({
          checkCode: "SETTLEMENT_APPLICATION_EXISTS",
          entityType: "ticket",
          entityId: ticket.id,
          currency: ticket.currency ?? application.currency,
          message: "Settled credit ticket has settlement application.",
          metadata: {
            reservationId: ticket.credit_reservation_id,
            applicationId: application.id,
          },
        })
      : failFinding({
          checkCode: "SETTLEMENT_APPLICATION_EXISTS",
          entityType: "ticket",
          entityId: ticket.id,
          currency: ticket.currency ?? null,
          message: "Settled credit ticket is missing settlement application.",
          metadata: { reservationId: ticket.credit_reservation_id },
        });
  });
}

async function runWeeklyAccountingChecks(
  input: RunReconciliationInput
): Promise<CreateReconciliationFindingInput[]> {
  const snapshots = filterByCurrency(
    filterByWeek(await listWeeklyAccountingSnapshots(), input),
    input
  );
  const applications = filterByCurrency(
    filterByWeek(await listCreditSettlementApplications(), input),
    input
  );
  const applicationTotals = groupSum(
    applications,
    (application) => `${application.player_id}:${application.currency}`,
    (application) => toAmount(application.balance_impact)
  );
  const playerSnapshots = snapshots.filter(
    (snapshot) => snapshot.account_type === "PLAYER"
  );

  if (playerSnapshots.length === 0) {
    return [
      warningFinding({
        checkCode: "WEEKLY_ACCOUNTING_NET_RESULT",
        entityType: "weekly_accounting_snapshots",
        entityId: "none",
        message: "No player weekly accounting snapshots found.",
        metadata: {
          weekStart: input.weekStart ?? null,
          weekEnd: input.weekEnd ?? null,
        },
      }),
    ];
  }

  return playerSnapshots.map((snapshot) => {
    const expected = applicationTotals.get(
      `${snapshot.account_id}:${snapshot.currency}`
    ) ?? 0;
    const actual = toAmount(snapshot.net_result);
    const base = {
      checkCode: "WEEKLY_ACCOUNTING_NET_RESULT",
      entityType: "weekly_accounting_snapshot",
      entityId: snapshot.id,
      expectedAmount: expected,
      actualAmount: actual,
      currency: snapshot.currency,
      metadata: {
        accountId: snapshot.account_id,
        weekStart: snapshot.week_start,
        weekEnd: snapshot.week_end,
      },
    };

    return expected === actual
      ? passFinding({
          ...base,
          message: "Weekly accounting net result matches settlement applications.",
        })
      : failFinding({
          ...base,
          message:
            "Weekly accounting net result does not match settlement applications.",
        });
  });
}

async function runCommissionChecks(): Promise<CreateReconciliationFindingInput[]> {
  const [details, snapshots] = await Promise.all([
    listCommissionRunDetails(),
    listWeeklyAccountingSnapshots(),
  ]);
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

  if (details.length === 0) {
    return [
      warningFinding({
        checkCode: "COMMISSION_DETAIL_SNAPSHOT",
        entityType: "commission_run_details",
        entityId: "none",
        message: "No commission run details found.",
        metadata: {},
      }),
    ];
  }

  return details.flatMap((detail) => {
    const snapshot = snapshotsById.get(detail.snapshot_id);
    const findings: CreateReconciliationFindingInput[] = [];

    if (!snapshot) {
      findings.push(
        failFinding({
          checkCode: "COMMISSION_DETAIL_SNAPSHOT",
          entityType: "commission_run_detail",
          entityId: detail.id,
          message: "Commission detail references a missing weekly snapshot.",
          metadata: { snapshotId: detail.snapshot_id },
        })
      );
      return findings;
    }

    findings.push(
      passFinding({
        checkCode: "COMMISSION_DETAIL_SNAPSHOT",
        entityType: "commission_run_detail",
        entityId: detail.id,
        currency: snapshot.currency,
        message: "Commission detail references an existing weekly snapshot.",
        metadata: { snapshotId: detail.snapshot_id },
      })
    );

    const basis =
      toAmount(detail.net_result) < 0 ? Math.abs(toAmount(detail.net_result)) : 0;
    const expectedCommission = Math.floor(
      (basis * detail.commission_percentage_basis_points) / 10000
    );
    const actualCommission = toAmount(detail.commission_amount);

    findings.push(
      expectedCommission === actualCommission
        ? passFinding({
            checkCode: "COMMISSION_AMOUNT_FORMULA",
            entityType: "commission_run_detail",
            entityId: detail.id,
            expectedAmount: expectedCommission,
            actualAmount: actualCommission,
            currency: snapshot.currency,
            message: "Commission amount matches loss-based percentage formula.",
            metadata: {
              netResult: detail.net_result,
              basisPoints: detail.commission_percentage_basis_points,
            },
          })
        : failFinding({
            checkCode: "COMMISSION_AMOUNT_FORMULA",
            entityType: "commission_run_detail",
            entityId: detail.id,
            expectedAmount: expectedCommission,
            actualAmount: actualCommission,
            currency: snapshot.currency,
            message:
              "Commission amount does not match loss-based percentage formula.",
            metadata: {
              netResult: detail.net_result,
              basisPoints: detail.commission_percentage_basis_points,
            },
          })
    );

    return findings;
  });
}

async function collectFindings(input: RunReconciliationInput) {
  const groups: Promise<CreateReconciliationFindingInput[]>[] = [];

  if (input.runType === "CREDIT" || input.runType === "FULL") {
    groups.push(runCreditExposureChecks(input), runReservationSettlementChecks(input));
  }

  if (input.runType === "SETTLEMENT" || input.runType === "FULL") {
    groups.push(runTicketReservationChecks(), runSettlementApplicationChecks());
  }

  if (input.runType === "ACCOUNTING" || input.runType === "FULL") {
    groups.push(runWeeklyAccountingChecks(input));
  }

  if (input.runType === "COMMISSION" || input.runType === "FULL") {
    groups.push(runCommissionChecks());
  }

  return (await Promise.all(groups)).flat();
}

export async function runReconciliation(
  input: RunReconciliationInput
): Promise<{ run: ReconciliationRun; findings: ReconciliationFinding[] }> {
  const normalized: RunReconciliationInput = {
    ...input,
    runType: input.runType,
    scopeType: input.scopeType,
    currency: input.currency?.trim().toUpperCase() || null,
    scopeId: input.scopeId || null,
    weekStart: input.weekStart || null,
    weekEnd: input.weekEnd || null,
  };
  const validation = validateRunReconciliationInput(normalized);

  if (!validation.valid) {
    throw new ReconciliationValidationError(validation.errors);
  }

  const startedRun = await createReconciliationRun(normalized);

  try {
    const findingInputs = await collectFindings(normalized);
    const persistedFindings = await createReconciliationFindings(
      startedRun.id,
      findingInputs
    );
    const completedRun = await completeReconciliationRun({
      runId: startedRun.id,
      status: "COMPLETED",
      findings: findingInputs,
    });

    await recordReconciliationOutboxEvent({
      eventType: "reconciliation.run.completed",
      aggregateId: completedRun.id,
      correlationId: normalized.correlationId,
      payload: {
        runId: completedRun.id,
        runType: completedRun.runType,
        totalChecks: completedRun.totalChecks,
        passedChecks: completedRun.passedChecks,
        failedChecks: completedRun.failedChecks,
        warningChecks: completedRun.warningChecks,
      },
    });

    for (const finding of persistedFindings) {
      if (finding.severity === "FAIL" || finding.severity === "WARNING") {
        await recordReconciliationOutboxEvent({
          eventType: "reconciliation.finding.created",
          aggregateId: completedRun.id,
          correlationId: normalized.correlationId,
          payload: {
            runId: completedRun.id,
            findingId: finding.id,
            severity: finding.severity,
            checkCode: finding.checkCode,
            entityType: finding.entityType,
            entityId: finding.entityId,
          },
        });
      }
    }

    return {
      run: completedRun,
      findings: persistedFindings,
    };
  } catch (error) {
    const failureFinding = failFinding({
      checkCode: "RECONCILIATION_RUN_ERROR",
      entityType: "reconciliation_run",
      entityId: startedRun.id,
      message:
        error instanceof Error
          ? error.message
          : "Reconciliation run failed unexpectedly.",
      metadata: {},
    });

    const persistedFindings = await createReconciliationFindings(startedRun.id, [
      failureFinding,
    ]);
    const failedRun = await completeReconciliationRun({
      runId: startedRun.id,
      status: "FAILED",
      findings: [failureFinding],
    });

    await recordReconciliationOutboxEvent({
      eventType: "reconciliation.run.failed",
      aggregateId: failedRun.id,
      correlationId: normalized.correlationId,
      payload: {
        runId: failedRun.id,
        runType: failedRun.runType,
        error: failureFinding.message,
      },
    });

    return {
      run: failedRun,
      findings: persistedFindings,
    };
  }
}

export async function getReconciliationRun(runId: string): Promise<{
  run: ReconciliationRun;
  findings: ReconciliationFinding[];
}> {
  if (!runId) {
    throw new ReconciliationValidationError(["Reconciliation run id is required."]);
  }

  const run = await findReconciliationRunById(runId);

  if (!run) {
    throw new ReconciliationBusinessRuleError("Reconciliation run not found.");
  }

  return {
    run,
    findings: await listReconciliationFindings({ runId, limit: 500 }),
  };
}

export async function getReconciliationFindings(
  input: ListReconciliationFindingsInput
): Promise<ReconciliationFinding[]> {
  const validation = validateListReconciliationFindingsInput(input);

  if (!validation.valid) {
    throw new ReconciliationValidationError(validation.errors);
  }

  return listReconciliationFindings(input);
}

export async function getReconciliationSummary() {
  const runs = await listRecentReconciliationRuns(20);

  return {
    runs,
    latestRun: runs[0] ?? null,
    totalRuns: runs.length,
    latestFailedChecks: runs[0]?.failedChecks ?? 0,
    latestWarningChecks: runs[0]?.warningChecks ?? 0,
  };
}
