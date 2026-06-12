import type { LedgerTransaction } from "../ledger/ledger.types";
import type { Ticket, TicketLine } from "../tickets/ticket.types";
import { attachIntegrityHash } from "../integrity/integrity.helpers";
import type { SettlementRecord } from "./settlement.types";

export type SettlementLedgerPostingResult = {
  settlementRecord: SettlementRecord;
  ledgerTransactions: LedgerTransaction[];
};

function buildSettlementLedgerTransaction({
  settlementRecord,
  ticket,
  ticketLine,
  transactionType,
  amount,
  description,
  index,
}: {
  settlementRecord: SettlementRecord;
  ticket: Ticket;
  ticketLine: TicketLine;
  transactionType: LedgerTransaction["transactionType"];
  amount: number;
  description: string;
  index: number;
}): LedgerTransaction {
  const id = `LEDGER-${settlementRecord.id}-${ticketLine.id}-${transactionType}-${index}`;

  return attachIntegrityHash({
    id,
    accountId: settlementRecord.accountId,
    category: "operational",
    transactionType,
    walletType: ticket.fundingType,
    amount,
    description,
    referenceId: settlementRecord.id,
    parentTransactionId: null,
    createdBy: "settlement",
    createdAt: new Date().toISOString(),
  }, "ledger_transaction", id);
}

function hasPostedSettlementLedger(settlementRecord: SettlementRecord) {
  return settlementRecord.ledgerTransactionIds.length > 0;
}

function findExistingLedgerTransaction({
  transactions,
  settlementRecord,
  ticketLine,
  transactionType,
}: {
  transactions: LedgerTransaction[];
  settlementRecord: SettlementRecord;
  ticketLine: TicketLine;
  transactionType: LedgerTransaction["transactionType"];
}) {
  return transactions.find(
    (transaction) =>
      transaction.referenceId === settlementRecord.id &&
      transaction.transactionType === transactionType &&
      transaction.id.includes(ticketLine.id)
  );
}

function getLedgerIdsForSettlementRecord({
  settlementRecord,
  ticketLine,
  existingLedgerTransactions,
  newLedgerTransactions,
}: {
  settlementRecord: SettlementRecord;
  ticketLine: TicketLine;
  existingLedgerTransactions: LedgerTransaction[];
  newLedgerTransactions: LedgerTransaction[];
}) {
  return [...existingLedgerTransactions, ...newLedgerTransactions]
    .filter(
      (transaction) =>
        transaction.referenceId === settlementRecord.id &&
        transaction.id.includes(ticketLine.id)
    )
    .map((transaction) => transaction.id);
}

export function createLedgerTransactionsForSettlementRecord({
  settlementRecord,
  ticket,
  ticketLine,
  existingLedgerTransactions = [],
}: {
  settlementRecord: SettlementRecord;
  ticket: Ticket;
  ticketLine: TicketLine;
  existingLedgerTransactions?: LedgerTransaction[];
}): SettlementLedgerPostingResult {
  if (hasPostedSettlementLedger(settlementRecord)) {
    return {
      settlementRecord,
      ledgerTransactions: [],
    };
  }

  const ledgerTransactions: LedgerTransaction[] = [];
  const ticketLabel = ticket.ticketNumber || ticket.id;
  const isFreeplay = ticket.fundingType === "freeplay";

  if (settlementRecord.outcome === "push") {
    // TODO: define push/refund behavior if a future ruleset requires it.
    return { settlementRecord, ledgerTransactions };
  }

  if (
    settlementRecord.outcome === "void" ||
    settlementRecord.outcome === "failed"
  ) {
    return { settlementRecord, ledgerTransactions };
  }

  if (isFreeplay) {
    if (
      settlementRecord.outcome === "win" &&
      !findExistingLedgerTransaction({
        transactions: existingLedgerTransactions,
        settlementRecord,
        ticketLine,
        transactionType: "freeplay_win",
      })
    ) {
      ledgerTransactions.push(
        buildSettlementLedgerTransaction({
          settlementRecord,
          ticket,
          ticketLine,
          transactionType: "freeplay_win",
          amount: Number(settlementRecord.payout || 0),
          description: `Freeplay win for ticket ${ticketLabel}, line ${ticketLine.id}`,
          index: ledgerTransactions.length,
        })
      );
    }

    return {
      settlementRecord: attachIntegrityHash({
        ...settlementRecord,
        ledgerTransactionIds: getLedgerIdsForSettlementRecord({
          settlementRecord,
          ticketLine,
          existingLedgerTransactions,
          newLedgerTransactions: ledgerTransactions,
        }),
      }, "settlement_record", settlementRecord.id, settlementRecord.previousHash || null),
      ledgerTransactions,
    };
  }

  if (
    (settlementRecord.outcome === "win" ||
      settlementRecord.outcome === "loss") &&
    !findExistingLedgerTransaction({
      transactions: existingLedgerTransactions,
      settlementRecord,
      ticketLine,
      transactionType: "bet_stake",
    })
  ) {
    ledgerTransactions.push(
      buildSettlementLedgerTransaction({
        settlementRecord,
        ticket,
        ticketLine,
        transactionType: "bet_stake",
        amount: -Number(settlementRecord.stake || 0),
        description: `Stake for ticket ${ticketLabel}, line ${ticketLine.id}`,
        index: ledgerTransactions.length,
      })
    );
  }

  if (
    settlementRecord.outcome === "win" &&
    !findExistingLedgerTransaction({
      transactions: existingLedgerTransactions,
      settlementRecord,
      ticketLine,
      transactionType: "bet_win",
    })
  ) {
    ledgerTransactions.push(
      buildSettlementLedgerTransaction({
        settlementRecord,
        ticket,
        ticketLine,
        transactionType: "bet_win",
        amount: Number(settlementRecord.payout || 0),
        description: `Win payout for ticket ${ticketLabel}, line ${ticketLine.id}`,
        index: ledgerTransactions.length,
      })
    );
  }

  // TODO: add a database unique constraint on
  // settlementRecord.id + transactionType + ticketLine.id.
  return {
    settlementRecord: attachIntegrityHash({
      ...settlementRecord,
      ledgerTransactionIds: getLedgerIdsForSettlementRecord({
        settlementRecord,
        ticketLine,
        existingLedgerTransactions,
        newLedgerTransactions: ledgerTransactions,
      }),
    }, "settlement_record", settlementRecord.id, settlementRecord.previousHash || null),
    ledgerTransactions,
  };
}

export function createLedgerTransactionsForSettlementRecords({
  settlementRecords,
  tickets,
  ticketLines,
  existingLedgerTransactions = [],
}: {
  settlementRecords: SettlementRecord[];
  tickets: Ticket[];
  ticketLines: TicketLine[];
  existingLedgerTransactions?: LedgerTransaction[];
}) {
  const postedRecords: SettlementRecord[] = [];
  const ledgerTransactions: LedgerTransaction[] = [];

  for (const settlementRecord of settlementRecords) {
    const ticket = tickets.find(
      (createdTicket) => createdTicket.id === settlementRecord.ticketId
    );
    const ticketLine = ticketLines.find(
      (createdLine) => createdLine.id === settlementRecord.ticketLineId
    );

    if (!ticket || !ticketLine) {
      postedRecords.push(settlementRecord);
      continue;
    }

    const posting = createLedgerTransactionsForSettlementRecord({
      settlementRecord,
      ticket,
      ticketLine,
      existingLedgerTransactions: [
        ...existingLedgerTransactions,
        ...ledgerTransactions,
      ],
    });

    postedRecords.push(posting.settlementRecord);
    ledgerTransactions.push(...posting.ledgerTransactions);
  }

  return {
    settlementRecords: postedRecords,
    ledgerTransactions,
  };
}
