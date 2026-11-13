import { ProviderId, StatsProviderId } from "../auth/types";
import { UsageData } from "../accounts/manager";
import fs from "fs";
import {
  StatsAppender,
  listRotatedGenerations,
  replayStatsEvents,
  rotatedStatsPath,
  statsFilePath,
  statsSummaryPath,
  writeFileAtomic,
} from "./storage";

/**
 * Events appended between compactions. At ~70k requests a day this bounds the
 * log to well under a day's worth (~25 MB); the summary holds the rest.
 */
const DEFAULT_COMPACT_EVERY = 50_000;

/** The compacted totals on disk: every view, as of the generation it closes. */
interface StatsSummaryFile {
  v: 1;
  gen: number;
  savedAt: string;
  byClient: Record<string, ClientBucket>;
  byAccount: Record<string, AccountBucket>;
  byApi: Record<string, ApiBucket>;
  byKeyModelDay: Record<string, UsageRow>;
  totals: BaseBucket;
}

/**
 * One row in the JSONL stats log. Keep field names short — the file grows
 * one line per request and disk space matters more than self-documentation
 * here. `version` lets us evolve the schema without a manual migration:
 * loaders are free to skip lines whose version they don't understand.
 */
export interface StatsEvent {
  v: 1;
  ts: string;
  apiKeyHash: string;
  ip: string;
  ua: string;
  endpoint: string;
  model: string | null;
  provider: StatsProviderId | null;
  accountEmail: string | null;
  status: "success" | "failure";
  failureKind: string | null;
  statusCode: number;
  latencyMs: number;
  usage: UsageData | null;
  /** Who sent the request, from the client's X-Relay-Caller header; absent on older lines. */
  caller?: string;
}

/** One caller's totals inside a caller window. */
export interface CallerWindowRow {
  caller: string;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/** Requests per caller between two reads of the window. */
export interface CallerWindow {
  from: string;
  to: string;
  rows: CallerWindowRow[];
}

/** How often the caller window is printed, beside the accounts' own stats lines. */
const CALLER_LOG_INTERVAL_MS = 5 * 60 * 1000;

interface BaseBucket {
  requests: number;
  successes: number;
  failures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  totalLatencyMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ClientBucket extends BaseBucket {
  apiKeyShort: string;
  lastIp: string;
  lastUa: string;
}

export interface AccountBucket extends BaseBucket {
  provider: StatsProviderId;
  email: string;
}

export interface ApiBucket extends BaseBucket {
  endpoint: string;
  model: string;
  provider: StatsProviderId | null;
}

export interface StatsSnapshot {
  byClient: Record<string, ClientBucket>;
  byAccount: Record<string, AccountBucket>;
  byApi: Record<string, ApiBucket>;
  totals: BaseBucket;
}

export interface UsageRow {
  apiKeyHash: string;
  model: string;
  day: string;
  requests: number;
  successes: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  reasoningOutputTokens: number;
}

function emptyBucket(now: string): BaseBucket {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalReasoningOutputTokens: 0,
    totalLatencyMs: 0,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function applyBaseDelta(b: BaseBucket, ev: StatsEvent): void {
  if (b.requests === 0) {
    b.firstSeenAt = ev.ts;
  }
  b.requests++;
  if (ev.status === "success") b.successes++;
  else b.failures++;
  b.totalLatencyMs += ev.latencyMs;
  if (ev.usage) {
    b.totalInputTokens += ev.usage.inputTokens;
    b.totalOutputTokens += ev.usage.outputTokens;
    b.totalCacheCreationInputTokens += ev.usage.cacheCreationInputTokens;
    b.totalCacheReadInputTokens += ev.usage.cacheReadInputTokens;
    b.totalReasoningOutputTokens += ev.usage.reasoningOutputTokens;
  }
  b.lastSeenAt = ev.ts;
}

/**
 * Three independent aggregate views — keyed by client (API key hash),
 * upstream account (provider + email), and API surface (endpoint + model
 * + provider). Each request increments exactly one bucket per view, so
 * memory usage is O(unique clients + unique accounts + unique
 * endpoint*model). No cross-products.
 */
export class StatsRecorder {
  private byClient = new Map<string, ClientBucket>();
  private byAccount = new Map<string, AccountBucket>();
  private byApi = new Map<string, ApiBucket>();
  private byKeyModelDay = new Map<string, UsageRow>();
  private totals: BaseBucket = emptyBucket(new Date().toISOString());

  private appender: StatsAppender | null = null;
  private enabled = false;
  private authDir: string | null = null;
  private gen = 0;
  private sinceCompact = 0;
  private readonly compactEvery: number;
  private pendingClose: Promise<void> = Promise.resolve();
  private callerWindow = new Map<string, CallerWindowRow>();
  private callerWindowFrom = new Date().toISOString();
  private callerLogTimer: NodeJS.Timeout | null = null;

  constructor(options: { compactEvery?: number } = {}) {
    this.compactEvery = options.compactEvery ?? DEFAULT_COMPACT_EVERY;
  }

  /**
   * Rebuild the in-memory aggregate from the summary plus the events logged
   * since it, compact, then open the append stream. Errors are non-fatal —
   * operators can always delete the files to reset, and we'd rather start
   * fresh than fail to boot.
   *
   * Files in `authDir`: `stats.summary.json` (totals through generation G),
   * `stats.jsonl` (events after it) and, only after a crash mid-compaction,
   * `stats.<n>.jsonl`. A rotated log with n > G was never summarised and is
   * replayed; one with n <= G is already in the summary and is deleted.
   */
  start(authDir: string): void {
    this.authDir = authDir;
    const filePath = statsFilePath(authDir);
    try {
      this.loadSummary(authDir);
      for (const g of listRotatedGenerations(authDir)) {
        const rotated = rotatedStatsPath(authDir, g);
        if (g > this.gen) {
          replayStatsEvents(rotated, (ev) => this.applyEvent(ev));
          this.gen = g;
          this.writeSummary(authDir);
        }
        fs.rmSync(rotated, { force: true });
      }
      const result = replayStatsEvents(filePath, (ev) => this.applyEvent(ev));
      if (result.lines > 0) {
        console.log(
          `[stats] replayed ${result.lines} event(s) (${result.skipped} skipped) from ${filePath}`,
        );
      }
    } catch (err: any) {
      console.error("[stats] replay failed:", err?.message);
    }
    this.enabled = true;
    this.compact();
  }

  async stop(): Promise<void> {
    this.enabled = false;
    if (this.callerLogTimer) {
      clearInterval(this.callerLogTimer);
      this.callerLogTimer = null;
    }
    if (this.appender) {
      await this.appender.close();
      this.appender = null;
    }
    await this.pendingClose;
  }

  /**
   * Fold the current log into the summary and start an empty one, so the log
   * never grows past `compactEvery` events. Synchronous from the rotation to
   * the new summary, so no event can land between them; a crash anywhere
   * leaves files that start() resolves without losing or doubling an event.
   */
  compact(): void {
    if (!this.authDir) return;
    const authDir = this.authDir;
    const filePath = statsFilePath(authDir);
    try {
      const next = this.gen + 1;
      const rotated = rotatedStatsPath(authDir, next);
      if (fs.existsSync(filePath)) fs.renameSync(filePath, rotated);
      this.gen = next;
      this.writeSummary(authDir);
      const old = this.appender;
      this.appender = new StatsAppender(filePath);
      this.appender.open();
      this.sinceCompact = 0;
      // The old stream may still flush already-summarised events into the rotated file.
      this.pendingClose = this.pendingClose
        .then(() => old?.close())
        .then(() => fs.rmSync(rotated, { force: true }));
    } catch (err: any) {
      console.error("[stats] compaction failed:", err?.message);
      if (!this.appender) {
        this.appender = new StatsAppender(filePath);
        this.appender.open();
      }
    }
  }

  private loadSummary(authDir: string): void {
    const p = statsSummaryPath(authDir);
    if (!fs.existsSync(p)) return;
    const s = JSON.parse(fs.readFileSync(p, "utf-8")) as StatsSummaryFile;
    if (s.v !== 1) return;
    this.gen = s.gen;
    this.byClient = new Map(Object.entries(s.byClient));
    this.byAccount = new Map(Object.entries(s.byAccount));
    this.byApi = new Map(Object.entries(s.byApi));
    this.byKeyModelDay = new Map(Object.entries(s.byKeyModelDay));
    this.totals = s.totals;
  }

  private writeSummary(authDir: string): void {
    const s: StatsSummaryFile = {
      v: 1,
      gen: this.gen,
      savedAt: new Date().toISOString(),
      byClient: Object.fromEntries(this.byClient),
      byAccount: Object.fromEntries(this.byAccount),
      byApi: Object.fromEntries(this.byApi),
      byKeyModelDay: Object.fromEntries(this.byKeyModelDay),
      totals: this.totals,
    };
    writeFileAtomic(statsSummaryPath(authDir), JSON.stringify(s));
  }

  /** Test-only: record a fully formed event (fixed timestamp) as record() would. */
  applyEventAndAppendForTest(event: StatsEvent): void {
    this.appendEvent(event);
  }

  /** Test-only: wait until every closed stream has flushed and rotated files are gone. */
  async flushForTest(): Promise<void> {
    await this.pendingClose;
  }

  /**
   * Hot path called from the response-finish middleware. Aggregate first
   * (synchronous, cheap), then enqueue an append on the write stream so
   * the request response isn't blocked on fsync.
   */
  record(input: Omit<StatsEvent, "v" | "ts">): void {
    if (!this.enabled) return;
    const event: StatsEvent = {
      v: 1,
      ts: new Date().toISOString(),
      ...input,
    };
    this.appendEvent(event);
  }

  private appendEvent(event: StatsEvent): void {
    if (!this.enabled) return;
    this.applyEvent(event);
    this.addToCallerWindow(event);
    if (this.appender) {
      try {
        this.appender.append(event);
      } catch (err: any) {
        console.error("[stats] append failed:", err?.message);
      }
    }
    this.sinceCompact++;
    if (this.sinceCompact >= this.compactEvery) this.compact();
  }

  /**
   * Live requests only (never the boot replay), so each printed window says who used the relay in
   * that stretch of time. A request with no caller header is named by its key's short hash.
   */
  private addToCallerWindow(ev: StatsEvent): void {
    const caller = ev.caller || `untagged key=${ev.apiKeyHash.slice(0, 12)}`;
    let row = this.callerWindow.get(caller);
    if (!row) {
      row = {
        caller,
        requests: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
      };
      this.callerWindow.set(caller, row);
    }
    row.requests++;
    if (ev.status === "failure") row.failures++;
    if (ev.usage) {
      row.inputTokens += ev.usage.inputTokens;
      row.outputTokens += ev.usage.outputTokens;
      row.cacheReadInputTokens += ev.usage.cacheReadInputTokens;
    }
  }

  /** The callers since the last read, most tokens first, and an empty window after it. */
  takeCallerWindow(): CallerWindow {
    const to = new Date().toISOString();
    const tokens = (r: CallerWindowRow) => r.inputTokens + r.outputTokens;
    const rows = [...this.callerWindow.values()].sort(
      (a, b) => tokens(b) - tokens(a) || b.requests - a.requests,
    );
    const window = { from: this.callerWindowFrom, to, rows };
    this.callerWindow = new Map();
    this.callerWindowFrom = to;
    return window;
  }

  formatCallerWindow(window: CallerWindow): string[] {
    return [
      `\n===== caller stats (${window.from} to ${window.to}) =====`,
      ...(window.rows.length === 0
        ? ["  no requests"]
        : window.rows.map(
            (r) =>
              `  caller=${r.caller}: requests=${r.requests}, failures=${r.failures}, ` +
              `input_tokens=${r.inputTokens}, cache_read=${r.cacheReadInputTokens}, ` +
              `output_tokens=${r.outputTokens}`,
          )),
      `====================================================\n`,
    ];
  }

  /** Prints the caller window on the same five-minute beat as the account stats. */
  startCallerLog(): void {
    const timer = setInterval(() => {
      for (const line of this.formatCallerWindow(this.takeCallerWindow())) {
        console.log(line);
      }
    }, CALLER_LOG_INTERVAL_MS);
    timer.unref();
    this.callerLogTimer = timer;
  }

  getSnapshot(): StatsSnapshot {
    return {
      byClient: Object.fromEntries(this.byClient),
      byAccount: Object.fromEntries(this.byAccount),
      byApi: Object.fromEntries(this.byApi),
      totals: { ...this.totals },
    };
  }

  /**
   * Input + output tokens one key has used on a UTC day (YYYY-MM-DD).
   * `count` limits the sum to the models it accepts (all models when omitted).
   */
  tokensOnDay(
    apiKeyHash: string,
    day: string,
    count?: (model: string) => boolean,
  ): number {
    let total = 0;
    for (const row of this.byKeyModelDay.values()) {
      if (
        row.apiKeyHash === apiKeyHash &&
        row.day === day &&
        (!count || count(row.model))
      ) {
        total += row.inputTokens + row.outputTokens;
      }
    }
    return total;
  }

  /** Per key, model and UTC day usage, optionally from `sinceDay` onward. */
  usageRows(sinceDay?: string): UsageRow[] {
    return Array.from(this.byKeyModelDay.values())
      .filter((r) => !sinceDay || r.day >= sinceDay)
      .map((r) => ({ ...r }));
  }

  /** Reset all in-memory aggregates. Doesn't touch the JSONL on disk. */
  reset(): void {
    this.byClient.clear();
    this.byAccount.clear();
    this.byApi.clear();
    this.byKeyModelDay.clear();
    this.totals = emptyBucket(new Date().toISOString());
  }

  /** Test/replay-only entry point — does NOT touch the disk. */
  applyEvent(ev: StatsEvent): void {
    applyBaseDelta(this.totals, ev);

    const clientKey = ev.apiKeyHash;
    let cb = this.byClient.get(clientKey);
    if (!cb) {
      cb = {
        ...emptyBucket(ev.ts),
        apiKeyShort: ev.apiKeyHash.slice(0, 12),
        lastIp: ev.ip,
        lastUa: ev.ua,
      };
      this.byClient.set(clientKey, cb);
    }
    cb.lastIp = ev.ip || cb.lastIp;
    cb.lastUa = ev.ua || cb.lastUa;
    applyBaseDelta(cb, ev);

    if (ev.provider && ev.accountEmail) {
      const accKey = `${ev.provider}:${ev.accountEmail}`;
      let ab = this.byAccount.get(accKey);
      if (!ab) {
        ab = {
          ...emptyBucket(ev.ts),
          provider: ev.provider,
          email: ev.accountEmail,
        };
        this.byAccount.set(accKey, ab);
      }
      applyBaseDelta(ab, ev);
    }

    const apiModel = ev.model || "unknown";
    const apiProvider = ev.provider || null;
    const apiKey = `${ev.endpoint}|${apiModel}|${apiProvider ?? "unknown"}`;
    let pb = this.byApi.get(apiKey);
    if (!pb) {
      pb = {
        ...emptyBucket(ev.ts),
        endpoint: ev.endpoint,
        model: apiModel,
        provider: apiProvider,
      };
      this.byApi.set(apiKey, pb);
    }
    applyBaseDelta(pb, ev);

    const day = ev.ts.slice(0, 10);
    const usageKey = `${ev.apiKeyHash}|${apiModel}|${day}`;
    let ur = this.byKeyModelDay.get(usageKey);
    if (!ur) {
      ur = {
        apiKeyHash: ev.apiKeyHash,
        model: apiModel,
        day,
        requests: 0,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      this.byKeyModelDay.set(usageKey, ur);
    }
    ur.requests++;
    if (ev.status === "success") ur.successes++;
    else ur.failures++;
    if (ev.usage) {
      ur.inputTokens += ev.usage.inputTokens;
      ur.outputTokens += ev.usage.outputTokens;
      ur.cacheReadInputTokens += ev.usage.cacheReadInputTokens;
      ur.reasoningOutputTokens += ev.usage.reasoningOutputTokens;
    }
  }
}

/**
 * Helpers for handlers to attach upstream-specific context to the per-
 * request stats slot on `res.locals`. The server's finish-middleware
 * reads these at response time. Both helpers no-op if stats is disabled
 * (res.locals.stats unset), so handlers don't need to branch on config.
 */
type ResLike = { locals: { stats?: any } };

export function tagStatsModel(
  res: ResLike,
  model: string,
  provider: ProviderId,
): void {
  if (!res.locals.stats) return;
  res.locals.stats.model = model;
  res.locals.stats.provider = provider;
}

export function tagStatsUsage(res: ResLike, usage: UsageData): void {
  if (!res.locals.stats) return;
  res.locals.stats.usage = usage;
}
