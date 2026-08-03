import { NextResponse } from "next/server";

import { requirePermission } from "@/src/domains/auth/auth-middleware";
import {
  canonicalScopeSnapshot,
  resolveOperationalRequestMetadata,
} from "@/src/domains/operational-governance/operational-governance.service";
import {
  canonicalHash,
  claimOperationalCommand,
} from "@/src/domains/operational-governance/operational-governance.repository";
import type { OperationalCommandType } from "@/src/domains/operational-governance/operational-governance.types";
import { claimOperationalChange } from "@/src/domains/operational-change/operational-change.repository";
import type { OperationalChangeType } from "@/src/domains/operational-change/operational-change.types";

export const runtime = "nodejs";

const changeTypes = new Set<OperationalChangeType>([
  "CONFIGURATION_PUBLICATION", "PRODUCT_PUBLICATION", "PROVIDER_ACTIVATION",
  "PROVIDER_DEACTIVATION", "DRAW_SCHEDULE_PUBLICATION", "PLATFORM_MAINTENANCE",
  "RECOVERY_EXECUTION", "PRODUCTION_RELEASE",
]);

export async function POST(request: Request) {
  try {
    const authContext = await requirePermission(request, "system.admin");
    const body = await request.json() as Record<string, unknown>;
    const changeType = String(body.changeType ?? "") as OperationalChangeType;
    const commandType = String(body.commandType ?? "") as OperationalCommandType;
    if (!changeTypes.has(changeType) || !commandType ||
        typeof body.targetType !== "string" || typeof body.targetId !== "string" ||
        typeof body.affectedAuthority !== "string" ||
        !body.expectedState || typeof body.expectedState !== "object" || Array.isArray(body.expectedState)) {
      return NextResponse.json({ success: false, error: "Invalid operational change request." },
        { status: 400 });
    }
    const metadata = resolveOperationalRequestMetadata(
      request, body, commandType, `Request ${changeType}`);
    const scopeSnapshot = canonicalScopeSnapshot(authContext);
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown> : {};
    const command = await claimOperationalCommand({
      commandType,
      idempotencyKey: metadata.idempotencyKey,
      canonicalRequestHash: canonicalHash({ commandType, changeType,
        affectedAuthority: body.affectedAuthority, targetType: body.targetType,
        targetId: body.targetId, expectedState: body.expectedState, payload, scopeSnapshot }),
      authContext,
      scopeSnapshot,
      reason: metadata.reason,
      affectedAuthority: body.affectedAuthority,
      targetType: body.targetType,
      targetId: body.targetId,
      correlationId: metadata.correlationId,
      causationId: typeof body.causationId === "string" ? body.causationId : null,
    });
    const change = await claimOperationalChange({
      commandId: command.commandId,
      changeType,
      idempotencyKey: `change:${command.idempotencyKey}`,
      expectedState: body.expectedState as Record<string, unknown>,
    });
    return NextResponse.json({ success: true, command, change, executionAuthorized: false },
      { status: 202 });
  } catch (error) {
    return NextResponse.json({ success: false,
      error: error instanceof Error ? error.message : "Operational change request failed." },
      { status: 403 });
  }
}
