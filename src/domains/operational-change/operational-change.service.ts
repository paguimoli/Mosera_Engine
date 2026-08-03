import type { OperationalCommandRecord } from "../operational-governance/operational-governance.types";
import {
  beginOperationalChange,
  claimOperationalChange,
  completeOperationalChange,
  recordMaintenanceEvent,
} from "./operational-change.repository";
import type {
  OperationalChangeType,
  OperationalChangeVerification,
} from "./operational-change.types";

export class OperationalChangeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OperationalChangeError";
  }
}

export async function executeOperationalChange<TResult>(input: {
  command: OperationalCommandRecord;
  changeType: OperationalChangeType;
  expectedState: Record<string, unknown>;
  executorIdentityId: string;
  execute: () => Promise<TResult>;
  verify: (result: TResult) => Promise<OperationalChangeVerification> | OperationalChangeVerification;
  maintenance?: { websiteId: string; action: "BEGIN" | "END"; reason: string };
}) {
  const change = await claimOperationalChange({
    commandId: input.command.commandId,
    changeType: input.changeType,
    idempotencyKey: `change:${input.command.idempotencyKey}`,
    expectedState: input.expectedState,
  });
  const attempt = await beginOperationalChange({ change, executorIdentityId: input.executorIdentityId });
  if (attempt === 0) {
    throw new OperationalChangeError("Verified operational change must be returned by command idempotency evidence.");
  }
  try {
    const result = await input.execute();
    const verification = await input.verify(result);
    const decision = await completeOperationalChange({ change, attempt, executorIdentityId: input.executorIdentityId,
      result, verification });
    if (decision !== "VERIFIED") {
      throw new OperationalChangeError("Operational change verification failed.");
    }
    if (input.maintenance) {
      await recordMaintenanceEvent({ change, actorIdentityId: input.executorIdentityId,
        ...input.maintenance });
    }
    return { change, result };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Operational change failed.";
    try {
      await completeOperationalChange({
        change, attempt, executorIdentityId: input.executorIdentityId, result: {},
        verification: { expectedStateReached: false, authorityAccepted: false,
          readinessMaintained: false, auditRecorded: true,
          observedState: { status: "FAILED", failureReason } },
        failureCode: error instanceof Error ? error.name : "UNKNOWN_FAILURE", failureReason,
      });
    } catch {
      // The canonical completion function fails closed after appending failure evidence.
    }
    throw new OperationalChangeError(failureReason, error);
  }
}
