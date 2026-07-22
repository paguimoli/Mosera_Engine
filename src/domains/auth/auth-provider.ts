export type AuthProvider = "auth-service";
export type AuthAuthority =
  | "MONOLITH"
  | "SERVICE_SHADOW"
  | "SERVICE_DRY_RUN"
  | "SERVICE";

export function getAuthAuthority(): AuthAuthority {
  const configured = process.env.AUTH_AUTHORITY?.trim().toUpperCase();
  if (
    configured === "SERVICE_SHADOW" ||
    configured === "SERVICE_DRY_RUN" ||
    configured === "SERVICE"
  ) {
    return configured;
  }
  return "MONOLITH";
}

export function getAuthProvider(): AuthProvider {
  return "auth-service";
}

export function isAuthServiceProviderEnabled() {
  return true;
}

export function isAuthServicePromotionEnabled() {
  return getAuthAuthority() === "SERVICE";
}

export function getAuthServiceUrl() {
  return (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");
}
