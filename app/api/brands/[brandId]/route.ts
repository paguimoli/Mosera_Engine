import { legacyPlatformMutationGone } from "@/src/domains/platform-management/platform-mutation-authority";

export const runtime = "nodejs";

export async function PATCH() {
  return legacyPlatformMutationGone("brand");
}
