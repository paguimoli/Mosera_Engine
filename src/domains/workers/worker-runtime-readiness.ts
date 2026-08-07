import type { Pool } from "pg";

import {
  createResilientPostgresPool,
  queryWithBoundedReconnect,
} from "@/src/lib/database/resilient-postgres-pool";
import { logger } from "@/src/lib/observability/logger";

type RuntimeStatus = "READY" | "DEGRADED" | "STOPPED";

let pool: Pool | null = null;

function getPool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for durable worker readiness.");
  }

  pool ??= createResilientPostgresPool("compiled-worker-runtime", {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    max: 2,
  });
  return pool;
}

export async function recordCompiledWorkerRuntime({
  componentName,
  status,
  metadata = {},
}: {
  componentName: string;
  status: RuntimeStatus;
  metadata?: Record<string, unknown>;
}) {
  await queryWithBoundedReconnect(
    getPool(),
    componentName,
    `
insert into game_engine.canonical_runtime_components (
  component_name,
  runtime_version,
  runtime_kind,
  status,
  last_seen_at,
  metadata
)
values ($1, $2, 'COMPILED_JAVASCRIPT', $3, now(), $4::jsonb)
on conflict (component_name) do update set
  runtime_version = excluded.runtime_version,
  runtime_kind = excluded.runtime_kind,
  status = excluded.status,
  last_seen_at = excluded.last_seen_at,
  metadata = excluded.metadata
`,
    [
      componentName,
      process.env.RELEASE_VERSION?.trim() || "development",
      status,
      JSON.stringify({
        entrypoint: "compiled-javascript",
        processId: process.pid,
        ...metadata,
      }),
    ]
  );
}

export function startCompiledWorkerHeartbeat({
  componentName,
  metadata = {},
}: {
  componentName: string;
  metadata?: Record<string, unknown>;
}) {
  const intervalMs = Math.max(
    5_000,
    Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) || 30_000
  );
  const heartbeat = setInterval(() => {
    void recordCompiledWorkerRuntime({
      componentName,
      status: "READY",
      metadata,
    }).catch((error) => {
      logger.warn({
        message: "Compiled worker runtime heartbeat will retry on the next interval.",
        metadata: {
          componentName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }, intervalMs);

  return async (status: RuntimeStatus = "STOPPED") => {
    clearInterval(heartbeat);
    await recordCompiledWorkerRuntime({
      componentName,
      status,
      metadata,
    }).catch(() => undefined);
  };
}

export async function closeCompiledWorkerRuntimePool() {
  const activePool = pool;
  pool = null;
  await activePool?.end();
}
