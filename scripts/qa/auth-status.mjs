import {
  findQaAdminUser,
  getAuthoritativeSupabaseUrl,
  getConfiguredSupabaseUrl,
  getAppHealth,
  getAppUrl,
  getQaAdminUsername,
  getQaSupabaseAccessUrl,
  getServiceRoleKey,
  loadLocalEnv,
  summarizeStatus,
  validateSessionToken,
  validateSupabaseTargetGuard,
} from "./lib/qa-auth-session.mjs";

loadLocalEnv();

const appHealth = await getAppHealth();
const targetGuard = validateSupabaseTargetGuard();
const qaAdmin = await findQaAdminUser();
const session = await validateSessionToken();
const serviceRoleAvailable = Boolean(getServiceRoleKey());
const status = summarizeStatus([
  { status: appHealth.status },
  { status: targetGuard.status },
  { status: serviceRoleAvailable ? "READY" : "BLOCKED" },
  { status: qaAdmin.status },
  { status: session.valid ? "READY" : "BLOCKED" },
]);

console.log(
  JSON.stringify(
    {
      status,
      appTarget: getAppUrl(),
      appHealth,
      configuredSupabaseTarget: getConfiguredSupabaseUrl(),
      authoritativeSupabaseTarget: getAuthoritativeSupabaseUrl(),
      supabaseAccessUrl: getQaSupabaseAccessUrl(),
      appSupabaseTarget: targetGuard.appTarget,
      qaSupabaseTarget: targetGuard.qaSupabaseTarget,
      match: targetGuard.match,
      serviceRoleAvailable,
      qaAdmin: {
        username: getQaAdminUsername(),
        ready: qaAdmin.status === "READY",
        userId: qaAdmin.user?.id ?? null,
        status: qaAdmin.user?.status ?? null,
        identityClass: qaAdmin.user?.identity_class ?? null,
        mfaEnabled: qaAdmin.user?.mfa_enabled ?? null,
        error: qaAdmin.error ?? null,
      },
      session: {
        valid: session.valid,
        reason: session.reason,
        expiresAt: session.expiresAt,
        userId: session.user?.id ?? null,
        username: session.user?.username ?? null,
      },
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  )
);

process.exit(status === "BLOCKED" ? 1 : 0);
