/**
 * The go-ahead guard: on a relay shared by agents, CI and people, calls on a
 * guarded key go through only with a go-ahead. A go-ahead is either
 *
 * - a live one for one agent run, set by the operator with an admin call
 *   (agent, expiry, request cap), named by the caller label's `/go:<agent>`; or
 * - a standing one for a known caller (CI, a local dev stack, a system job,
 *   a teammate's own key), matched by key name or caller-label prefix, with a
 *   weekly request cap.
 *
 * Caller labels are set by the client, so this stops callers that forget or
 * skip a go-ahead, not one that forges a label. That is why every standing
 * entry, production's included, carries a weekly cap: a forged label can at
 * most use that entry's week.
 *
 * Anything else is refused with a message saying why and who to ask. Off
 * unless `go-guard.enabled` is true, so one config switch turns it back off.
 *
 * Request counts are saved to a small file (`countsFile`) a few seconds after
 * they change and read back at start, so a restart or deploy keeps them. The
 * first refusal for each go-ahead or standing entry in a period calls
 * `onLimit`, which the server sends to the operator's Slack channel.
 */

import fs from "fs";

export interface GoAhead {
  /** The name in the caller label's `/go:<agent>`. */
  agent: string;
  /** ISO time after which the go-ahead no longer lets calls through. */
  until: string;
  /** Requests this go-ahead lets through in total. */
  cap: number;
}

export interface StandingGoAhead {
  /** Who this is, in plain words, for the admin list and log lines. */
  name: string;
  /** Matches calls on this key name. */
  key?: string;
  /** Matches calls whose caller label starts with this. */
  "caller-prefix"?: string;
  /** Requests allowed per UTC week (Monday start). Every standing entry has one. */
  "weekly-cap": number;
}

export interface GoGuardConfig {
  enabled: boolean;
  /** Key names whose calls need a go-ahead. Other keys pass unless a standing entry caps them. */
  "guarded-keys": string[];
  /** Who to ask, shown in every refusal. */
  "ask-whom": string;
  standing: StandingGoAhead[];
  "go-aheads": GoAhead[];
}

export type GoGuardVerdict =
  | { allow: true; via: string }
  | { allow: false; status: 403 | 429; message: string };

const GO_RE = /\/go:([A-Za-z0-9._-]+)/;

export function goAgentOf(caller: string | undefined): string | undefined {
  return caller?.match(GO_RE)?.[1];
}

export function weekStart(now: number): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function validateGoGuard(raw: unknown): GoGuardConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object") throw new Error("go-guard must be a mapping");
  const r = raw as Record<string, unknown>;
  const list = (v: unknown, where: string): unknown[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error(`go-guard.${where} must be a list`);
    return v;
  };
  const posInt = (v: unknown, where: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      throw new Error(`go-guard.${where} must be a whole number above 0`);
    return v;
  };
  const standing = list(r.standing, "standing").map((s, i) => {
    const e = s as Record<string, unknown>;
    if (typeof e?.name !== "string" || !e.name)
      throw new Error(`go-guard.standing[${i}].name is required`);
    if (typeof e.key !== "string" && typeof e["caller-prefix"] !== "string")
      throw new Error(`go-guard.standing[${i}] needs key or caller-prefix`);
    return {
      name: e.name,
      ...(typeof e.key === "string" && { key: e.key }),
      ...(typeof e["caller-prefix"] === "string" && {
        "caller-prefix": e["caller-prefix"],
      }),
      "weekly-cap": posInt(e["weekly-cap"], `standing[${i}].weekly-cap`),
    } as StandingGoAhead;
  });
  const goAheads = list(r["go-aheads"], "go-aheads").map((g, i) =>
    validateGoAhead(g, `go-aheads[${i}]`),
  );
  return {
    enabled: r.enabled === true,
    "guarded-keys": list(r["guarded-keys"], "guarded-keys").map(String),
    "ask-whom":
      typeof r["ask-whom"] === "string" && r["ask-whom"]
        ? r["ask-whom"]
        : "the relay's operator",
    standing,
    "go-aheads": goAheads,
  };
}

export function validateGoAhead(g: unknown, where = "go-ahead"): GoAhead {
  const e = g as Record<string, unknown>;
  if (typeof e?.agent !== "string" || !/^[A-Za-z0-9._-]+$/.test(e.agent))
    throw new Error(`${where}.agent must be letters, digits, . _ or -`);
  if (typeof e.until !== "string" || Number.isNaN(Date.parse(e.until)))
    throw new Error(`${where}.until must be an ISO time`);
  if (typeof e.cap !== "number" || !Number.isInteger(e.cap) || e.cap < 1)
    throw new Error(`${where}.cap must be a whole number above 0`);
  return { agent: e.agent, until: new Date(e.until).toISOString(), cap: e.cap };
}

interface SavedCounts {
  used: Record<string, number>;
  week: string;
  weekly: Record<string, number>;
}

export class GoGuard {
  private used = new Map<string, number>();
  private weekly = new Map<string, number>();
  private week = "";
  private alerted = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private config: GoGuardConfig,
    private opts: {
      persist?: (c: GoGuardConfig) => void;
      now?: () => number;
      /** Where request counts are kept across restarts. */
      countsFile?: string;
      /** Told once per go-ahead or standing entry per period when a call is refused for its limit. */
      onLimit?: (message: string) => void;
    } = {},
  ) {
    this.loadCounts();
  }

  private loadCounts(): void {
    const file = this.opts.countsFile;
    if (!file || !fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as SavedCounts;
      this.used = new Map(Object.entries(saved.used ?? {}));
      this.week = saved.week ?? "";
      this.weekly = new Map(Object.entries(saved.weekly ?? {}));
    } catch (err) {
      console.error(
        `[go-guard] could not read saved counts from ${file}, starting from zero: ${(err as Error).message}`,
      );
    }
  }

  /** Writes the counts now (normally 5 s after a change, so a crash loses at most those seconds). */
  saveCounts(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const file = this.opts.countsFile;
    if (!file) return;
    const saved: SavedCounts = {
      used: Object.fromEntries(this.used),
      week: this.week,
      weekly: Object.fromEntries(this.weekly),
    };
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error(
        `[go-guard] could not save counts to ${file}: ${(err as Error).message}`,
      );
    }
  }

  private countChanged(): void {
    if (!this.opts.countsFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveCounts(), 5000);
    this.saveTimer.unref?.();
  }

  private limitReached(id: string, message: string): void {
    console.warn(`[go-guard] ${message}`);
    if (this.alerted.has(id)) return;
    this.alerted.add(id);
    this.opts.onLimit?.(message);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Decides one model call; counts it when allowed. */
  check(keyName: string, caller: string | undefined): GoGuardVerdict {
    if (!this.config.enabled) return { allow: true, via: "guard off" };
    const now = this.now();
    const ask = this.config["ask-whom"];

    const agent = goAgentOf(caller);
    if (agent) {
      const go = this.config["go-aheads"].find((g) => g.agent === agent);
      if (go) {
        if (Date.parse(go.until) <= now) {
          return {
            allow: false,
            status: 403,
            message: `The go-ahead for "${agent}" on this shared relay ended at ${go.until}. Ask ${ask} for a new one before sending more.`,
          };
        }
        const n = this.used.get(agent) ?? 0;
        if (n >= go.cap) {
          const message = `"${agent}" used all ${go.cap} requests of its go-ahead on this shared relay. Stop here and ask ${ask} for more.`;
          this.limitReached(`go:${agent}:${go.until}`, message);
          return { allow: false, status: 429, message };
        }
        this.used.set(agent, n + 1);
        this.countChanged();
        return { allow: true, via: `go:${agent}` };
      }
    }

    const standing = this.config.standing.find(
      (s) =>
        s.key === keyName ||
        (s["caller-prefix"] !== undefined &&
          caller?.startsWith(s["caller-prefix"])),
    );
    if (standing) {
      const cap = standing["weekly-cap"];
      const wk = weekStart(now);
      if (wk !== this.week) {
        this.week = wk;
        this.weekly.clear();
      }
      const n = this.weekly.get(standing.name) ?? 0;
      if (n >= cap) {
        const message = `"${standing.name}" reached its ${cap} requests for this week on the shared relay. It starts over on Monday (UTC); ask ${ask} if you need more now.`;
        this.limitReached(`standing:${standing.name}:${wk}`, message);
        return { allow: false, status: 429, message };
      }
      this.weekly.set(standing.name, n + 1);
      this.countChanged();
      return { allow: true, via: standing.name };
    }

    if (!this.config["guarded-keys"].includes(keyName))
      return { allow: true, via: "unguarded key" };

    return {
      allow: false,
      status: 403,
      message: agent
        ? `There is no go-ahead named "${agent}" on this shared relay. Ask ${ask} for one, and send the exact label they give you.`
        : `This shared relay needs a go-ahead for every agent run, and this call had none (caller "${caller ?? "none"}"). Ask ${ask} for a go-ahead with a request cap, then send it in X-Relay-Caller as /go:<name>.`,
    };
  }

  list(): {
    enabled: boolean;
    "guarded-keys": string[];
    "go-aheads": Array<GoAhead & { used: number; live: boolean }>;
    standing: Array<StandingGoAhead & { "used-this-week": number }>;
  } {
    const now = this.now();
    const thisWeek = weekStart(now) === this.week;
    return {
      enabled: this.config.enabled,
      "guarded-keys": this.config["guarded-keys"],
      "go-aheads": this.config["go-aheads"].map((g) => ({
        ...g,
        used: this.used.get(g.agent) ?? 0,
        live: Date.parse(g.until) > now,
      })),
      standing: this.config.standing.map((s) => ({
        ...s,
        "used-this-week": thisWeek ? (this.weekly.get(s.name) ?? 0) : 0,
      })),
    };
  }

  /** Adds or replaces one agent's go-ahead; its count starts over. Drops ended ones. */
  setGoAhead(go: GoAhead): void {
    const now = this.now();
    const next = {
      ...this.config,
      "go-aheads": [
        ...this.config["go-aheads"].filter(
          (g) => g.agent !== go.agent && Date.parse(g.until) > now,
        ),
        go,
      ],
    };
    this.opts.persist?.(next);
    this.config = next;
    this.used.delete(go.agent);
    this.countChanged();
  }

  removeGoAhead(agent: string): boolean {
    const kept = this.config["go-aheads"].filter((g) => g.agent !== agent);
    if (kept.length === this.config["go-aheads"].length) return false;
    const next = { ...this.config, "go-aheads": kept };
    this.opts.persist?.(next);
    this.config = next;
    this.used.delete(agent);
    this.countChanged();
    return true;
  }
}
