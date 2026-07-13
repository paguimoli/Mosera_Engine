import {
  assertPlatformResourceScope,
  requirePlatformGameAvailabilityResolutionPermission,
} from "@/src/domains/platform-management/platform-management-auth";
import {
  resolvePlatformGameAvailability,
  resolvePlatformResourceScope,
} from "@/src/domains/platform-management/platform-management.repository";
import { errorJson, successJson } from "../api.helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;

  try {
    const authorization = await requirePlatformGameAvailabilityResolutionPermission(request);
    const input = {
      tenantId: searchParams.get("tenantId") ?? searchParams.get("tenant_id") ?? "",
      brandId: searchParams.get("brandId") ?? searchParams.get("brand_id") ?? "",
      marketId: searchParams.get("marketId") ?? searchParams.get("market_id"),
      websiteId: searchParams.get("websiteId") ?? searchParams.get("website_id"),
      agentId: searchParams.get("agentId") ?? searchParams.get("agent_id"),
      asOf: searchParams.get("asOf") ?? searchParams.get("as_of"),
    };

    assertPlatformResourceScope(
      authorization,
      "game-availability",
      "read",
      await resolvePlatformResourceScope("game-availability", input)
    );

    const games = await resolvePlatformGameAvailability(input);

    return successJson({ games });
  } catch (error) {
    return errorJson(error, "Unable to resolve game availability.");
  }
}
