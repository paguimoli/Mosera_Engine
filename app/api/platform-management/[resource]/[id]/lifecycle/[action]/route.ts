import {
  assertPlatformResourceScope,
  requirePlatformManagementPermission,
  withPlatformMutationAudit,
} from "@/src/domains/platform-management/platform-management-auth";
import {
  getPlatformRecord,
  isPlatformResourceName,
  listPlatformLifecycleEvents,
  performPlatformLifecycleAction,
  platformResourceResponseKey,
  resolvePlatformResourceScope,
  type PlatformLifecycleAction,
} from "@/src/domains/platform-management/platform-management.repository";
import { errorJson, readObjectBody, successJson } from "../../../../api.helpers";
import {
  executeGovernedOperation,
  resolveOperationalRequestMetadata,
} from "@/src/domains/operational-governance/operational-governance.service";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ resource: string; id: string; action: string }>;
};

const lifecycleActions = new Set(["activate", "suspend", "retire", "supersede", "cancel"]);

function isLifecycleAction(action: string): action is PlatformLifecycleAction {
  return lifecycleActions.has(action);
}

export async function POST(request: Request, { params }: RouteParams) {
  const { resource, id, action } = await params;

  try {
    if (!isPlatformResourceName(resource)) {
      return Response.json(
        {
          success: false,
          error: `Unknown platform management resource '${resource}'.`,
        },
        { status: 400 }
      );
    }

    if (!isLifecycleAction(action)) {
      return Response.json(
        {
          success: false,
          error: `Unknown platform lifecycle action '${action}'.`,
        },
        { status: 400 }
      );
    }

    const authorization = await requirePlatformManagementPermission(request, resource, "create");
    const existing = await getPlatformRecord(resource, id);

    if (!existing) {
      return Response.json(
        {
          success: false,
          error: "Platform management record not found.",
        },
        { status: 404 }
      );
    }

    const scope = await resolvePlatformResourceScope(resource, existing);
    assertPlatformResourceScope(authorization, resource, "create", scope);

    const body = await readObjectBody(request);
    const metadata = resolveOperationalRequestMetadata(
      request,
      body,
      "PLATFORM_LIFECYCLE",
      `${action} ${resource}`
    );
    const governed = await executeGovernedOperation(
      {
        authContext: authorization.authContext,
        commandType: "PLATFORM_LIFECYCLE",
        affectedAuthority: "PLATFORM",
        targetType: resource,
        targetId: id,
        ...metadata,
        payload: { resource, id, action, scope: scope ?? {} },
      },
      () => performPlatformLifecycleAction(
        resource,
        id,
        action,
        withPlatformMutationAudit(
          body,
          request,
          authorization,
          resource,
          action,
          scope
        )
      ),
      resource === "websites" && action === "supersede" && typeof body.maintenanceMode === "boolean"
        ? {
            changeType: "PLATFORM_MAINTENANCE",
            expectedState: { websiteId: id, maintenanceMode: body.maintenanceMode },
            verify: (lifecycleResult) => ({
              expectedStateReached: Boolean(lifecycleResult) &&
                lifecycleResult?.current.maintenanceMode === body.maintenanceMode,
              authorityAccepted: Boolean(lifecycleResult),
              readinessMaintained: true,
              auditRecorded: true,
              observedState: lifecycleResult
                ? { websiteId: lifecycleResult.current.id,
                    maintenanceMode: lifecycleResult.current.maintenanceMode }
                : {},
            }),
            maintenance: {
              websiteId: id,
              action: body.maintenanceMode ? "BEGIN" : "END",
              reason: metadata.reason,
            },
          }
        : undefined
    );
    const result = governed.result;

    if (!result) {
      return Response.json(
        {
          success: false,
          error: "Platform management record not found.",
        },
        { status: 404 }
      );
    }

    const lifecycleEvents = await listPlatformLifecycleEvents(
      resource,
      String(result.current.id)
    );

    return successJson(
      {
        resource,
        action,
        previous: result.previous,
        [platformResourceResponseKey(resource)]: result.current,
        lifecycleEvents,
        operationalCommandId: governed.command.commandId,
        idempotent: governed.idempotent,
      },
      201
    );
  } catch (error) {
    return errorJson(error, "Unable to apply platform lifecycle action.");
  }
}
