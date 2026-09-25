import type { Request } from "express";
import { extractApiKey, hashApiKey } from "./common";

/**
 * Fixed-window request limiter for the /v1 API surface.
 *
 * Two scopes, decided per request:
 *   - "api_key": the request carries a key from config.api-keys. The bucket
 *     is keyed on that key's hash, so every caller of one deployment shares
 *     exactly one budget no matter which proxy address its request came
 *     through. A valid key is already trusted with the whole upstream
 *     account, so its budget is generous.
 *   - "ip": no key, or an unknown one. The bucket is keyed on the client IP
 *     and keeps the original tight budget, so a caller guessing keys can't
 *     mint a fresh bucket per guess.
 *
 * Behind Fly the socket address is always the Fly proxy, so keying on it put
 * every client into one shared bucket. Fly overwrites `Fly-Client-IP` on
 * every inbound request, so it's the real client address whenever we're
 * running on Fly (FLY_APP_NAME is set by the Fly runtime).
 */

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const API_KEY_RATE_LIMIT_MAX = 600;
export const IP_RATE_LIMIT_MAX = 60;

export type RateLimitScope = "api_key" | "ip";

export interface RateLimitSnapshot {
  window_ms: number;
  limits: Record<RateLimitScope, number>;
  /** Requests rejected with 429 by this limiter since `since`. */
  rejected: number;
  rejected_by_scope: Record<RateLimitScope, number>;
  last_rejected_at: string | null;
  /** Process start: the counter is in-memory and resets on restart. */
  since: string;
}

export function clientIp(req: Request): string {
  if (process.env.FLY_APP_NAME) {
    const flyIp = req.headers["fly-client-ip"];
    if (typeof flyIp === "string" && flyIp.trim()) return flyIp.trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private rejected: Record<RateLimitScope, number> = { api_key: 0, ip: 0 };
  private lastRejectedAt: string | null = null;
  private readonly since = new Date().toISOString();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly validKeys: Set<string>,
    private readonly limits: Record<RateLimitScope, number> = {
      api_key: API_KEY_RATE_LIMIT_MAX,
      ip: IP_RATE_LIMIT_MAX,
    },
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.cleanupTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  /** Returns true when the request may proceed. */
  allow(req: Request): boolean {
    const key = extractApiKey(req.headers);
    const scope: RateLimitScope =
      key && this.validKeys.has(key) ? "api_key" : "ip";
    const bucketKey =
      scope === "api_key" ? `key:${hashApiKey(key)}` : `ip:${clientIp(req)}`;

    const now = this.now();
    const entry = this.buckets.get(bucketKey);
    if (!entry || now > entry.resetAt) {
      this.buckets.set(bucketKey, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    if (entry.count <= this.limits[scope]) return true;

    this.rejected[scope]++;
    this.lastRejectedAt = new Date(now).toISOString();
    return false;
  }

  snapshot(): RateLimitSnapshot {
    return {
      window_ms: this.windowMs,
      limits: { ...this.limits },
      rejected: this.rejected.api_key + this.rejected.ip,
      rejected_by_scope: { ...this.rejected },
      last_rejected_at: this.lastRejectedAt,
      since: this.since,
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, entry] of this.buckets) {
      if (now > entry.resetAt) this.buckets.delete(k);
    }
  }
}
