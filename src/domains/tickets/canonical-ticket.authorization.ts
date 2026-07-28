import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";

import type { CanonicalTicketScope } from "./canonical-ticket.types";

function hasScope(context: AuthContext, type: string, id: string) {
  return (context.platformScopes ?? []).some(
    (scope) =>
      scope.scopeType.trim().toUpperCase() === type &&
      (scope.scopeId.trim().toLowerCase() === id.toLowerCase() ||
        scope.scopeId.trim() === "*")
  );
}

export function canAccessTicketScope(
  context: AuthContext,
  scope: CanonicalTicketScope
) {
  return (
    context.hasPermission("system.admin") ||
    hasScope(context, "GLOBAL", "platform") ||
    hasScope(context, "GLOBAL", "*") ||
    hasScope(context, "MARKET", scope.marketId) ||
    hasScope(context, "BRAND", scope.brandId) ||
    hasScope(context, "TENANT", scope.tenantId) ||
    hasScope(context, "ORGANIZATION", scope.organizationId)
  );
}

export function assertTicketScope(
  context: AuthContext,
  scope: CanonicalTicketScope
) {
  if (!canAccessTicketScope(context, scope)) {
    throw new AuthMiddlewareError(403, "Canonical ticket scope denied.");
  }
}
