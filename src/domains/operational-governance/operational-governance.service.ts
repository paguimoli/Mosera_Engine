import type { AuthContext } from "../auth/auth-context.types";
import {
  appendExecutionEvidence,
  appendOperationalApproval,
  appendOperationalEvent,
  authorizeOperationalCommand as authorizeApprovalPolicy,
  canonicalHash,
  claimOperationalCommand,
  findSuccessfulOperationalResult,
  withOperationalExecutionLock,
} from "./operational-governance.repository";
import type {
  GovernedOperationResult,
  OperationalCommandRequest,
} from "./operational-governance.types";
import {
  authorizeOperationalCommandSecurity,
  resolvePrivilegedSessionId,
} from "../operational-security/operational-security.service";
import { executeOperationalChange } from "../operational-change/operational-change.service";
import type {
  OperationalChangeType,
  OperationalChangeVerification,
} from "../operational-change/operational-change.types";
import { randomUUID } from "node:crypto";

export class OperationalGovernanceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OperationalGovernanceError";
  }
}

export function resolveOperationalRequestMetadata(
  request: Request,
  body: Record<string, unknown>,
  commandType: string,
  defaultReason: string
) {
  const bodyCorrelation =
    typeof body.correlationId === "string" ? body.correlationId.trim() : "";
  const correlationId =
    request.headers.get("x-correlation-id")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    bodyCorrelation ||
    randomUUID();
  const reasonCandidate =
    typeof body.reason === "string"
      ? body.reason
      : typeof body.justification === "string"
        ? body.justification
        : defaultReason;
  const reason = reasonCandidate.trim() || defaultReason;
  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    request.headers.get("x-idempotency-key")?.trim() ||
    `${commandType}:${correlationId}`;

  return {
    correlationId,
    idempotencyKey,
    reason,
    privilegedSessionId: resolvePrivilegedSessionId(request),
  };
}

export function canonicalScopeSnapshot(authContext: AuthContext) {
  return {
    platformScopes: [...(authContext.platformScopes ?? [])]
      .map((scope) => ({ scopeType: scope.scopeType, scopeId: scope.scopeId }))
      .sort((left, right) =>
        `${left.scopeType}:${left.scopeId}`.localeCompare(`${right.scopeType}:${right.scopeId}`)
      ),
  };
}

export async function executeGovernedOperation<
  TPayload extends Record<string, unknown>,
  TResult,
>(
  request: OperationalCommandRequest<TPayload>,
  execute: () => Promise<TResult>,
  change?: {
    changeType: OperationalChangeType;
    expectedState: Record<string, unknown>;
    verify: (result: TResult) => Promise<OperationalChangeVerification> | OperationalChangeVerification;
    maintenance?: { websiteId: string; action: "BEGIN" | "END"; reason: string };
  }
): Promise<GovernedOperationResult<TResult>> {
  const canonicalRequestHash = canonicalHash({
    commandType: request.commandType,
    affectedAuthority: request.affectedAuthority,
    targetType: request.targetType,
    targetId: request.targetId,
    reason: request.reason,
    correlationId: request.correlationId,
    causationId: request.causationId ?? null,
    scope: canonicalScopeSnapshot(request.authContext),
    payload: request.payload,
  });

  let command;
  try {
    command = await claimOperationalCommand({
      ...request,
      canonicalRequestHash,
      scopeSnapshot: canonicalScopeSnapshot(request.authContext),
    });
  } catch (error) {
    throw new OperationalGovernanceError(
      error instanceof Error ? error.message : "Operational command authorization failed.",
      error
    );
  }

  return withOperationalExecutionLock(command.commandId, async () => {
    const existing = await findSuccessfulOperationalResult<TResult>(command.commandId);
    if (existing !== null) return { command, result: existing, idempotent: true };

    await authorizeOperationalCommandSecurity({
      commandId: command.commandId,
      authContext: request.authContext,
      privilegedSessionId: request.privilegedSessionId,
    });
    await authorizeApprovalPolicy(command.commandId);
    await appendOperationalEvent({
      command,
      actorIdentityId: request.authContext.user.id,
      eventType: "AUTHORIZED",
    });
    await appendOperationalEvent({
      command,
      actorIdentityId: request.authContext.user.id,
      eventType: "EXECUTION_STARTED",
    });

    try {
      const result = change
        ? (await executeOperationalChange({
            command,
            changeType: change.changeType,
            expectedState: change.expectedState,
            executorIdentityId: request.authContext.user.id,
            execute,
            verify: change.verify,
            maintenance: change.maintenance,
          })).result
        : await execute();
      await appendExecutionEvidence({ command, status: "SUCCEEDED", result });
      await appendOperationalEvent({
        command,
        actorIdentityId: request.authContext.user.id,
        eventType: "EXECUTION_SUCCEEDED",
        metadata: { resultHash: canonicalHash(result) },
      });
      return { command, result, idempotent: false };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : "Operational execution failed.";
      await appendExecutionEvidence({
        command,
        status: "FAILED",
        result: {},
        failureCode: error instanceof Error ? error.name : "UNKNOWN_FAILURE",
        failureReason,
      });
      await appendOperationalEvent({
        command,
        actorIdentityId: request.authContext.user.id,
        eventType: "EXECUTION_FAILED",
        metadata: { failureReason },
      });
      throw error;
    }
  });
}

export async function approveGovernedOperation(input: {
  commandId: string;
  approver: AuthContext;
  source: "HUMAN" | "SYSTEM";
  decision: "APPROVED" | "REJECTED";
  reason: string;
}) {
  if (!input.reason.trim()) throw new OperationalGovernanceError("Approval reason is required.");
  await appendOperationalApproval(input);
}
