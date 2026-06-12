import type { AuditEvent, CreateAuditEventInput } from "./audit.types";

export function generateAuditEventId() {
  return `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildAuditEvent(input: CreateAuditEventInput): AuditEvent {
  return {
    id: generateAuditEventId(),
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    oldValue: input.oldValue,
    newValue: input.newValue,
    reasonCode: input.reasonCode || null,
    approvalId: input.approvalId || null,
    metadata: input.metadata,
    createdAt: new Date().toISOString(),
  };
}

export function createAuditEvent(input: CreateAuditEventInput) {
  return buildAuditEvent(input);
}

export function createAuditEvents(inputs: CreateAuditEventInput[]) {
  return inputs.map((input) => createAuditEvent(input));
}

export function sortAuditEventsChronologically(events: AuditEvent[]) {
  return [...events].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export function getAuditTimeline(events: AuditEvent[]) {
  return sortAuditEventsChronologically(events);
}
