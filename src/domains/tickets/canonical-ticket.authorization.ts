import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";
import { resolveCanonicalScope } from "@/src/domains/scope/canonical-scope-resolver";

import type { CanonicalTicketScope } from "./canonical-ticket.types";

export function canAccessTicketScope(
  context: AuthContext,
  scope: CanonicalTicketScope
) {
  return resolveCanonicalScope(context, scope).authorized;
}

export function assertTicketScope(
  context: AuthContext,
  scope: CanonicalTicketScope
) {
  if (!canAccessTicketScope(context, scope)) {
    throw new AuthMiddlewareError(403, "Canonical ticket scope denied.");
  }
}
