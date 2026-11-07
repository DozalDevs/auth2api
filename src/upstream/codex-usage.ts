import { AccountManager } from "../accounts/manager";
import { Config } from "../config";
import { buildCodexUsageRequest } from "./codex-api";

/**
 * Each codex account's own rate-limit windows, as the official CLI's status view
 * reads them (GET chatgpt.com/backend-api/wham/usage; see buildCodexUsageRequest).
 * The endpoint is undocumented, so everything here treats it as optional: any
 * failure or unrecognised shape means "unknown" (null fields), never an error
 * for the relay, and never a retry before the next interval.
 */
export interface CodexUsage {
  weeklyUsedPercent: number | null;
  /** ISO 8601. */
  weeklyResetsAt: string | null;
  fiveHourUsedPercent: number | null;
  fiveHourResetsAt: string | null;
}

export const UNKNOWN_CODEX_USAGE: CodexUsage = {
  weeklyUsedPercent: null,
  weeklyResetsAt: null,
  fiveHourUsedPercent: null,
  fiveHourResetsAt: null,
};

// 5 hours = 18000 s and 7 days = 604800 s upstream. Windows are told apart by
// length, not by primary/secondary slot: plans with a weekly limit only report
// it as primary_window.
const WEEKLY_MIN_SECONDS = 5 * 86_400;
const FIVE_HOUR_MAX_SECONDS = 86_400;

interface Window {
  usedPercent: number;
  resetsAt: string | null;
  seconds: number;
}

function readWindow(w: any): Window | null {
  if (!w || typeof w !== "object") return null;
  const used = w.used_percent;
  const seconds = w.limit_window_seconds;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  let resetsAt: string | null = null;
  if (typeof w.reset_at === "number" && w.reset_at > 0) {
    resetsAt = new Date(w.reset_at * 1000).toISOString();
  }
  return { usedPercent: used, resetsAt, seconds };
}

/** Null when the body is not a usage reply this code understands. */
export function parseCodexUsage(body: unknown): CodexUsage | null {
  const limit = (body as any)?.rate_limit;
  if (!limit || typeof limit !== "object") return null;
  const windows = [limit.primary_window, limit.secondary_window]
    .map(readWindow)
    .filter((w): w is Window => w !== null);
  if (windows.length === 0) return null;
  const weekly = windows.find((w) => w.seconds >= WEEKLY_MIN_SECONDS);
  const fiveHour = windows.find((w) => w.seconds <= FIVE_HOUR_MAX_SECONDS);
  if (!weekly && !fiveHour) return null;
  return {
    weeklyUsedPercent: weekly?.usedPercent ?? null,
    weeklyResetsAt: weekly?.resetsAt ?? null,
    fiveHourUsedPercent: fiveHour?.usedPercent ?? null,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
  };
}

export interface CodexUsageMonitorOptions {
  manager: AccountManager;
  config: Config;
  /** At most one upstream call per account per this long. Default 5 minutes. */
  minIntervalMs?: number;
  /** Per-call cutoff. Default 10 seconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_USAGE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** How often the timer looks for accounts that are due; the interval itself is per account. */
const TICK_MS = 60 * 1000;

/**
 * Keeps each codex account's usage fresh in the account manager, off the request
 * path: nothing a client does waits on it, and the routes only read what is
 * already stored. An attempt (success or not) starts the account's interval, so a
 * broken endpoint is asked once per interval, not in a loop.
 */
export class CodexUsageMonitor {
  private readonly manager: AccountManager;
  private readonly config: Config;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly lastAttempt = new Map<string, number>();
  private pass: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: CodexUsageMonitorOptions) {
    this.manager = opts.manager;
    this.config = opts.config;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_USAGE_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the accounts that are due. Never rejects. */
  tick(): Promise<void> {
    if (!this.pass) {
      this.pass = this.run()
        .catch((err) =>
          console.error(`[codex] usage pass failed: ${err?.message || err}`),
        )
        .finally(() => {
          this.pass = null;
        });
    }
    return this.pass;
  }

  private async run(): Promise<void> {
    for (const account of this.manager.listAccounts()) {
      const email = account.token.email;
      const last = this.lastAttempt.get(email);
      if (last !== undefined && this.now() - last < this.minIntervalMs)
        continue;
      this.lastAttempt.set(email, this.now());
      const usage = await this.fetchOne(account);
      this.manager.setUsage(email, usage, new Date(this.now()).toISOString());
    }
  }

  private async fetchOne(
    account: ReturnType<AccountManager["listAccounts"]>[number],
  ): Promise<CodexUsage | null> {
    const abort = new AbortController();
    const cutoff = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const { url, headers } = buildCodexUsageRequest(account, this.config);
      const doFetch = this.fetchImpl ?? globalThis.fetch;
      const res = await doFetch(url, {
        method: "GET",
        headers,
        signal: abort.signal,
      });
      if (!res.ok) {
        console.log(`[codex] usage read for an account answered ${res.status}`);
        return null;
      }
      return parseCodexUsage(await res.json());
    } catch (err: any) {
      console.log(`[codex] usage read failed: ${err?.name || "error"}`);
      return null;
    } finally {
      clearTimeout(cutoff);
    }
  }
}
