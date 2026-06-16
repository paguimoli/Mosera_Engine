import type { RetryPolicy } from "./worker.types";

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
};

const BACKOFF_BY_ATTEMPT: Record<number, number> = {
  1: 60 * 1000,
  2: 5 * 60 * 1000,
  3: 15 * 60 * 1000,
  4: 60 * 60 * 1000,
};

export function shouldDeadLetter(attemptCount: number): boolean {
  return attemptCount >= defaultRetryPolicy.maxAttempts;
}

export function calculateNextAttemptAt(
  attemptCount: number,
  now: Date = new Date()
): Date | null {
  if (shouldDeadLetter(attemptCount)) {
    return null;
  }

  const backoffMs = BACKOFF_BY_ATTEMPT[attemptCount] ?? BACKOFF_BY_ATTEMPT[4];

  return new Date(now.getTime() + backoffMs);
}
