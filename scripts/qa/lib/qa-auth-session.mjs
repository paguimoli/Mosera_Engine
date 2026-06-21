import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const sessionFilePath = resolve(".qa/session.env");
const envFiles = [".env.local", ".env"];
const sessionEnvKeys = new Set([
  "QA_ADMIN_SESSION_TOKEN",
  "OPS_ADMIN_SESSION_TOKEN",
  "QA_SESSION_GENERATED_AT",
  "QA_SESSION_EXPIRES_AT",
]);

function parseEnvFile(path) {
  if (!existsSync(path)) return {};

  const result = {};
  const contents = readFileSync(path, "utf8");

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");

    if (separatorIndex < 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function loadLocalEnv({ includeSession = true } = {}) {
  for (const path of envFiles) {
    const values = parseEnvFile(path);

    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  if (includeSession) {
    const sessionValues = parseEnvFile(sessionFilePath);

    for (const [key, value] of Object.entries(sessionValues)) {
      if (sessionEnvKeys.has(key) || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function getAppUrl() {
  return process.env.QA_APP_URL || process.env.OPERATIONS_APP_URL || "http://localhost:3000";
}

function readAppEnvFromCompose(name) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "app",
      "node",
      "-e",
      `process.stdout.write(process.env.${name} || '')`,
    ],
    {
      encoding: "utf8",
    }
  );

  if (result.status !== 0) {
    return {
      available: false,
      value: "",
      error: (result.stderr || result.stdout || `Unable to inspect app ${name}.`).trim(),
    };
  }

  return {
    available: true,
    value: result.stdout.trim(),
    error: null,
  };
}

export function getConfiguredSupabaseUrl() {
  return (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim();
}

export function getAuthoritativeSupabaseUrl() {
  const appTarget = readAppSupabaseTargetFromCompose();

  return appTarget.target || getConfiguredSupabaseUrl();
}

function isDockerRuntime() {
  return existsSync("/.dockerenv");
}

function isLocalhostUrl(value) {
  try {
    const url = new URL(value);

    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function replaceHostname(value, hostname) {
  const url = new URL(value);
  url.hostname = hostname;

  return url.toString().replace(/\/$/, "");
}

export function getQaSupabaseAccessUrl() {
  const override = process.env.QA_SUPABASE_URL?.trim();
  const logicalTarget = getAuthoritativeSupabaseUrl();

  if (override) return override;

  if (logicalTarget && isDockerRuntime() && isLocalhostUrl(logicalTarget)) {
    return replaceHostname(logicalTarget, "host.docker.internal");
  }

  return logicalTarget;
}

export function getServiceRoleKey() {
  return (
    readAppEnvFromCompose("SUPABASE_SERVICE_ROLE_KEY").value ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();
}

export function getQaAdminUsername() {
  return (process.env.QA_ADMIN_USERNAME || "admin2").trim();
}

export function getQaAdminPassword() {
  return process.env.QA_ADMIN_PASSWORD || "";
}

export function getSessionToken() {
  return (
    process.env.QA_ADMIN_SESSION_TOKEN ||
    process.env.OPS_ADMIN_SESSION_TOKEN ||
    process.env.OPERATIONS_SESSION_TOKEN ||
    ""
  ).trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);

    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

export function readAppSupabaseTargetFromCompose() {
  const supabaseUrl = readAppEnvFromCompose("SUPABASE_URL");
  const nextPublicSupabaseUrl = supabaseUrl.value
    ? supabaseUrl
    : readAppEnvFromCompose("NEXT_PUBLIC_SUPABASE_URL");

  if (!nextPublicSupabaseUrl.available) {
    return {
      available: false,
      target: "",
      error: nextPublicSupabaseUrl.error,
    };
  }

  return {
    available: true,
    target: nextPublicSupabaseUrl.value,
    error: null,
  };
}

export function validateSupabaseTargetGuard() {
  const configuredTarget = getConfiguredSupabaseUrl();
  const authoritativeTarget = getAuthoritativeSupabaseUrl();
  const accessUrl = getQaSupabaseAccessUrl();
  const appTarget = readAppSupabaseTargetFromCompose();

  if (!appTarget.available) {
    return {
      status: "WARNING",
      appTarget: "",
      configuredTarget,
      authoritativeTarget,
      qaSupabaseTarget: authoritativeTarget,
      accessUrl,
      match: false,
      message: appTarget.error,
    };
  }

  if (
    authoritativeTarget &&
    appTarget.target &&
    normalizeUrl(authoritativeTarget) !== normalizeUrl(appTarget.target)
  ) {
    return {
      status: "BLOCKED",
      appTarget: appTarget.target,
      configuredTarget,
      authoritativeTarget,
      qaSupabaseTarget: authoritativeTarget,
      accessUrl,
      match: false,
      message:
        "App Supabase target and QA Supabase target do not match. Remove conflicting SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL overrides or set QA_SUPABASE_URL only as an access URL for the same logical target.",
    };
  }

  return {
    status: "READY",
    appTarget: appTarget.target,
    configuredTarget,
    authoritativeTarget,
    qaSupabaseTarget: authoritativeTarget,
    accessUrl,
    match: true,
    message: "Supabase targets match.",
  };
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return { response, body };
}

export async function getAppHealth() {
  try {
    const { response, body } = await requestJson(`${getAppUrl()}/api/health`);

    return {
      status: response.ok ? "READY" : "BLOCKED",
      statusCode: response.status,
      body,
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      statusCode: null,
      body: {
        error: error instanceof Error ? error.message : "Unknown app health error.",
      },
    };
  }
}

export async function validateSessionToken(token = getSessionToken()) {
  if (!token) {
    return {
      valid: false,
      reason: "Session token is missing.",
      expiresAt: null,
      user: null,
    };
  }

  try {
    const { response, body } = await requestJson(`${getAppUrl()}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!response.ok || !body?.success) {
      return {
        valid: false,
        reason: body?.error || `Auth check returned ${response.status}.`,
        expiresAt: null,
        user: null,
      };
    }

    return {
      valid: true,
      reason: "Session is active.",
      expiresAt: body.session?.expiresAt ?? null,
      user: body.user ?? null,
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "Unknown session validation error.",
      expiresAt: null,
      user: null,
    };
  }
}

export async function findQaAdminUser() {
  const logicalSupabaseUrl = getAuthoritativeSupabaseUrl();
  const supabaseAccessUrl = getQaSupabaseAccessUrl();
  const serviceRoleKey = getServiceRoleKey();
  const username = getQaAdminUsername();

  if (!logicalSupabaseUrl || !supabaseAccessUrl || !serviceRoleKey) {
    return {
      status: "BLOCKED",
      user: null,
      error: {
        message:
          "SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
        logicalSupabaseUrl,
        supabaseAccessUrl,
        serviceRoleAvailable: Boolean(serviceRoleKey),
      },
    };
  }

  const url = new URL("/rest/v1/platform_users", supabaseAccessUrl);
  url.searchParams.set("select", "id,username,email,status,identity_class,mfa_enabled,last_login_at");
  url.searchParams.set("username", `eq.${username}`);
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url, {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    const body = await response.json();

    if (!response.ok) {
      return {
        status: "BLOCKED",
        user: null,
        error: {
          status: response.status,
          targetUrl: url.toString(),
          logicalSupabaseUrl,
          supabaseAccessUrl,
          code: body?.code ?? null,
          message: body?.message ?? "Unable to query QA admin user.",
          details: body?.details ?? null,
          hint: body?.hint ?? null,
        },
      };
    }

    const user = Array.isArray(body) ? body[0] ?? null : null;

    if (!user) {
      return {
        status: "BLOCKED",
        user: null,
        error: `QA admin user '${username}' does not exist.`,
      };
    }

    if (user.status !== "ACTIVE") {
      return {
        status: "BLOCKED",
        user,
        error: `QA admin user '${username}' is not ACTIVE.`,
      };
    }

    return {
      status: "READY",
      user,
      error: null,
    };
  } catch (error) {
    const cause = error instanceof Error ? error.cause : null;
    const causeRecord =
      typeof cause === "object" && cause ? cause : null;
    const causeMessage =
      cause instanceof Error
        ? cause.message
        : causeRecord && "message" in causeRecord
          ? String(cause.message)
          : null;

    return {
      status: "BLOCKED",
      user: null,
      error: {
        targetUrl: url.toString(),
        logicalSupabaseUrl,
        supabaseAccessUrl,
        environment: isDockerRuntime() ? "docker" : "host",
        name: error instanceof Error ? error.name : "UnknownError",
        message:
          error instanceof Error
            ? error.message
            : "Unknown Supabase user lookup error.",
        causeName: cause instanceof Error ? cause.name : null,
        causeMessage,
        causeCode:
          causeRecord && "code" in causeRecord ? String(causeRecord.code) : null,
        causeAddress:
          causeRecord && "address" in causeRecord
            ? String(causeRecord.address)
            : null,
        causePort:
          causeRecord && "port" in causeRecord ? String(causeRecord.port) : null,
      },
    };
  }
}

export function resetQaAdminPassword() {
  const username = getQaAdminUsername();
  const password = getQaAdminPassword();

  if (!password) {
    return {
      success: false,
      error: "QA_ADMIN_PASSWORD is required to reset the QA admin password.",
    };
  }

  const result = spawnSync(
    "node",
    [
      "scripts/run-ts-script.mjs",
      "scripts/reset-platform-user-password.ts",
      "--username",
      username,
      "--password",
      password,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: getAuthoritativeSupabaseUrl(),
        NEXT_PUBLIC_SUPABASE_URL: getAuthoritativeSupabaseUrl(),
        SUPABASE_SERVICE_ROLE_KEY: getServiceRoleKey(),
      },
    }
  );

  return {
    success: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    error:
      result.status === 0
        ? null
        : (result.stderr || result.stdout || "Password reset failed.").trim(),
  };
}

export async function loginQaAdmin() {
  const username = getQaAdminUsername();
  const password = getQaAdminPassword();

  if (!password) {
    return {
      success: false,
      blocked: true,
      error: "QA_ADMIN_PASSWORD is required to create a fresh QA session.",
    };
  }

  const { response, body } = await requestJson(`${getAppUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok || !body?.success) {
    return {
      success: false,
      blocked: true,
      error: body?.error || `Login returned ${response.status}.`,
      body,
    };
  }

  if (body.mfaRequired) {
    return {
      success: false,
      blocked: true,
      error:
        "QA admin login requires MFA. Complete MFA manually or use a dedicated local QA admin without MFA.",
      body: {
        mfaRequired: true,
        expiresAt: body.expiresAt,
      },
    };
  }

  if (!body.sessionToken || !body.expiresAt) {
    return {
      success: false,
      blocked: true,
      error: "Login succeeded without a session token.",
      body,
    };
  }

  return {
    success: true,
    sessionToken: body.sessionToken,
    expiresAt: body.expiresAt,
  };
}

export function writeQaSessionFile({ sessionToken, expiresAt }) {
  const generatedAt = new Date().toISOString();
  const lines = [
    "# Local QA session file. Do not commit.",
    `QA_SESSION_GENERATED_AT=${generatedAt}`,
    `QA_SESSION_EXPIRES_AT=${expiresAt}`,
    `QA_ADMIN_SESSION_TOKEN=${sessionToken}`,
    `OPS_ADMIN_SESSION_TOKEN=${sessionToken}`,
    "",
  ];

  mkdirSync(dirname(sessionFilePath), { recursive: true });
  writeFileSync(sessionFilePath, lines.join("\n"), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function summarizeStatus(parts) {
  if (parts.some((part) => part.status === "BLOCKED")) return "BLOCKED";
  if (parts.some((part) => part.status === "WARNING")) return "WARNING";

  return "READY";
}
