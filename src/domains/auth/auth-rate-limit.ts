export type AuthRateLimitArea =
  | "LOGIN"
  | "PASSWORD_RESET_REQUEST"
  | "PASSWORD_RESET_CONFIRM"
  | "MFA_CHALLENGE_VERIFY"
  | "MFA_TOTP_VERIFY"
  | "OAUTH_TOKEN"
  | "OAUTH_INTROSPECTION";

export type AuthRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
  resetAt: string;
  scope: "IP" | "IDENTIFIER";
};

export type AuthRateLimitStatus = {
  mode: "IN_MEMORY";
  enabled: boolean;
  distributed: false;
  areas: Record<
    AuthRateLimitArea,
    {
      ipLimit: number;
      identifierLimit: number;
      windowSeconds: number;
    }
  >;
  activeBucketCount: number;
  limitation: string;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitConfig = {
  ipLimit: number;
  identifierLimit: number;
  windowSeconds: number;
};

const RATE_LIMITS: Record<AuthRateLimitArea, RateLimitConfig> = {
  LOGIN: {
    ipLimit: 20,
    identifierLimit: 10,
    windowSeconds: 60,
  },
  PASSWORD_RESET_REQUEST: {
    ipLimit: 10,
    identifierLimit: 5,
    windowSeconds: 15 * 60,
  },
  PASSWORD_RESET_CONFIRM: {
    ipLimit: 20,
    identifierLimit: 10,
    windowSeconds: 15 * 60,
  },
  MFA_CHALLENGE_VERIFY: {
    ipLimit: 20,
    identifierLimit: 10,
    windowSeconds: 5 * 60,
  },
  MFA_TOTP_VERIFY: {
    ipLimit: 20,
    identifierLimit: 10,
    windowSeconds: 5 * 60,
  },
  OAUTH_TOKEN: {
    ipLimit: 30,
    identifierLimit: 12,
    windowSeconds: 5 * 60,
  },
  OAUTH_INTROSPECTION: {
    ipLimit: 120,
    identifierLimit: 120,
    windowSeconds: 60,
  },
};

const buckets = new Map<string, RateLimitBucket>();

function nowMs() {
  return Date.now();
}

function normalizeIdentifier(value?: string | null) {
  return value?.trim().toLowerCase() || null;
}

export function getClientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  return (
    forwardedFor?.split(",").at(0)?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function cleanExpiredBuckets(now = nowMs()) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function evaluateBucket({
  key,
  limit,
  windowSeconds,
  scope,
}: {
  key: string;
  limit: number;
  windowSeconds: number;
  scope: AuthRateLimitResult["scope"];
}): AuthRateLimitResult {
  const now = nowMs();
  const existing = buckets.get(key);
  const bucket =
    !existing || existing.resetAt <= now
      ? {
          count: 0,
          resetAt: now + windowSeconds * 1000,
        }
      : existing;

  bucket.count += 1;
  buckets.set(key, bucket);

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket.resetAt - now) / 1000)
  );
  const remaining = Math.max(0, limit - bucket.count);

  return {
    allowed: bucket.count <= limit,
    retryAfterSeconds,
    limit,
    remaining,
    resetAt: new Date(bucket.resetAt).toISOString(),
    scope,
  };
}

export function checkAuthRateLimit({
  area,
  request,
  identifiers = [],
}: {
  area: AuthRateLimitArea;
  request: Request;
  identifiers?: Array<string | null | undefined>;
}): AuthRateLimitResult {
  cleanExpiredBuckets();

  const config = RATE_LIMITS[area];
  const ip = getClientIp(request);
  const ipResult = evaluateBucket({
    key: `${area}:ip:${ip}`,
    limit: config.ipLimit,
    windowSeconds: config.windowSeconds,
    scope: "IP",
  });

  if (!ipResult.allowed) return ipResult;

  for (const identifier of identifiers.map(normalizeIdentifier).filter(Boolean)) {
    const identifierResult = evaluateBucket({
      key: `${area}:identifier:${identifier}`,
      limit: config.identifierLimit,
      windowSeconds: config.windowSeconds,
      scope: "IDENTIFIER",
    });

    if (!identifierResult.allowed) return identifierResult;
  }

  return ipResult;
}

export function getAuthRateLimitStatus(): AuthRateLimitStatus {
  cleanExpiredBuckets();

  return {
    mode: "IN_MEMORY",
    enabled: true,
    distributed: false,
    areas: RATE_LIMITS,
    activeBucketCount: buckets.size,
    limitation:
      "In-memory rate limits protect each Node.js process independently and must be replaced or backed by shared storage before horizontally scaled production deployment.",
  };
}
