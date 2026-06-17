import { Socket } from "net";

import { getRedisConfig } from "./redis.config";

const REDIS_PING_COMMAND = "*1\r\n$4\r\nPING\r\n";

export class RedisClientError extends Error {
  constructor(message = "Redis operation failed.") {
    super(message);
    this.name = "RedisClientError";
  }
}

function getRedisConnectionUrl(): URL {
  const { connectionUrl } = getRedisConfig();

  if (!connectionUrl) {
    throw new RedisClientError("Redis connection URL is not configured.");
  }

  return new URL(connectionUrl);
}

function getRedisPort(url: URL): number {
  return url.port ? Number(url.port) : 6379;
}

export async function pingRedis(timeoutMs = 2000): Promise<"PONG"> {
  const url = getRedisConnectionUrl();

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    function settle(error?: Error) {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve("PONG");
    }

    socket.setTimeout(timeoutMs);

    socket.once("error", (error) => {
      settle(new RedisClientError(error.message));
    });

    socket.once("timeout", () => {
      settle(new RedisClientError("Redis ping timed out."));
    });

    socket.on("data", (data) => {
      const response = data.toString();

      if (response.startsWith("+PONG")) {
        settle();
        return;
      }

      settle(new RedisClientError("Unexpected Redis ping response."));
    });

    socket.connect(getRedisPort(url), url.hostname, () => {
      socket.write(REDIS_PING_COMMAND);
    });
  });
}
