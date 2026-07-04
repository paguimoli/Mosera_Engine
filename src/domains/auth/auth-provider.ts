export type AuthProvider = "legacy" | "auth-service";

export function getAuthProvider(): AuthProvider {
  return process.env.AUTH_PROVIDER === "auth-service" ? "auth-service" : "legacy";
}

export function isAuthServiceProviderEnabled() {
  return getAuthProvider() === "auth-service";
}

export function getAuthServiceUrl() {
  return (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");
}
