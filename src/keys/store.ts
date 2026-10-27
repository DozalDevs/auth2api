import {
  ApiKeyEntry,
  KEY_NAME_RE,
  generateApiKey,
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

  /** Whether `entry` may call `model` (alias-resolved on both sides). */
  allows(entry: ApiKeyEntry, model: string): boolean {
    if (entry.models.includes("*")) return true;
    const want = resolveModel(model);
    return entry.models.some((m) => resolveModel(m) === want);
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
  private commit(next: ApiKeyEntry[]): void {
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
