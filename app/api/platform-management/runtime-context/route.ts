import { normalizeRuntimeHostname, resolveRuntimeBrandContext } from "@/src/domains/platform-management/platform-management.repository";
import { errorJson, successJson } from "../api.helpers";

export const runtime = "nodejs";

function hostnameFromRequest(request: Request) {
  const url = new URL(request.url);
  const explicitHostname = url.searchParams.get("hostname");

  if (explicitHostname?.trim()) {
    return explicitHostname;
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    return forwardedHost;
  }

  return request.headers.get("host") ?? "";
}

export async function GET(request: Request) {
  try {
    const hostname = normalizeRuntimeHostname(hostnameFromRequest(request));
    const context = await resolveRuntimeBrandContext({ hostname });

    if (!context) {
      return Response.json(
        {
          success: false,
          error: "Runtime brand context could not be resolved.",
        },
        { status: 404 }
      );
    }

    return successJson({ context });
  } catch (error) {
    return errorJson(error, "Unable to resolve runtime brand context.");
  }
}
