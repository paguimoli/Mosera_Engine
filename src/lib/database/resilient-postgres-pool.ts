import { setTimeout as sleep } from "node:timers/promises";

import {
  Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { logger } from "@/src/lib/observability/logger";

let sharedWorkerPool: Pool | null = null;
let sharedWorkerDatabaseUrl: string | null = null;
let sharedApplicationPool: Pool | null = null;
let sharedApplicationDatabaseUrl: string | null = null;
const sharedPools = new WeakSet<Pool>();

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

export function getBoundedPoolSize(
  environmentName: string,
  fallback: number,
  maximum = 32
) {
  const configured = Number(process.env[environmentName]);
  if (!Number.isInteger(configured) || configured < 1) {
    return fallback;
  }
  return Math.min(configured, maximum);
}

export function createWorkerPostgresPool(
  componentName: string,
  config: PoolConfig
) {
  if (process.env.WORKER_SHARED_POSTGRES_POOL !== "true") {
    return createResilientPostgresPool(componentName, config);
  }

  const databaseUrl = String(config.connectionString ?? "");
  if (!databaseUrl) {
    throw new Error("A connection string is required for the shared worker PostgreSQL pool.");
  }
  if (sharedWorkerPool && sharedWorkerDatabaseUrl !== databaseUrl) {
    throw new Error("One worker process cannot share PostgreSQL pools across database URLs.");
  }

  if (!sharedWorkerPool) {
    sharedWorkerDatabaseUrl = databaseUrl;
    sharedWorkerPool = createResilientPostgresPool("shared-worker-runtime", {
      ...config,
      application_name:
        process.env.DATABASE_APPLICATION_NAME?.trim() ||
        process.env.SERVICE_NAME?.trim() ||
        "mosera-worker",
      max: getBoundedPoolSize("WORKER_DATABASE_POOL_MAX", 2, 24),
    });
    sharedPools.add(sharedWorkerPool);
  }

  return sharedWorkerPool;
}

export async function closeWorkerPostgresPool(pool: Pool | null | undefined) {
  if (pool && !sharedPools.has(pool)) {
    await pool.end();
  }
}

export async function closeSharedWorkerPostgresPool() {
  const pool = sharedWorkerPool;
  sharedWorkerPool = null;
  sharedWorkerDatabaseUrl = null;
  if (pool) {
    sharedPools.delete(pool);
    await pool.end();
  }
}

export function createApplicationPostgresPool(
  componentName: string,
  config: PoolConfig
) {
  const databaseUrl = String(config.connectionString ?? "");
  if (!databaseUrl) {
    throw new Error("A connection string is required for the shared application PostgreSQL pool.");
  }
  if (sharedApplicationPool && sharedApplicationDatabaseUrl !== databaseUrl) {
    throw new Error("One application process cannot share PostgreSQL pools across database URLs.");
  }

  if (!sharedApplicationPool) {
    sharedApplicationDatabaseUrl = databaseUrl;
    sharedApplicationPool = createResilientPostgresPool("shared-application-runtime", {
      ...config,
      application_name:
        process.env.DATABASE_APPLICATION_NAME?.trim() || "mosera-application",
      max: getBoundedPoolSize("APPLICATION_DATABASE_POOL_MAX", 6, 16),
    });
    sharedPools.add(sharedApplicationPool);
  }

  return sharedApplicationPool;
}

export async function closeApplicationPostgresPool(pool: Pool | null | undefined) {
  if (pool && !sharedPools.has(pool)) {
    await pool.end();
  }
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
