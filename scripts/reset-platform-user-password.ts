import {
  findUserByUsername,
  saveAuthAuditEvent,
} from "../src/domains/auth/auth.repository";
import {
  AUTHENTICATION_EVENT_TYPES,
  USER_STATUSES,
} from "../src/domains/auth/auth.constants";
import { hashPassword } from "../src/domains/auth/password.helpers";
import { validatePasswordPolicy } from "../src/domains/auth/password.policy";
import { supabaseServerAdmin } from "../src/lib/supabase/server-admin-client";

const USERNAME_ENV_NAME = "RESET_PLATFORM_USERNAME";
const PASSWORD_ENV_NAME = "RESET_PLATFORM_PASSWORD";

type SupabaseError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

class PasswordResetPersistenceError extends Error {
  readonly diagnostics: SupabaseError;
  readonly target: string;

  constructor(error: SupabaseError, target = getSupabaseTarget()) {
    super("Platform user password update failed.");
    this.name = "PasswordResetPersistenceError";
    this.target = target;
    this.diagnostics = {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    };
  }
}

function getSupabaseTarget() {
  return (
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    "unknown"
  );
}

function getArgValue(args: string[], name: string) {
  const flagIndex = args.indexOf(name);

  if (flagIndex < 0) {
    return null;
  }

  return args[flagIndex + 1] || null;
}

function resolveUsername(args: string[]) {
  return (
    getArgValue(args, "--username") ??
    getArgValue(args, "-u") ??
    process.env[USERNAME_ENV_NAME] ??
    process.env.PLATFORM_USERNAME ??
    ""
  ).trim();
}

function resolvePassword(args: string[]) {
  return (
    getArgValue(args, "--password") ??
    getArgValue(args, "-p") ??
    process.env[PASSWORD_ENV_NAME] ??
    process.env.PLATFORM_PASSWORD ??
    ""
  );
}

function isMissingPasswordChangedColumn(error: SupabaseError) {
  const message = error.message ?? "";
  const details = error.details ?? "";

  return (
    error.code === "PGRST204" ||
    message.includes("last_password_change_at") ||
    details.includes("last_password_change_at")
  );
}

async function updatePlatformUserPassword({
  userId,
  passwordHash,
  changedAt,
}: {
  userId: string;
  passwordHash: string;
  changedAt: string;
}) {
  const updatePayload = {
    password_hash: passwordHash,
    last_password_change_at: changedAt,
    failed_login_attempts: 0,
    locked_until: null,
    status: USER_STATUSES.ACTIVE,
  };
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .update(updatePayload)
    .eq("id", userId);

  if (!error) {
    return;
  }

  if (!isMissingPasswordChangedColumn(error)) {
    throw new PasswordResetPersistenceError(error);
  }

  const fallbackPayload = {
    password_hash: passwordHash,
    failed_login_attempts: 0,
    locked_until: null,
    status: USER_STATUSES.ACTIVE,
  };
  const { error: fallbackError } = await supabaseServerAdmin
    .from("platform_users")
    .update(fallbackPayload)
    .eq("id", userId);

  if (fallbackError) {
    throw new PasswordResetPersistenceError(fallbackError);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const username = resolveUsername(args);
  const password = resolvePassword(args);

  if (!username || !password) {
    throw new Error(
      "Usage: npm run auth:reset-password -- --username <username> --password <password>"
    );
  }

  const user = await findUserByUsername(username);

  if (!user) {
    throw new Error("Platform user not found.");
  }

  const passwordPolicy = validatePasswordPolicy({
    password,
    username: user.username,
    email: user.email,
  });

  if (!passwordPolicy.valid) {
    throw new Error(passwordPolicy.errors.join(" "));
  }

  const passwordHash = await hashPassword(password);
  const changedAt = new Date().toISOString();

  await updatePlatformUserPassword({
    userId: user.id,
    passwordHash,
    changedAt,
  });

  await saveAuthAuditEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_COMPLETED,
    metadata: {
      source: "local_admin_password_reset_utility",
      changedAt,
    },
  });

  console.log(`username: ${user.username}`);
  console.log(`user id: ${user.id}`);
  console.log("success: true");
}

main().catch((error: unknown) => {
  if (error instanceof PasswordResetPersistenceError) {
    console.error(error.message);
    console.error(`target: ${error.target}`);
    console.error(`message: ${error.diagnostics.message ?? ""}`);
    console.error(`code: ${error.diagnostics.code ?? ""}`);
    console.error(`details: ${error.diagnostics.details ?? ""}`);
    console.error(`hint: ${error.diagnostics.hint ?? ""}`);
    process.exit(1);
  }

  const message =
    error instanceof Error
      ? error.message
      : "Platform user password reset failed.";

  console.error(message);
  console.error(`target: ${getSupabaseTarget()}`);
  process.exit(1);
});
