type LogLevel = "info" | "warn" | "error";

type LogInput = {
  message: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|credential|password|secret|token|api[-_]?key|email|phone|ssn|dob|address)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[MAX_DEPTH]";
  }

  if (typeof value === "string") {
    return EMAIL_PATTERN.test(value) ? REDACTED : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, depth + 1),
      ])
    );
  }

  return value;
}

function writeLog(level: LogLevel, input: LogInput) {
  const logEntry = {
    level,
    message: input.message,
    correlationId: input.correlationId ?? null,
    metadata: redactValue(input.metadata ?? {}),
    timestamp: new Date().toISOString(),
  };

  const serialized = JSON.stringify(logEntry);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.info(serialized);
}

export const logger = {
  info(input: LogInput) {
    writeLog("info", input);
  },
  warn(input: LogInput) {
    writeLog("warn", input);
  },
  error(input: LogInput) {
    writeLog("error", input);
  },
};

export function info(input: LogInput) {
  logger.info(input);
}

export function warn(input: LogInput) {
  logger.warn(input);
}

export function error(input: LogInput) {
  logger.error(input);
}
