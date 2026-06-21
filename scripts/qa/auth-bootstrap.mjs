import {
  findQaAdminUser,
  getAuthoritativeSupabaseUrl,
  getAppHealth,
  getAppUrl,
  getQaAdminUsername,
  getQaSupabaseAccessUrl,
  getSessionToken,
  getServiceRoleKey,
  loadLocalEnv,
  loginQaAdmin,
  resetQaAdminPassword,
  validateSessionToken,
  validateSupabaseTargetGuard,
  writeQaSessionFile,
} from "./lib/qa-auth-session.mjs";

loadLocalEnv();

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "BLOCKED", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "READY", message, ...metadata }, null, 2));
}

function getQaAdminRemediation(error) {
  if (
    typeof error === "object" &&
    error &&
    "causeCode" in error &&
    error.causeCode === "ECONNREFUSED"
  ) {
    return "The running app points at local Supabase, but the QA tooling cannot reach it. Start local Supabase on port 54321, or rebuild/restart the app with the intended hosted Supabase environment.";
  }

  if (typeof error === "string" && error.includes("does not exist")) {
    return "Create the existing QA admin account on the running app's Supabase target, then rerun npm run qa:auth:bootstrap.";
  }

  return "Create or activate the existing QA admin user on the running app's Supabase target, then rerun npm run qa:auth:bootstrap.";
}

const appHealth = await getAppHealth();
if (appHealth.status !== "READY") {
  fail("App target is unavailable.", {
    appTarget: getAppUrl(),
    appHealth,
  });
}

const targetGuard = validateSupabaseTargetGuard();
if (targetGuard.status === "BLOCKED") {
  fail(targetGuard.message, {
    ...targetGuard,
    remediation:
      "Restart/rebuild the app with the intended Supabase environment, then rerun npm run qa:auth:bootstrap. Use QA_SUPABASE_URL only for physical access to the same logical target.",
  });
}

const authoritativeSupabaseUrl = getAuthoritativeSupabaseUrl();
if (!authoritativeSupabaseUrl || !getServiceRoleKey()) {
  fail("Supabase target or service role key is unavailable.", {
    appTarget: getAppUrl(),
    supabaseTarget: authoritativeSupabaseUrl,
    supabaseAccessUrl: getQaSupabaseAccessUrl(),
    serviceRoleAvailable: Boolean(getServiceRoleKey()),
    remediation:
      "Ensure the running app container has SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY configured.",
  });
}

const qaAdmin = await findQaAdminUser();
if (qaAdmin.status !== "READY") {
  fail("QA admin account is not ready.", {
    username: getQaAdminUsername(),
    appSupabaseTarget: targetGuard.appTarget,
    qaSupabaseTarget: targetGuard.qaSupabaseTarget,
    supabaseAccessUrl: getQaSupabaseAccessUrl(),
    match: targetGuard.match,
    error: qaAdmin.error,
    remediation: getQaAdminRemediation(qaAdmin.error),
  });
}

const existingSession = await validateSessionToken();
if (existingSession.valid) {
  writeQaSessionFile({
    sessionToken: getSessionToken(),
    expiresAt: existingSession.expiresAt,
  });

  pass("Existing QA session is valid.", {
    appTarget: getAppUrl(),
    appSupabaseTarget: targetGuard.appTarget,
    qaSupabaseTarget: targetGuard.qaSupabaseTarget,
    supabaseAccessUrl: getQaSupabaseAccessUrl(),
    match: targetGuard.match,
    username: qaAdmin.user.username,
    userId: qaAdmin.user.id,
    expiresAt: existingSession.expiresAt,
    sessionFile: ".qa/session.env",
  });
  process.exit(0);
}

const login = await loginQaAdmin();
if (!login.success) {
  if (login.error === "Invalid username or password.") {
    const reset = resetQaAdminPassword();

    if (!reset.success) {
      fail("Unable to repair invalid QA admin password.", {
        appTarget: getAppUrl(),
        appSupabaseTarget: targetGuard.appTarget,
        qaSupabaseTarget: targetGuard.qaSupabaseTarget,
        supabaseAccessUrl: getQaSupabaseAccessUrl(),
        username: getQaAdminUsername(),
        error: reset.error,
        remediation:
          "Run npm run auth:reset-password for the QA admin target, then rerun npm run qa:auth:bootstrap.",
      });
    }

    const repairedLogin = await loginQaAdmin();

    if (repairedLogin.success) {
      writeQaSessionFile({
        sessionToken: repairedLogin.sessionToken,
        expiresAt: repairedLogin.expiresAt,
      });

      pass("QA admin password repaired and session refreshed.", {
        appTarget: getAppUrl(),
        appSupabaseTarget: targetGuard.appTarget,
        qaSupabaseTarget: targetGuard.qaSupabaseTarget,
        supabaseAccessUrl: getQaSupabaseAccessUrl(),
        match: targetGuard.match,
        username: qaAdmin.user.username,
        userId: qaAdmin.user.id,
        expiresAt: repairedLogin.expiresAt,
        sessionFile: ".qa/session.env",
      });
      process.exit(0);
    }

    fail("QA admin password was repaired but login still failed.", {
      appTarget: getAppUrl(),
      appSupabaseTarget: targetGuard.appTarget,
      qaSupabaseTarget: targetGuard.qaSupabaseTarget,
      supabaseAccessUrl: getQaSupabaseAccessUrl(),
      username: getQaAdminUsername(),
      error: repairedLogin.error,
      remediation:
        "Inspect /api/auth/login and QA admin account status for this target.",
    });
  }

  fail("Unable to create QA admin session.", {
    appTarget: getAppUrl(),
    appSupabaseTarget: targetGuard.appTarget,
    qaSupabaseTarget: targetGuard.qaSupabaseTarget,
    supabaseAccessUrl: getQaSupabaseAccessUrl(),
    match: targetGuard.match,
    username: getQaAdminUsername(),
    error: login.error,
    remediation:
      login.error?.includes("MFA")
        ? "Complete MFA manually or use a dedicated local QA admin without MFA."
        : "Verify QA_ADMIN_PASSWORD for the active app target.",
  });
}

writeQaSessionFile({
  sessionToken: login.sessionToken,
  expiresAt: login.expiresAt,
});

pass("QA admin session refreshed.", {
  appTarget: getAppUrl(),
  appSupabaseTarget: targetGuard.appTarget,
  qaSupabaseTarget: targetGuard.qaSupabaseTarget,
  supabaseAccessUrl: getQaSupabaseAccessUrl(),
  match: targetGuard.match,
  username: qaAdmin.user.username,
  userId: qaAdmin.user.id,
  expiresAt: login.expiresAt,
  sessionFile: ".qa/session.env",
});
