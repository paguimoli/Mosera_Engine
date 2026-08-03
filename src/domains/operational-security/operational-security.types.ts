export type PrivilegedSessionKind = "PRIVILEGED" | "BREAK_GLASS";

export type PrivilegedSessionRecord = {
  privilegedSessionId: string;
  authenticationSessionId: string;
  identityId: string;
  identityClass: string;
  sessionKind: PrivilegedSessionKind;
  mfaEvidenceId: string;
  authorizationCommandId: string | null;
  reason: string;
  ticketReference: string;
  correlationId: string;
  activatedAt: string;
  expiresAt: string;
};

export type OperationalSecurityDecision = {
  validationId: string;
  commandId: string;
  privilegedSessionId: string | null;
  decision: "AUTHORIZED" | "DENIED" | "NOT_REQUIRED_NON_PRODUCTION";
  productionEnforced: boolean;
  mfaVerified: boolean;
  sessionVerified: boolean;
  approvalVerified: boolean;
  separationOfDutiesVerified: boolean;
};
