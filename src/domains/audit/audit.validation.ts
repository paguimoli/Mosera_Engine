import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { CreateAuditEventInput } from "./audit.types";

export function validateAuditEvent(input: CreateAuditEventInput) {
  const errors: string[] = [];

  if (!input.entityType) errors.push("Audit entityType is required.");
  if (!input.entityId) errors.push("Audit entityId is required.");
  if (!input.action) errors.push("Audit action is required.");
  if (!input.actorType) errors.push("Audit actorType is required.");
  if (!input.actorId) errors.push("Audit actorId is required.");

  return errors.length > 0 ? invalid(errors) : valid();
}
