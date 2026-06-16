type LogLevel = "info" | "warn" | "error";

type LogInput = {
  message: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

function writeLog(level: LogLevel, input: LogInput) {
  const logEntry = {
    level,
    message: input.message,
    correlationId: input.correlationId ?? null,
    metadata: input.metadata ?? {},
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
