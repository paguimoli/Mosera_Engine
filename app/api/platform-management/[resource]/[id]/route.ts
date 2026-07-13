import {
  assertPlatformResourceScope,
  requirePlatformManagementPermission,
} from "@/src/domains/platform-management/platform-management-auth";
import {
  getPlatformRecord,
  isPlatformResourceName,
  platformResourceResponseKey,
  resolvePlatformResourceScope,
} from "@/src/domains/platform-management/platform-management.repository";
import { errorJson, successJson } from "../../api.helpers";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ resource: string; id: string }>;
};

export async function GET(_request: Request, { params }: RouteParams) {
  const { resource, id } = await params;

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

    const authorization = await requirePlatformManagementPermission(_request, resource, "read");

    const record = await getPlatformRecord(resource, id);

    if (!record) {
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
      "read",
      await resolvePlatformResourceScope(resource, record)
    );

    return successJson({
      resource,
      [platformResourceResponseKey(resource)]: record,
    });
  } catch (error) {
    return errorJson(error, "Unable to load platform management record.");
  }
}
