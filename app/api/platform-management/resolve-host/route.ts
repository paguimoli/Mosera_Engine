import { resolvePlatformHost } from "@/src/domains/platform-management/platform-management.repository";
import { errorJson, successJson } from "../api.helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const hostname = new URL(request.url).searchParams.get("hostname") ?? "";

  try {
    const resolution = await resolvePlatformHost(hostname);

    if (!resolution) {
      return Response.json(
        {
          success: false,
          error: "Host could not be resolved.",
        },
        { status: 404 }
      );
    }

    return successJson({ resolution });
  } catch (error) {
    return errorJson(error, "Unable to resolve host.");
  }
}
