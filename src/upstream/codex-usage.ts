import { AvailableAccount } from "../accounts/manager";

// The same call the Codex CLI makes to fill its usage/status view:
// openai/codex codex-rs/backend-client/src/client/rate_limit_resets.rs
// (rate_limit_status_url → `{chatgpt_base_url}/wham/usage`), sent with the
// ChatGPT access token as a Bearer plus the `chatgpt-account-id` header
// (codex-rs/model-provider/src/bearer_auth_provider.rs). It is not a
// documented public API, so every caller must treat failure as "unknown".
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 10_000;

// Weekly-limit alerts act at 70% / 85% of a 7-day window, where 1% is about
// 100 minutes of wall clock, so minutes-level freshness is plenty. 5 minutes
// keeps a reading at most ~one interval old (two while a refresh runs), costs
// at most 288 calls/account/day (and none while nobody reads the status
// endpoints), and matches the Codex CLI's own model-list cache TTL.
export const CODEX_USAGE_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface UsageWindow {
  usedPercent: number;
  /** ISO 8601 time the window resets. */
  resetsAt: string;
}

export interface CodexUsage {
  /** ~7-day window, or null if the account reports none. */
  weekly: UsageWindow | null;
  /** ~5-hour window, or null if the account reports none. */
  fiveHour: UsageWindow | null;
}

// The response names windows primary/secondary, but which one is the weekly
// depends on the plan (free reports only a weekly one as primary), so windows
// are told apart by their length, as the CLI does with limit_window_seconds.
function classify(windowSeconds: number): "weekly" | "fiveHour" | null {
  if (windowSeconds >= 6 * 86_400 && windowSeconds <= 8 * 86_400)
    return "weekly";
  if (windowSeconds >= 4 * 3600 && windowSeconds <= 6 * 3600) return "fiveHour";
  return null;
}

function readWindow(
  raw: any,
): { kind: "weekly" | "fiveHour"; window: UsageWindow } | null {
  if (raw === null || raw === undefined) return null;
  const { used_percent, limit_window_seconds, reset_at } = raw;
  if (
    typeof used_percent !== "number" ||
    typeof limit_window_seconds !== "number" ||
    typeof reset_at !== "number" ||
    !Number.isFinite(used_percent) ||
    !Number.isFinite(reset_at)
  ) {
    throw new Error("unexpected rate-limit window shape");
  }
  const kind = classify(limit_window_seconds);
  if (!kind) return null;
  return {
    kind,
    window: {
      usedPercent: used_percent,
      resetsAt: new Date(reset_at * 1000).toISOString(),
    },
  };
}

/** Throws on any failure; the caller decides that means "unknown". */
export async function fetchCodexUsage(
  account: AvailableAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexUsage> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.token.accessToken}`,
    Accept: "application/json",
    "User-Agent": "auth2api/1.0.0",
  };
  if (account.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = account.chatgptAccountId;
  }
  const resp = await fetchImpl(USAGE_URL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`wham/usage returned ${resp.status}`);
  let body: any;
  try {
    body = await resp.json();
  } catch {
    throw new Error("wham/usage returned a non-JSON body");
  }
  const limit = body?.rate_limit;
  if (!limit || typeof limit !== "object") {
    throw new Error("wham/usage body has no rate_limit");
  }
  const usage: CodexUsage = { weekly: null, fiveHour: null };
  for (const raw of [limit.primary_window, limit.secondary_window]) {
    const w = readWindow(raw);
    if (w) usage[w.kind] = w.window;
  }
  return usage;
}
