import {
  AUTHENTICATION_EVENT_TYPES,
  IDENTITY_CLASSES,
  USER_STATUSES,
} from "../src/domains/auth/auth.constants";
import { saveAuthAuditEvent } from "../src/domains/auth/auth.repository";
import { validateEmail, validateUsername } from "../src/domains/auth/auth.validation";
import { encryptMfaSecretPlaceholder } from "../src/domains/auth/mfa.helpers";
import { hashPassword } from "../src/domains/auth/password.helpers";
import { validatePasswordPolicy } from "../src/domains/auth/password.policy";
import { supabaseServerAdmin } from "../src/lib/supabase/server-admin-client";

type BreakGlassConfig = {
  index: 1 | 2;
  username: string;
  email: string;
  password: string;
  totpSecret: string;
  label: string;
};

type PlatformUserRow = {
  id: string;
  username: string;
  email: string;
};

type SupabaseError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

const SUPER_ADMIN_GROUP_NAME = "Super Admin";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function optionalEnv(name: string, fallback: string) {
  return process.env[name]?.trim() || fallback;
}

function readConfig(index: 1 | 2): BreakGlassConfig {
  const prefix = `BREAK_GLASS_${index}`;

  return {
    index,
    username: requiredEnv(`${prefix}_USERNAME`),
    email: requiredEnv(`${prefix}_EMAIL`),
    password: requiredEnv(`${prefix}_PASSWORD`),
    totpSecret: requiredEnv(`${prefix}_TOTP_SECRET`),
    label: optionalEnv(`${prefix}_LABEL`, `break-glass-${index}`),
  };
}

function printSupabaseError(label: string, error: SupabaseError) {
  console.error(`${label} failed.`);

  if (error.message) {
    console.error(`message: ${error.message}`);
  }

  if (error.code) {
    console.error(`code: ${error.code}`);
  }

  if (error.details) {
    console.error(`details: ${error.details}`);
  }

  if (error.hint) {
    console.error(`hint: ${error.hint}`);
  }
}

function validateConfig(config: BreakGlassConfig) {
  const usernameValidation = validateUsername(config.username);

  if (!usernameValidation.valid) {
    throw new Error(
      `Break-glass ${config.index} username is invalid: ${usernameValidation.errors.join(
        " "
      )}`
    );
  }

  const emailValidation = validateEmail(config.email);

  if (!emailValidation.valid) {
    throw new Error(
      `Break-glass ${config.index} email is invalid: ${emailValidation.errors.join(
        " "
      )}`
    );
  }

  const passwordValidation = validatePasswordPolicy({
    password: config.password,
    username: config.username,
    email: config.email,
  });

  if (!passwordValidation.valid) {
    throw new Error(
      `Break-glass ${config.index} password is invalid: ${passwordValidation.errors.join(
        " "
      )}`
    );
  }
}

async function loadSuperAdminGroupId() {
  const { data, error } = await supabaseServerAdmin
    .from("user_groups")
    .select("id, name")
    .eq("name", SUPER_ADMIN_GROUP_NAME)
    .maybeSingle();

  if (error) {
    printSupabaseError("Super Admin group lookup", error);
    throw new Error("Unable to load the Super Admin group.");
  }

  if (!data?.id) {
    throw new Error("Super Admin group was not found. Run auth migrations first.");
  }

  return data.id as string;
}

async function upsertBreakGlassUser(config: BreakGlassConfig) {
  const passwordHash = await hashPassword(config.password);
  const now = new Date().toISOString();

  const { data: existingUser, error: existingUserError } =
    await supabaseServerAdmin
      .from("platform_users")
      .select("id, username, email")
      .eq("username", config.username)
      .maybeSingle();

  if (existingUserError) {
    printSupabaseError("Break-glass user lookup", existingUserError);
    throw new Error("Unable to load break-glass platform user.");
  }

  if (existingUser) {
    const { data, error } = await supabaseServerAdmin
      .from("platform_users")
      .update({
        email: config.email,
        display_name: config.username,
        identity_class: IDENTITY_CLASSES.BREAK_GLASS,
        status: USER_STATUSES.ACTIVE,
        password_hash: passwordHash,
        mfa_enabled: true,
        failed_login_attempts: 0,
        locked_until: null,
        last_password_change_at: now,
      })
      .eq("id", existingUser.id)
      .select("id, username, email")
      .single();

    if (error || !data) {
      if (error) {
        printSupabaseError("Break-glass user update", error);
      }

      throw new Error("Unable to update break-glass platform user.");
    }

    return { user: data as PlatformUserRow, created: false, changedAt: now };
  }

  const { data, error } = await supabaseServerAdmin
    .from("platform_users")
    .insert({
      username: config.username,
      email: config.email,
      display_name: config.username,
      identity_class: IDENTITY_CLASSES.BREAK_GLASS,
      status: USER_STATUSES.ACTIVE,
      password_hash: passwordHash,
      mfa_enabled: true,
      failed_login_attempts: 0,
      last_password_change_at: now,
    })
    .select("id, username, email")
    .single();

  if (error || !data) {
    if (error) {
      printSupabaseError("Break-glass user insert", error);
    }

    throw new Error("Unable to create break-glass platform user.");
  }

  return { user: data as PlatformUserRow, created: true, changedAt: now };
}

async function ensureSuperAdminMembership(userId: string, groupId: string) {
  const { error } = await supabaseServerAdmin
    .from("user_group_memberships")
    .upsert(
      {
        user_id: userId,
        group_id: groupId,
      },
      { onConflict: "user_id,group_id" }
    );

  if (error) {
    printSupabaseError("Super Admin membership upsert", error);
    throw new Error("Unable to assign Super Admin membership.");
  }
}

async function ensureBreakGlassAccount(config: BreakGlassConfig, userId: string) {
  const now = new Date().toISOString();
  const { error } = await supabaseServerAdmin.from("break_glass_accounts").upsert(
    {
      user_id: userId,
      label: config.label,
      is_enabled: true,
      last_rotated_at: now,
    },
    { onConflict: "user_id" }
  );

  if (error) {
    printSupabaseError("Break-glass account upsert", error);
    throw new Error("Unable to register break-glass account.");
  }
}

async function ensureTotpFactor(config: BreakGlassConfig, userId: string) {
  const now = new Date().toISOString();
  const { error } = await supabaseServerAdmin.from("user_mfa_factors").upsert(
    {
      user_id: userId,
      factor_type: "TOTP",
      secret_encrypted: encryptMfaSecretPlaceholder(config.totpSecret),
      label: "Break-glass TOTP",
      is_enabled: true,
      verified_at: now,
    },
    { onConflict: "user_id,factor_type" }
  );

  if (error) {
    printSupabaseError("Break-glass TOTP factor upsert", error);
    throw new Error("Unable to configure break-glass MFA.");
  }
}

async function assertExactlyTwoBreakGlassAccounts() {
  const { count, error } = await supabaseServerAdmin
    .from("break_glass_accounts")
    .select("id", { count: "exact", head: true });

  if (error) {
    printSupabaseError("Break-glass account count", error);
    throw new Error("Unable to verify break-glass account count.");
  }

  if (count !== 2) {
    throw new Error(
      `Exactly two break-glass accounts are required; found ${count ?? 0}.`
    );
  }
}

async function auditBreakGlassAccount({
  userId,
  created,
  changedAt,
}: {
  userId: string;
  created: boolean;
  changedAt: string;
}) {
  if (created) {
    await saveAuthAuditEvent({
      userId,
      eventType: AUTHENTICATION_EVENT_TYPES.BREAK_GLASS_ACCOUNT_CREATED,
      metadata: {
        source: "break_glass_bootstrap",
        createdAt: changedAt,
      },
    });
  }

  await saveAuthAuditEvent({
    userId,
    eventType: AUTHENTICATION_EVENT_TYPES.BREAK_GLASS_PASSWORD_CHANGED,
    metadata: {
      source: "break_glass_bootstrap",
      changedAt,
    },
  });

  await saveAuthAuditEvent({
    userId,
    eventType: AUTHENTICATION_EVENT_TYPES.BREAK_GLASS_MFA_ENABLED,
    metadata: {
      source: "break_glass_bootstrap",
      enabledAt: changedAt,
    },
  });
}

async function main() {
  const configs = [readConfig(1), readConfig(2)];

  for (const config of configs) {
    validateConfig(config);
  }

  if (configs[0].username === configs[1].username) {
    throw new Error("Break-glass account usernames must be distinct.");
  }

  if (configs[0].email === configs[1].email) {
    throw new Error("Break-glass account emails must be distinct.");
  }

  const superAdminGroupId = await loadSuperAdminGroupId();

  for (const config of configs) {
    const { user, created, changedAt } = await upsertBreakGlassUser(config);

    await ensureSuperAdminMembership(user.id, superAdminGroupId);
    await ensureBreakGlassAccount(config, user.id);
    await ensureTotpFactor(config, user.id);
    await auditBreakGlassAccount({ userId: user.id, created, changedAt });

    console.log(`username: ${user.username}`);
    console.log(`user id: ${user.id}`);
    console.log("success: true");
  }

  await assertExactlyTwoBreakGlassAccounts();
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "Break-glass account bootstrap failed.";

  console.error(message);
  process.exit(1);
});
