import { randomUUID } from "crypto";

const CORRELATION_HEADER_NAMES = [
  "x-correlation-id",
  "x-request-id",
  "traceparent",
];

export function createCorrelationId(): string {
  return randomUUID();
}

export function getOrCreateCorrelationId(request?: Request): string {
  if (!request) {
    return createCorrelationId();
  }

  for (const headerName of CORRELATION_HEADER_NAMES) {
    const headerValue = request.headers.get(headerName)?.trim();

    if (headerValue) {
      return headerValue;
    }
  }

  return createCorrelationId();
}
