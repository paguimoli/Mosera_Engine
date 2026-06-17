export type RedisConfig = {
  connectionUrl?: string;
};

export function getRedisConfig(): RedisConfig {
  return {
    connectionUrl: process.env.REDIS_URL?.trim() || undefined,
  };
}
