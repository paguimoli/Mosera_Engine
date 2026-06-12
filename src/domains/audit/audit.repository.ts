import type { AuditEvent } from "./audit.types";

export function saveAuditEvent(events: AuditEvent[], event: AuditEvent) {
  return [...events, event];
}

export function saveAuditEvents(events: AuditEvent[], newEvents: AuditEvent[]) {
  return [...events, ...newEvents];
}

export function findAuditEventsByEntity({
  events,
  entityType,
  entityId,
}: {
  events: AuditEvent[];
  entityType: string;
  entityId: string;
}) {
  return events.filter(
    (event) => event.entityType === entityType && event.entityId === entityId
  );
}

export function findAuditEventsByAction(events: AuditEvent[], action: string) {
  return events.filter((event) => event.action === action);
}

export function findAuditEventsByActor({
  events,
  actorId,
}: {
  events: AuditEvent[];
  actorId: string;
}) {
  return events.filter((event) => event.actorId === actorId);
}
