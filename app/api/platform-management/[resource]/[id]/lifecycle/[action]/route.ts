import {
  assertPlatformResourceScope,
  requirePlatformManagementPermission,
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

    assertPlatformResourceScope(
      authorization,
      resource,
      "create",
      await resolvePlatformResourceScope(resource, existing)
    );

    const body = await readObjectBody(request);
    const result = await performPlatformLifecycleAction(resource, id, action, body);

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
      },
      201
    );
  } catch (error) {
    return errorJson(error, "Unable to apply platform lifecycle action.");
  }
}
