import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import type { ControllerResult } from "@/src/lib/controller/controller.types";
import {
  loginWithPassword,
  logoutSession,
  requestPasswordReset,
  resetPassword,
} from "./auth.service";
import type {
  AuthRequestMetadata,
  LoginSuccessResponse,
  LogoutResponse,
  PasswordResetConfirmResponse,
  PasswordResetRequestResponse,
} from "./auth.types";
import {
  normalizeLoginInput,
  normalizeLogoutInput,
  normalizePasswordResetConfirmInput,
  normalizePasswordResetRequestInput,
  validateSessionMetadata,
} from "./auth.validation";

const INVALID_CREDENTIALS_ERROR = "Invalid username or password.";
const PASSWORD_RESET_MESSAGE =
  "If the account exists, password reset instructions have been generated.";

export async function loginController({
  body,
  metadata,
}: {
  body: unknown;
  metadata?: AuthRequestMetadata;
}): Promise<ControllerResult<LoginSuccessResponse>> {
  const input = normalizeLoginInput(body);

  if (!input) {
    return controllerFailure(INVALID_CREDENTIALS_ERROR);
  }

  const metadataValidation = validateSessionMetadata(metadata);

  if (!metadataValidation.valid) {
    return controllerFailure(INVALID_CREDENTIALS_ERROR);
  }

  try {
    const result = await loginWithPassword({
      input,
      metadata,
    });

    if (!result.success) {
      return controllerFailure(result.error);
    }

    return controllerSuccess(result);
  } catch {
    return controllerFailure(INVALID_CREDENTIALS_ERROR);
  }
}

export async function logoutController({
  body,
}: {
  body: unknown;
}): Promise<ControllerResult<LogoutResponse>> {
  const input = normalizeLogoutInput(body);

  if (!input) {
    return controllerSuccess({ success: true });
  }

  try {
    return controllerSuccess(await logoutSession({ input }));
  } catch {
    return controllerSuccess({ success: true });
  }
}

export async function requestPasswordResetController({
  body,
}: {
  body: unknown;
}): Promise<ControllerResult<PasswordResetRequestResponse>> {
  const input = normalizePasswordResetRequestInput(body);

  if (!input) {
    return controllerSuccess({
      success: true,
      message: PASSWORD_RESET_MESSAGE,
    });
  }

  try {
    return controllerSuccess(await requestPasswordReset({ input }));
  } catch {
    return controllerSuccess({
      success: true,
      message: PASSWORD_RESET_MESSAGE,
    });
  }
}

export async function confirmPasswordResetController({
  body,
}: {
  body: unknown;
}): Promise<ControllerResult<PasswordResetConfirmResponse>> {
  const input = normalizePasswordResetConfirmInput(body);

  if (!input) {
    return controllerFailure("Password reset request is invalid.");
  }

  try {
    const result = await resetPassword({ input });

    if (!result.success) {
      return controllerFailure(result.errors);
    }

    return controllerSuccess(result);
  } catch {
    return controllerFailure("Password reset request is invalid.");
  }
}
