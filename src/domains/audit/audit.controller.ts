import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { saveAuditEvent, saveAuditEvents } from "./audit.repository";
import { createAuditEvent, createAuditEvents } from "./audit.service";
import type { AuditEvent, CreateAuditEventInput } from "./audit.types";
import { validateAuditEvent } from "./audit.validation";

export function createAuditEventController({
  input,
  events,
}: {
  input: CreateAuditEventInput;
  events: AuditEvent[];
}) {
  const validation = validateAuditEvent(input);

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const event = createAuditEvent(input);

  return controllerSuccess({
    event,
    events: saveAuditEvent(events, event),
  });
}

export function createAuditEventsController({
  inputs,
  events,
}: {
  inputs: CreateAuditEventInput[];
  events: AuditEvent[];
}) {
  const validationErrors = inputs.flatMap((input) => {
    const validation = validateAuditEvent(input);

    return validation.valid ? [] : validation.errors;
  });

  if (validationErrors.length > 0) {
    return controllerFailure(validationErrors);
  }

  const newEvents = createAuditEvents(inputs);

  return controllerSuccess({
    newEvents,
    events: saveAuditEvents(events, newEvents),
  });
}
