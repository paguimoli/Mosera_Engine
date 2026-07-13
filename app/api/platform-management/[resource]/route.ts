import {
  assertPlatformResourceScope,
  requirePlatformManagementPermission,
} from "@/src/domains/platform-management/platform-management-auth";
import {
  createPlatformRecord,
  isPlatformResourceName,
  listPlatformRecords,
  platformResourceResponseKey,
  resolvePlatformResourceScope,
} from "@/src/domains/platform-management/platform-management.repository";
import { errorJson, readObjectBody, successJson } from "../api.helpers";

export const runtime = "nodejs";

type RouteParams = {
  params: Promise<{ resource: string }>;
};

async function getResource(params: RouteParams["params"]) {
  const { resource } = await params;
  return resource;
}

export async function GET(request: Request, { params }: RouteParams) {
  const resource = await getResource(params);

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

    const authorization = await requirePlatformManagementPermission(request, resource, "read");

    const records = await listPlatformRecords(resource, new URL(request.url).searchParams);
    const scopedRecords = [];

    for (const record of records) {
      try {
        assertPlatformResourceScope(
          authorization,
          resource,
          "read",
          await resolvePlatformResourceScope(resource, record)
        );
        scopedRecords.push(record);
      } catch {
        // Filter inaccessible rows without leaking their existence in broad list responses.
      }
    }

    return successJson({
      resource,
      records: scopedRecords,
    });
  } catch (error) {
    return errorJson(error, "Unable to list platform management records.");
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const resource = await getResource(params);

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

    const authorization = await requirePlatformManagementPermission(request, resource, "create");

    const body = await readObjectBody(request);
    assertPlatformResourceScope(
      authorization,
      resource,
      "create",
      await resolvePlatformResourceScope(resource, body)
    );

    const record = await createPlatformRecord(resource, body);

    return successJson(
      {
        resource,
        [platformResourceResponseKey(resource)]: record,
      },
      201
    );
  } catch (error) {
    return errorJson(error, "Unable to create platform management record.");
  }
}
