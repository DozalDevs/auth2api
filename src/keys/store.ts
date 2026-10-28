import crypto from "crypto";
import {
  ApiKeyEntry,
  KEY_NAME_RE,
  KeyGrant,
  generateApiKey,
  isValidModelId,
  validateApiKeyEntry,
} from "../config";
import { resolveModel } from "../upstream/translator";

/** A request the caller can fix; `status` is the HTTP status to answer with. */
export class KeyStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface KeyPatch {
  models?: string[];
  /** `null` removes the cap. */
  "daily-token-limit"?: number | null;
  disabled?: boolean;
}

export interface KeyStoreOptions {
  statsEnabled: boolean;
  /** Writes the full key list to disk; throwing aborts the change. */
  persist?: (entries: ApiKeyEntry[]) => void;
  /** Clock in ms since the epoch; tests replace it. */
  now?: () => number;
}

export const MIN_GRANT_MINUTES = 1;
export const MAX_GRANT_MINUTES = 7 * 24 * 60;
/** How long an ended grant is remembered, so errors can say it just ended. */
export const EXPIRED_GRANT_KEEP_MS = 24 * 60 * 60 * 1000;

export interface GrantInput {
  models: string[];
  minutes: number;
  note?: string;
}

/**
 * The live set of client keys. Holds the only copy the server reads, so an
 * admin change takes effect on the next request without a restart.
 */
export class KeyStore {
  private entries: ApiKeyEntry[];
  private byKey = new Map<string, ApiKeyEntry>();

  constructor(
    entries: ApiKeyEntry[],
    private readonly opts: KeyStoreOptions,
  ) {
    this.entries = entries.map((e) => ({ ...e, models: [...e.models] }));
    this.reindex();
  }

  private reindex(): void {
    this.byKey = new Map(this.entries.map((e) => [e.key, e]));
  }

  authenticate(key: string): ApiKeyEntry | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  list(): ApiKeyEntry[] {
    return this.entries.slice();
  }

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Grants that are still in force, soonest to end first. */
  activeGrants(entry: ApiKeyEntry, at = this.now()): KeyGrant[] {
    return (entry.grants ?? [])
      .filter((g) => Date.parse(g.until) > at)
      .sort((a, b) => Date.parse(a.until) - Date.parse(b.until));
  }

  /** Grants that ended in the last day, newest first. */
  endedGrants(entry: ApiKeyEntry, at = this.now()): KeyGrant[] {
    return (entry.grants ?? [])
      .filter((g) => {
        const end = Date.parse(g.until);
        return end <= at && at - end <= EXPIRED_GRANT_KEEP_MS;
      })
      .sort((a, b) => Date.parse(b.until) - Date.parse(a.until));
  }

  /** The most recent just-ended grant that covered `model`, if any. */
  endedGrantFor(
    entry: ApiKeyEntry,
    model: string,
    at = this.now(),
  ): KeyGrant | undefined {
    const want = resolveModel(model);
    return this.endedGrants(entry, at).find((g) =>
      g.models.some((m) => resolveModel(m) === want),
    );
  }

  /** Whether `entry` may call `model` now (alias-resolved on both sides). */
  allows(entry: ApiKeyEntry, model: string, at = this.now()): boolean {
    if (entry.models.includes("*")) return true;
    const want = resolveModel(model);
    const covers = (m: string) => resolveModel(m) === want;
    return (
      entry.models.some(covers) ||
      this.activeGrants(entry, at).some((g) => g.models.some(covers))
    );
  }

  /** Every model id the key may call now, without the "*" wildcard. */
  allowedIds(entry: ApiKeyEntry, at = this.now()): string[] {
    const ids = new Set(entry.models.filter((m) => m !== "*"));
    for (const g of this.activeGrants(entry, at))
      g.models.forEach((m) => ids.add(m));
    return [...ids];
  }

  grant(
    name: string,
    input: GrantInput,
    by: string,
  ): { entry: ApiKeyEntry; grant: KeyGrant } {
    const current = this.find(name);
    if (!current) throw new KeyStoreError(404, `no key named "${name}"`);
    const { models, minutes } = input;
    if (
      !Array.isArray(models) ||
      models.length === 0 ||
      models.length > 50 ||
      !models.every(isValidModelId)
    ) {
      throw new KeyStoreError(
        400,
        'models must be a list of 1 to 50 model names (the "*" wildcard is not allowed in a grant)',
      );
    }
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < MIN_GRANT_MINUTES ||
      minutes > MAX_GRANT_MINUTES
    ) {
      throw new KeyStoreError(
        400,
        `duration must be a whole number of minutes from ${MIN_GRANT_MINUTES} to ${MAX_GRANT_MINUTES} (7 days)`,
      );
    }
    if (
      input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length > 200)
    ) {
      throw new KeyStoreError(
        400,
        "note must be text of at most 200 characters",
      );
    }
    const at = this.now();
    const grant: KeyGrant = {
      id: crypto.randomBytes(4).toString("hex"),
      models: [...new Set(models)],
      until: new Date(at + minutes * 60_000).toISOString(),
      "granted-at": new Date(at).toISOString(),
    };
    if (input.note?.trim()) grant.note = input.note.trim();
    const entry = this.validated({
      ...current,
      grants: [...(current.grants ?? []), grant],
    });
    this.commit(this.entries.map((e) => (e === current ? entry : e)));
    console.log(
      `[grant] ${by} gave "${entry.name}" ${grant.models.join(", ")} until ${grant.until}${grant.note ? ` (${grant.note})` : ""}`,
    );
    return { entry, grant };
  }

  revokeGrant(name: string, grantId: string, by: string): ApiKeyEntry {
    const current = this.find(name);
    if (!current) throw new KeyStoreError(404, `no key named "${name}"`);
    const grants = current.grants ?? [];
    const target = grants.find((g) => g.id === grantId);
    if (!target)
      throw new KeyStoreError(404, `no grant "${grantId}" on "${name}"`);
    const rest = grants.filter((g) => g !== target);
    const next: Record<string, unknown> = { ...current };
    if (rest.length) next.grants = rest;
    else delete next.grants;
    const entry = this.validated(next);
    this.commit(this.entries.map((e) => (e === current ? entry : e)));
    console.log(
      `[grant] ${by} revoked ${target.models.join(", ")} from "${entry.name}"`,
    );
    return entry;
  }

  create(input: {
    name: string;
    models: string[];
    "daily-token-limit"?: number;
    admin?: boolean;
  }): ApiKeyEntry {
    if (typeof input.name === "string" && !KEY_NAME_RE.test(input.name)) {
      throw new KeyStoreError(400, `name must match ${KEY_NAME_RE}`);
    }
    const entry = this.validated({ ...input, key: generateApiKey() });
    if (this.find(entry.name)) {
      throw new KeyStoreError(
        409,
        `a key named "${entry.name}" already exists`,
      );
    }
    this.commit([...this.entries, entry]);
    return entry;
  }

  update(name: string, patch: KeyPatch): ApiKeyEntry {
    const current = this.find(name);
    if (!current) throw new KeyStoreError(404, `no key named "${name}"`);
    const next: Record<string, unknown> = { ...current };
    if (patch.models !== undefined) next.models = patch.models;
    if (patch["daily-token-limit"] === null) delete next["daily-token-limit"];
    else if (patch["daily-token-limit"] !== undefined) {
      next["daily-token-limit"] = patch["daily-token-limit"];
    }
    if (patch.disabled !== undefined) next.disabled = patch.disabled;
    const entry = this.validated(next);
    this.commit(this.entries.map((e) => (e === current ? entry : e)));
    return entry;
  }

  remove(name: string): void {
    const current = this.find(name);
    if (!current) throw new KeyStoreError(404, `no key named "${name}"`);
    this.commit(this.entries.filter((e) => e !== current));
  }

  private find(name: string): ApiKeyEntry | undefined {
    const n = name.toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === n);
  }

  private validated(raw: unknown): ApiKeyEntry {
    try {
      const entry = validateApiKeyEntry(raw, "key");
      if (entry["daily-token-limit"] !== undefined && !this.opts.statsEnabled) {
        throw new Error("daily-token-limit needs stats.enabled");
      }
      return entry;
    } catch (err: any) {
      throw new KeyStoreError(400, err.message);
    }
  }

  /** Persist first, then swap, so a failed write leaves the live set intact. */
  private withoutOldGrants(entries: ApiKeyEntry[]): ApiKeyEntry[] {
    const at = this.now();
    return entries.map((e) => {
      const kept = (e.grants ?? []).filter(
        (g) => at - Date.parse(g.until) <= EXPIRED_GRANT_KEEP_MS,
      );
      if (kept.length === (e.grants ?? []).length) return e;
      const copy: ApiKeyEntry = { ...e };
      if (kept.length) copy.grants = kept;
      else delete copy.grants;
      return copy;
    });
  }

  private commit(proposed: ApiKeyEntry[]): void {
    const next = this.withoutOldGrants(proposed);
    if (!next.some((e) => e.admin && !e.disabled)) {
      throw new KeyStoreError(
        409,
        "that would leave no enabled admin key; the relay would be unmanageable",
      );
    }
    try {
      this.opts.persist?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.entries = next;
    this.reindex();
  }
}
