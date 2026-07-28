import { legacyPlatformMutationGone } from "@/src/domains/platform-management/platform-mutation-authority";

export const runtime = "nodejs";

export async function POST() {
  return legacyPlatformMutationGone("brand");
}
