import { setTimeout as sleep } from "node:timers/promises";

import {
  Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { logger } from "@/src/lib/observability/logger";

const RETRYABLE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryablePostgresError(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const message = errorMessage(error);

  return (
    RETRYABLE_CODES.has(code) ||
    code.startsWith("08") ||
    /connection terminated|connection reset|econnrefused|econnreset|socket closed|database system is starting up|the database system is shutting down|timeout expired/i.test(
      message
    )
  );
}

export function createResilientPostgresPool(
  componentName: string,
  config: PoolConfig
) {
  const pool = new Pool(config);

  pool.on("error", (error) => {
    logger.warn({
      message: "PostgreSQL idle client disconnected; pool will reconnect on demand.",
      metadata: {
        componentName,
        error: errorMessage(error),
      },
    });
  });

  return pool;
}

export async function queryWithBoundedReconnect<
  Row extends QueryResultRow = QueryResultRow,
>(
  pool: Pool,
  componentName: string,
  statement: string,
  values: readonly unknown[] = [],
  options: { maxAttempts?: number; initialBackoffMs?: number } = {}
): Promise<QueryResult<Row>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const initialBackoffMs = Math.max(50, options.initialBackoffMs ?? 250);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await pool.query<Row>(statement, [...values]);
    } catch (error) {
      if (!isRetryablePostgresError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const backoffMs = Math.min(4_000, initialBackoffMs * 2 ** (attempt - 1));
      logger.warn({
        message: "PostgreSQL operation will retry after a transient disconnect.",
        metadata: {
          componentName,
          attempt,
          maxAttempts,
          backoffMs,
          error: errorMessage(error),
        },
      });
      await sleep(backoffMs);
    }
  }

  throw new Error("PostgreSQL reconnect attempts were exhausted.");
}
