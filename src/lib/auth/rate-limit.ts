/**
 * Rate limiting w pamięci procesu (wystarcza przy jednym kontenerze i 5 użytkownikach).
 * Klucz: akcja + identyfikator (IP lub login). Okno przesuwne z prostym licznikiem.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= nowMs) {
    buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
    };
  }
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Testy: czyszczenie stanu między przypadkami. */
export function clearRateLimits(): void {
  buckets.clear();
}

/** Okresowe czyszczenie wygasłych wpisów, żeby mapa nie rosła. */
export function pruneRateLimits(nowMs = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= nowMs) buckets.delete(key);
  }
}

export const LIMITS = {
  login: { limit: 10, windowMs: 5 * 60 * 1000 },
  loginPerAccount: { limit: 5, windowMs: 15 * 60 * 1000 },
  totp: { limit: 10, windowMs: 5 * 60 * 1000 },
  reveal: { limit: 30, windowMs: 5 * 60 * 1000 },
  general: { limit: 300, windowMs: 60 * 1000 },
} as const;
