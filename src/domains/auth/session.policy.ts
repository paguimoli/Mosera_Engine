import { IDENTITY_CLASSES, SESSION_POLICY } from "./auth.constants";
import type { IdentityClass } from "./auth.types";

export function getSessionDurationSeconds(identityClass: IdentityClass) {
  if (identityClass === IDENTITY_CLASSES.PLATFORM_OPERATOR) {
    return SESSION_POLICY.operatorDurationSeconds;
  }

  if (
    identityClass === IDENTITY_CLASSES.PLAYER ||
    identityClass === IDENTITY_CLASSES.HIERARCHY_PARTICIPANT
  ) {
    return SESSION_POLICY.playerDurationSeconds;
  }

  return SESSION_POLICY.defaultDurationSeconds;
}

export function allowsMultipleActiveSessions(identityClass: IdentityClass) {
  return !SESSION_POLICY.singleActiveSessionIdentityClasses.some(
    (singleSessionIdentityClass) => singleSessionIdentityClass === identityClass
  );
}
