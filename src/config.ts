import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
  /**
   * Codex (ChatGPT) provider — protocol-required headers, NOT identity faking.
   * Strings live here so upstream flag-name drift can ship as a YAML edit.
   */
  codex?: {
    "user-agent"?: string;
    originator?: string;
    "cli-version"?: string;
    /** Optional: only set if upstream begins requiring an OpenAI-Beta header. */
    "openai-beta"?: string;
  };
  /**
   * Cursor provider — reverse-engineered, unstable headers for personal local
   * experiments only. Cursor version-gates requests, so keep these overrideable.
   */
  cursor?: {
    "client-version"?: string;
    "client-type"?: string;
    "agent-base-url"?: string;
    "api-base-url"?: string;
    "config-version"?: string;
    timezone?: string;
    "ghost-mode"?: string;
  };
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export interface StatsConfig {
  /** Default true. Set false to disable per-request stats recording entirely. */
  enabled: boolean;
}

export type DebugMode = "off" | "errors" | "verbose";

/**
 * One client credential. `name` is the human label every usage report uses.
 * `models` is a required allowlist (`["*"]` = any model), matched against the
 * alias-resolved model name. `daily-token-limit` caps input+output tokens per
 * UTC day (soft: in-flight requests can overshoot it). `admin` unlocks /admin/*.
 */
export interface ApiKeyEntry {
  name: string;
  key: string;
  models: string[];
  "daily-token-limit"?: number;
  disabled?: boolean;
  admin?: boolean;
}

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": ApiKeyEntry[];
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  stats: StatsConfig;
  debug: DebugMode;
}

const DEFAULT_RAW: Config = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  stats: {
    enabled: true,
  },
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export const KEY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

/** Validates one api-keys entry; throws with a message naming the problem. */
export function validateApiKeyEntry(e: unknown, where: string): ApiKeyEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    throw new Error(
      `${where}: api-keys entries must be objects {name, key, models}, not plain strings`,
    );
  }
  const o = e as Record<string, unknown>;
  if (typeof o.name !== "string" || !KEY_NAME_RE.test(o.name)) {
    throw new Error(`${where}: name must match ${KEY_NAME_RE}`);
  }
  if (typeof o.key !== "string" || o.key.length < 16) {
    throw new Error(`${where}: key must be a string of at least 16 characters`);
  }
  if (
    !Array.isArray(o.models) ||
    o.models.length === 0 ||
    o.models.some((m) => typeof m !== "string" || !m)
  ) {
    throw new Error(
      `${where}: models must be a non-empty list of model names (use ["*"] for any)`,
    );
  }
  const limit = o["daily-token-limit"];
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
  ) {
    throw new Error(`${where}: daily-token-limit must be a positive integer`);
  }
  for (const flag of ["disabled", "admin"]) {
    if (o[flag] !== undefined && typeof o[flag] !== "boolean") {
      throw new Error(`${where}: ${flag} must be true or false`);
    }
  }
  const entry: ApiKeyEntry = {
    name: o.name,
    key: o.key,
    models: o.models as string[],
  };
  if (limit !== undefined) entry["daily-token-limit"] = limit as number;
  if (o.disabled === true) entry.disabled = true;
  if (o.admin === true) entry.admin = true;
  return entry;
}

export function validateApiKeys(list: unknown): ApiKeyEntry[] {
  if (!Array.isArray(list)) throw new Error("api-keys must be a list");
  const entries = list.map((e, i) => validateApiKeyEntry(e, `api-keys[${i}]`));
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (names.has(n)) throw new Error(`api-keys: duplicate name "${e.name}"`);
    if (keys.has(e.key))
      throw new Error(`api-keys: duplicate key for "${e.name}"`);
    names.add(n);
    keys.add(e.key);
  }
  return entries;
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: Config;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<Config>;
    raw = {
      ...DEFAULT_RAW,
      ...parsed,
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
      stats: { ...DEFAULT_RAW.stats, ...(parsed.stats || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);

  // Auto-generate an admin key if none configured
  if (!raw["api-keys"] || raw["api-keys"].length === 0) {
    const key = generateApiKey();
    raw["api-keys"] = [{ name: "admin", key, models: ["*"], admin: true }];
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  raw["api-keys"] = validateApiKeys(raw["api-keys"]);
  if (
    !raw.stats.enabled &&
    raw["api-keys"].some((k) => k["daily-token-limit"] !== undefined)
  ) {
    throw new Error(
      "api-keys: daily-token-limit needs stats.enabled (usage is read from the stats log)",
    );
  }
  return raw;
}

export function persistApiKeys(
  filePath: string,
): (entries: ApiKeyEntry[]) => void {
  return (entries) => {
    const parsed = fs.existsSync(filePath)
      ? (yaml.load(fs.readFileSync(filePath, "utf-8")) as Record<
          string,
          unknown
        >)
      : {};
    parsed["api-keys"] = entries;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, yaml.dump(parsed, { lineWidth: -1 }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, filePath);
  };
}
