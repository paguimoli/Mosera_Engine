import {
  PASSWORD_POLICY,
} from "./auth.constants";
import type {
  PasswordPolicyInput,
  PasswordValidationResult,
} from "./password.types";

function includesInsensitive(value: string, fragment?: string | null) {
  const normalizedFragment = fragment?.trim().toLowerCase();

  if (!normalizedFragment) {
    return false;
  }

  return value.toLowerCase().includes(normalizedFragment);
}

function getEmailLocalPart(email?: string | null) {
  const normalizedEmail = email?.trim();

  if (!normalizedEmail) {
    return "";
  }

  return normalizedEmail.split("@")[0] || "";
}

export function validatePasswordPolicy(
  input: PasswordPolicyInput
): PasswordValidationResult {
  const errors: string[] = [];
  const password = input.password;

  if (password.length < PASSWORD_POLICY.minimumLength) {
    errors.push(
      `Password must be at least ${PASSWORD_POLICY.minimumLength} characters.`
    );
  }

  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push("Password must include an uppercase letter.");
  }

  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    errors.push("Password must include a lowercase letter.");
  }

  if (PASSWORD_POLICY.requireNumber && !/\d/.test(password)) {
    errors.push("Password must include a number.");
  }

  if (
    PASSWORD_POLICY.requireSpecialCharacter &&
    !/[^\dA-Za-z]/.test(password)
  ) {
    errors.push("Password must include a special character.");
  }

  if (includesInsensitive(password, input.username)) {
    errors.push("Password must not contain the username.");
  }

  if (includesInsensitive(password, input.email)) {
    errors.push("Password must not contain the email address.");
  }

  if (includesInsensitive(password, getEmailLocalPart(input.email))) {
    errors.push("Password must not contain the email local part.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
